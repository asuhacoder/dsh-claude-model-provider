import { EventEmitter } from 'node:events'
import { cwd as processCwd } from 'node:process'
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import type SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { SENSITIVE_ENV_PATTERN } from '@deepseek-ai/dsh-subprocess'
import type { ExecutablePolicy, ResolvedConfig } from './index.js'
import { CLAUDE_ERROR_CODES, claudeError, transportError } from './errors.js'

export const MAX_CLAUDE_STDERR_BYTES = 8 * 1_024

const REQUIRED_SDK_ENV = new Set([
  'CLAUDE_AGENT_SDK_CLIENT_APP',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_ENTRYPOINT',
])

/** Non-secret OS identity/home facts Claude needs to locate its authenticated profile. */
export const CLAUDE_RUNTIME_ENV = new Set([
  'APPDATA',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'LOGNAME',
  'USER',
  'USERNAME',
  'CLAUDE_CONFIG_DIR',
  'USERPROFILE',
])

/** Keep only SDK protocol facts and explicitly opted-in non-secret environment values. */
export function filterClaudeEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  passEnv: readonly string[],
): NodeJS.ProcessEnv {
  const optedIn = new Set(passEnv.map((name) => name.toUpperCase()))
  const filtered: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    const folded = name.toUpperCase()
    if (folded.startsWith('DSH_') || SENSITIVE_ENV_PATTERN.test(name)) continue
    if (!REQUIRED_SDK_ENV.has(folded) && !CLAUDE_RUNTIME_ENV.has(folded) && !optedIn.has(folded)) {
      continue
    }
    filtered[name] = value
  }
  return filtered
}

export function sdkEnvironment(passEnv: readonly string[]): NodeJS.ProcessEnv {
  const source: NodeJS.ProcessEnv = {
    CLAUDE_AGENT_SDK_CLIENT_APP: 'dsh-claude-plugin/0.1.0',
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (CLAUDE_RUNTIME_ENV.has(name.toUpperCase())) source[name] = value
  }
  for (const name of passEnv) source[name] = process.env[name]
  return source
}

/** Node-like SDK process facade backed by DSH's tree-owning subprocess handle. */
export class DshSpawnedProcess extends EventEmitter implements SpawnedProcess {
  readonly stdin
  readonly stdout
  #killed = false
  #exitCode: number | null = null
  #signalCode: NodeJS.Signals | null = null
  #settled = false

  constructor(readonly handle: SubprocessHandle) {
    super()
    if (handle.stdin === undefined || handle.stdout === undefined) {
      handle.terminate()
      throw transportError('managed Claude process did not expose required stdin/stdout pipes')
    }
    this.stdin = handle.stdin
    this.stdout = handle.stdout
    void handle.done.then(
      ({ exitCode, signal }) => {
        this.#settled = true
        this.#exitCode = exitCode
        this.#signalCode = signal
        if (signal !== null) this.#killed = true
        this.emit('exit', exitCode, signal)
      },
      (error: unknown) => {
        this.#settled = true
        const normalized =
          error instanceof Error ? error : new Error('managed Claude process failed to spawn')
        if (this.listenerCount('error') > 0) this.emit('error', normalized)
      },
    )
  }

  get killed(): boolean {
    return this.#killed
  }

  get exitCode(): number | null {
    return this.#exitCode
  }

  get signalCode(): NodeJS.Signals | null {
    return this.#signalCode
  }

  kill(_signal: NodeJS.Signals): boolean {
    if (this.#settled || this.#killed) return false
    this.#killed = true
    this.handle.terminate()
    return true
  }
}

function resolutionFailure(command: string, cause: unknown) {
  return claudeError(
    CLAUDE_ERROR_CODES.executableNotFound,
    `could not resolve configured Claude executable ${JSON.stringify(command)}`,
    cause,
  )
}

export async function resolveClaudeExecutable(
  subprocess: SubprocessRuntime,
  command: string,
  policy: ExecutablePolicy,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (policy === 'bundled-only') return undefined
  try {
    return await subprocess.resolveExecutable(command, undefined, signal)
  } catch (error: unknown) {
    if (signal?.aborted === true) throw error
    if (policy === 'host-then-bundled') return undefined
    throw resolutionFailure(command, error)
  }
}

export class ClaudeProcessFactory {
  readonly #active = new Set<DshSpawnedProcess>()

  constructor(
    readonly subprocess: SubprocessRuntime,
    readonly config: ResolvedConfig,
  ) {}

  readonly spawn = (options: SpawnOptions): SpawnedProcess => {
    const handle = this.subprocess.spawn({
      argv: [options.command, ...options.args],
      cwd: options.cwd ?? processCwd(),
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: MAX_CLAUDE_STDERR_BYTES },
      },
      graceMs: this.config.shutdownGraceMs,
      signal: options.signal,
      env: {
        ...Object.fromEntries(Object.keys(globalThis.process.env).map((key) => [key, undefined])),
        ...Object.fromEntries(
          ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']
            .filter((key) => globalThis.process.env[key] !== undefined)
            .map((key) => [key, globalThis.process.env[key]]),
        ),
        ...filterClaudeEnvironment(options.env, this.config.passEnv),
        ...(this.config.profileRef !== 'default'
          ? { CLAUDE_CONFIG_DIR: this.config.profileRef }
          : {}),
      },
    })
    const process = new DshSpawnedProcess(handle)
    this.#active.add(process)
    void handle.done.then(
      () => this.#active.delete(process),
      () => this.#active.delete(process),
    )
    return process
  }

  async dispose(): Promise<void> {
    const active = [...this.#active]
    for (const process of active) process.kill('SIGTERM')
    await Promise.all(
      active.map(async (process) => {
        try {
          await process.handle.waitForExit()
        } catch (error: unknown) {
          throw transportError('managed Claude process cleanup failed', error)
        }
      }),
    )
  }
}
