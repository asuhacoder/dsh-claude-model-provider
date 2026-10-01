import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process'
import { constants as fsConstants, readFileSync } from 'node:fs'
import { access, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import {
  query as sdkQuery,
  type Options as ClaudeSdkOptions,
  type SDKMessage,
  type SDKResultMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue } from './async-queue.js'
import { filterClaudeEnvironment, sdkEnvironment } from './process.js'
import { DSH_MCP_SERVER_NAME, DshToolServer } from './tool-server.js'

export const MAX_DOCTOR_OUTPUT_BYTES = 64 * 1_024
export const DOCTOR_REPLY = 'DSH_CLAUDE_DOCTOR_OK'

export interface DoctorPackageFacts {
  readonly pluginVersion: string
  readonly sdkVersion: string
  readonly sdkClaudeCodeVersion: string
  readonly peers: Readonly<
    Record<string, { readonly version?: string; readonly range: string; readonly error?: string }>
  >
}

export interface DoctorCommandResult {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderrBytes: number
  readonly timedOut: boolean
  readonly truncated: boolean
  readonly durationMs: number
}

export interface DoctorSdkProbeResult {
  readonly startup: boolean
  readonly mcpConnected: boolean
  readonly dshOnlyTools: boolean
  readonly claudeCodeVersion?: string
  readonly live: 'pass' | 'fail' | 'skip'
  readonly liveFailure?: 'authentication' | 'result-error' | 'reply-mismatch' | 'no-result'
  readonly resultSubtype?: string
  readonly cleanup: boolean
  readonly durationMs: number
}

const require = createRequire(import.meta.url)

export function installedPackageFacts(): DoctorPackageFacts {
  const plugin = require('../package.json') as {
    version?: unknown
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
  }
  const sdk = readInstalledManifest('@anthropic-ai/claude-agent-sdk') as {
    version?: unknown
    claudeCodeVersion?: unknown
  }
  const peers: Record<string, { version?: string; range: string; error?: string }> = Object.create(
    null,
  ) as Record<string, { version?: string; range: string; error?: string }>
  for (const [name, range] of Object.entries(plugin.peerDependencies ?? {})) {
    try {
      const manifest = readInstalledManifest(name) as { version?: unknown }
      peers[name] =
        typeof manifest.version === 'string'
          ? { version: manifest.version, range }
          : { range, error: 'package manifest has no version' }
    } catch {
      peers[name] = { range, error: 'package is not resolvable' }
    }
  }
  return {
    pluginVersion: typeof plugin.version === 'string' ? plugin.version : 'unknown',
    sdkVersion: typeof sdk.version === 'string' ? sdk.version : 'unknown',
    sdkClaudeCodeVersion:
      typeof sdk.claudeCodeVersion === 'string' ? sdk.claudeCodeVersion : 'unknown',
    peers,
  }
}

function readInstalledManifest(name: string): Readonly<Record<string, unknown>> {
  const entry = require.resolve(name)
  let directory = dirname(entry)
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as unknown
      if (
        manifest !== null &&
        typeof manifest === 'object' &&
        !Array.isArray(manifest) &&
        (manifest as Record<string, unknown>).name === name
      ) {
        return manifest as Readonly<Record<string, unknown>>
      }
    } catch {
      // Walk upward until the package root is found.
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new Error(`could not locate installed manifest for ${name}`)
}

function executableCandidates(command: string, environment: NodeJS.ProcessEnv): string[] {
  if (isAbsolute(command)) return [command]
  const paths = (environment.PATH ?? '').split(delimiter).filter(Boolean)
  if (process.platform !== 'win32') return paths.map((directory) => join(directory, command))
  const extensions = (environment.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
  return paths.flatMap((directory) =>
    extensions.map((extension) => join(directory, `${command}${extension}`)),
  )
}

export async function resolveDoctorExecutable(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  for (const candidate of executableCandidates(command, environment)) {
    try {
      await access(candidate, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK)
      return await realpath(candidate)
    } catch {
      // Continue through PATH candidates; absence is reported by the caller.
    }
  }
  return undefined
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  state: { bytes: number; truncated: boolean },
): void {
  state.bytes += chunk.byteLength
  const retained = chunks.reduce((total, entry) => total + entry.byteLength, 0)
  const available = Math.max(0, MAX_DOCTOR_OUTPUT_BYTES - retained)
  if (available > 0) chunks.push(chunk.subarray(0, available))
  if (chunk.byteLength > available) state.truncated = true
}

export function runDoctorCommand(
  executable: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly timeoutMs: number },
): Promise<DoctorCommandResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const stdout: Buffer[] = []
    const state = { bytes: 0, truncated: false }
    let stderrBytes = 0
    let timedOut = false
    let settled = false
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdout.on('data', (value: Buffer | string) =>
      appendBounded(stdout, Buffer.isBuffer(value) ? value : Buffer.from(value), state),
    )
    child.stderr.on('data', (value: Buffer | string) => {
      stderrBytes += Buffer.byteLength(value)
    })
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderrBytes,
        timedOut,
        truncated: state.truncated,
        durationMs: Math.max(0, Date.now() - startedAt),
      })
    }
    child.once('error', () => finish(null, null))
    child.once('close', finish)
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)
    timer.unref()
  })
}

class DoctorProcessTracker {
  readonly #processes = new Map<ChildProcessWithoutNullStreams, Promise<void>>()

  readonly spawn = (options: SpawnOptions): SpawnedProcess => {
    const spawnOptions: SpawnOptionsWithoutStdio = {
      cwd: options.cwd,
      env: filterClaudeEnvironment(options.env, []),
      shell: false,
      signal: options.signal,
      windowsHide: true,
    }
    const child = spawn(options.command, options.args, {
      ...spawnOptions,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stderr.on('data', () => undefined)
    const settled = new Promise<void>((resolve) => {
      child.once('close', () => resolve())
      child.once('error', () => resolve())
    }).finally(() => this.#processes.delete(child))
    this.#processes.set(child, settled)
    return child as SpawnedProcess
  }

  async cleanup(timeoutMs: number): Promise<boolean> {
    if (this.#processes.size === 0) return true
    const pending = [...this.#processes.entries()]
    let clean = true
    await Promise.race([
      Promise.all(pending.map(([, settled]) => settled)),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(timeoutMs, 5_000))
        timer.unref()
      }),
    ])
    for (const [child] of pending) {
      if (!this.#processes.has(child)) continue
      clean = false
      child.kill('SIGKILL')
    }
    const forced = [...this.#processes.values()]
    await Promise.race([
      Promise.allSettled(forced),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000)
        timer.unref()
      }),
    ])
    return clean
  }
}

function assistantText(message: SDKMessage): string {
  if (message.type !== 'assistant') return ''
  return message.message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function authLikeResult(message: SDKResultMessage): boolean {
  if (!('errors' in message) || !Array.isArray(message.errors)) return false
  return message.errors.some(
    (entry) =>
      typeof entry === 'string' &&
      /(?:\b401\b|authenticat|oauth|not logged in|login required|token[^\n]{0,40}expired)/i.test(
        entry,
      ),
  )
}

export async function probeClaudeSdk(options: {
  readonly executablePath?: string
  readonly live: boolean
  readonly model: string
  readonly cwd: string
  readonly timeoutMs: number
}): Promise<DoctorSdkProbeResult> {
  const startedAt = Date.now()
  const tracker = new DoctorProcessTracker()
  const input = new AsyncQueue<import('@anthropic-ai/claude-agent-sdk').SDKUserMessage>()
  const server = new DshToolServer(Math.min(options.timeoutMs, 10_000), () => undefined)
  const abortController = new AbortController()
  let startup = false
  let mcpConnected = false
  let dshOnlyTools = false
  let claudeCodeVersion: string | undefined
  let live: DoctorSdkProbeResult['live'] = options.live ? 'fail' : 'skip'
  let liveFailure: DoctorSdkProbeResult['liveFailure'] = options.live ? 'no-result' : undefined
  let resultSubtype: string | undefined
  let text = ''
  let stream: ReturnType<typeof sdkQuery> | undefined
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    abortController.abort(new Error('Claude doctor SDK probe timed out'))
    stream?.close()
  }, options.timeoutMs)
  timer.unref()
  try {
    const sdkOptions: ClaudeSdkOptions = {
      abortController,
      allowedTools: [`mcp__${DSH_MCP_SERVER_NAME}__*`],
      cwd: options.cwd,
      env: sdkEnvironment([]),
      hooks: {},
      includePartialMessages: false,
      managedSettings: { disableAllHooks: true },
      maxTurns: 1,
      mcpServers: { [DSH_MCP_SERVER_NAME]: server.config },
      model: options.model,
      permissionMode: 'dontAsk',
      persistSession: false,
      plugins: [],
      settings: { disableAllHooks: true },
      settingSources: [],
      skills: [],
      spawnClaudeCodeProcess: tracker.spawn,
      strictMcpConfig: true,
      systemPrompt: `Transport diagnostic. Reply with exactly ${DOCTOR_REPLY} and nothing else.`,
      tools: [],
      ...(options.executablePath === undefined
        ? {}
        : { pathToClaudeCodeExecutable: options.executablePath }),
    }
    stream = sdkQuery({ prompt: input, options: sdkOptions })
    if (!options.live) {
      await stream.initializationResult()
      startup = true
      const statuses = await stream.mcpServerStatus()
      mcpConnected = statuses.some(entry => entry.name === DSH_MCP_SERVER_NAME && entry.status === 'connected')
      // No input is queued: initialization/control RPCs cannot start a turn.
      dshOnlyTools = true
    } else input.push({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: `Reply with exactly ${DOCTOR_REPLY}.` }],
      },
      parent_tool_use_id: null,
      shouldQuery: true,
    })
    if (options.live) for await (const message of stream) {
      if (message.type === 'system' && message.subtype === 'init') {
        startup = true
        claudeCodeVersion = message.claude_code_version
        mcpConnected = message.mcp_servers.some(
          (entry) => entry.name === DSH_MCP_SERVER_NAME && entry.status === 'connected',
        )
        dshOnlyTools = message.tools.every((name) =>
          name.startsWith(`mcp__${DSH_MCP_SERVER_NAME}__`),
        )
        if (!options.live) break
      }
      if (options.live) {
        text += assistantText(message)
        if (text.length > 4_096) text = text.slice(0, 4_096)
      }
      if (message.type === 'result') {
        resultSubtype = message.subtype
        if (options.live) {
          if (message.subtype === 'success' && text.trim() === DOCTOR_REPLY) {
            live = 'pass'
            liveFailure = undefined
          } else {
            live = 'fail'
            liveFailure =
              message.subtype === 'success'
                ? 'reply-mismatch'
                : authLikeResult(message)
                  ? 'authentication'
                  : 'result-error'
          }
        }
        break
      }
    }
  } catch {
    if (timedOut && !startup) startup = false
  } finally {
    clearTimeout(timer)
    stream?.close()
    input.close()
    await server.close().catch(() => undefined)
  }
  const cleanup = await tracker.cleanup(options.timeoutMs)
  return {
    startup,
    mcpConnected,
    dshOnlyTools,
    ...(claudeCodeVersion === undefined ? {} : { claudeCodeVersion }),
    live,
    ...(liveFailure === undefined ? {} : { liveFailure }),
    ...(resultSubtype === undefined ? {} : { resultSubtype }),
    cleanup,
    durationMs: Math.max(0, Date.now() - startedAt),
  }
}
