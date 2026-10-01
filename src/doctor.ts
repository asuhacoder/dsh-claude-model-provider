import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { cwd as processCwd } from 'node:process'
import {
  installedPackageFacts,
  probeClaudeSdk,
  resolveDoctorExecutable,
  runDoctorCommand,
  type DoctorCommandResult,
  type DoctorPackageFacts,
  type DoctorSdkProbeResult,
} from './doctor-runtime.js'

export {
  DOCTOR_REPLY,
  MAX_DOCTOR_OUTPUT_BYTES,
  probeClaudeSdk,
  resolveDoctorExecutable,
  runDoctorCommand,
} from './doctor-runtime.js'
export type {
  DoctorCommandResult,
  DoctorPackageFacts,
  DoctorSdkProbeResult,
} from './doctor-runtime.js'

export const DOCTOR_SCHEMA_VERSION = 1
export const DEFAULT_DOCTOR_TIMEOUT_MS = 20_000
export const MAX_DOCTOR_TIMEOUT_MS = 120_000

export const DOCTOR_LIVE_MODES = ['auto', 'always', 'never'] as const
export const DOCTOR_EXECUTABLE_POLICIES = [
  'host-only',
  'host-then-bundled',
  'bundled-only',
] as const

export type DoctorLiveMode = (typeof DOCTOR_LIVE_MODES)[number]
export type DoctorExecutablePolicy = (typeof DOCTOR_EXECUTABLE_POLICIES)[number]
export type DoctorCheckStatus = 'pass' | 'warn' | 'fail' | 'skip'
export type DoctorOverallStatus = 'pass' | 'warn' | 'fail'

export interface DoctorOptions {
  readonly claudeCommand?: string
  readonly executablePolicy?: DoctorExecutablePolicy
  readonly live?: DoctorLiveMode
  readonly model?: string
  readonly timeoutMs?: number
  readonly cwd?: string
}

export interface ResolvedDoctorOptions {
  readonly claudeCommand: string
  readonly executablePolicy: DoctorExecutablePolicy
  readonly live: DoctorLiveMode
  readonly model: string
  readonly timeoutMs: number
  readonly cwd: string
}

export interface DoctorCheck {
  readonly id: string
  readonly status: DoctorCheckStatus
  readonly summary: string
  readonly details?: Readonly<Record<string, string | number | boolean>>
}

export interface DoctorReport {
  readonly schemaVersion: typeof DOCTOR_SCHEMA_VERSION
  readonly generatedAt: string
  readonly overall: DoctorOverallStatus
  readonly config: Readonly<{
    claudeCommand: string
    executablePolicy: DoctorExecutablePolicy
    live: DoctorLiveMode
    model: string
    timeoutMs: number
  }>
  readonly versions: Readonly<{
    node: string
    plugin: string
    sdk: string
    sdkClaudeCode: string
    runtimeClaudeCode?: string
  }>
  readonly checks: readonly DoctorCheck[]
}

export interface DoctorDependencies {
  readonly resolveExecutable?: (
    command: string,
    environment: NodeJS.ProcessEnv,
  ) => Promise<string | undefined>
  readonly runCommand?: (
    executable: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly timeoutMs: number },
  ) => Promise<DoctorCommandResult>
  readonly probeSdk?: (options: {
    readonly executablePath?: string
    readonly live: boolean
    readonly model: string
    readonly cwd: string
    readonly timeoutMs: number
  }) => Promise<DoctorSdkProbeResult>
  readonly packageFacts?: () => DoctorPackageFacts
  readonly now?: () => Date
  readonly nodeVersion?: string
}

interface ParsedSemver {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: readonly (string | number)[]
}

const require = createRequire(import.meta.url)
const PORTABLE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
const VERSION_PATTERN = /(?:^|\s|\/)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=\s|$|\))/

function parseSemver(value: string): ParsedSemver | undefined {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      value,
    )
  if (match === null) return undefined
  const prerelease =
    match[4] === undefined
      ? []
      : match[4].split('.').map((part) => (/^(0|[1-9]\d*)$/.test(part) ? Number(part) : part))
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 32 || code === 127) return true
  }
  return false
}

function compareSemver(left: ParsedSemver, right: ParsedSemver): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0
    return left.prerelease.length === 0 ? 1 : -1
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (leftPart === undefined || rightPart === undefined) {
      if (leftPart === rightPart) return 0
      return leftPart === undefined ? -1 : 1
    }
    if (leftPart === rightPart) continue
    if (typeof leftPart === 'number' && typeof rightPart === 'number') {
      return leftPart < rightPart ? -1 : 1
    }
    if (typeof leftPart === 'number') return -1
    if (typeof rightPart === 'number') return 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

function comparatorSatisfied(version: ParsedSemver, comparator: string): boolean {
  const match = /^(>=|<=|>|<|=|\^)?(.+)$/.exec(comparator)
  if (match === null || match[2] === undefined) return false
  const target = parseSemver(match[2])
  if (target === undefined) return false
  const comparison = compareSemver(version, target)
  switch (match[1] ?? '=') {
    case '>=':
      return comparison >= 0
    case '<=':
      return comparison <= 0
    case '>':
      return comparison > 0
    case '<':
      return comparison < 0
    case '=':
      return comparison === 0
    case '^': {
      const upper: ParsedSemver =
        target.major > 0
          ? { major: target.major + 1, minor: 0, patch: 0, prerelease: [] }
          : target.minor > 0
            ? { major: 0, minor: target.minor + 1, patch: 0, prerelease: [] }
            : { major: 0, minor: 0, patch: target.patch + 1, prerelease: [] }
      return comparison >= 0 && compareSemver(version, upper) < 0
    }
  }
  return false
}

export function satisfiesVersionRange(value: string, range: string): boolean {
  const version = parseSemver(value)
  if (version === undefined) return false
  return range.split('||').some((alternative) => {
    const comparators = alternative.trim().split(/\s+/).filter(Boolean)
    return (
      comparators.length > 0 && comparators.every((entry) => comparatorSatisfied(version, entry))
    )
  })
}

function validateDoctorOptions(input: DoctorOptions): ResolvedDoctorOptions {
  const claudeCommand = input.claudeCommand ?? 'claude'
  if (
    claudeCommand.length === 0 ||
    claudeCommand !== claudeCommand.trim() ||
    hasControlCharacter(claudeCommand) ||
    (!isAbsolute(claudeCommand) && claudeCommand.includes('/')) ||
    (!isAbsolute(claudeCommand) && claudeCommand.includes('\\'))
  ) {
    throw new Error('claudeCommand must be a bare executable name or absolute path')
  }
  const executablePolicy = input.executablePolicy ?? 'host-only'
  if (!(DOCTOR_EXECUTABLE_POLICIES as readonly string[]).includes(executablePolicy)) {
    throw new Error('executablePolicy is unsupported')
  }
  const live = input.live ?? 'never'
  if (!(DOCTOR_LIVE_MODES as readonly string[]).includes(live)) {
    throw new Error('live mode is unsupported')
  }
  const model = input.model ?? 'sonnet'
  if (!PORTABLE_MODEL.test(model)) throw new Error('model is not a portable Claude model ID')
  const timeoutMs = input.timeoutMs ?? DEFAULT_DOCTOR_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_DOCTOR_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be an integer from 1000 through ${MAX_DOCTOR_TIMEOUT_MS}`)
  }
  const cwd = input.cwd ?? processCwd()
  if (!isAbsolute(cwd) || cwd.includes('\u0000')) throw new Error('cwd must be an absolute path')
  return Object.freeze({ claudeCommand, executablePolicy, live, model, timeoutMs, cwd })
}

function parseClaudeVersion(output: string): string | undefined {
  return VERSION_PATTERN.exec(output.trim())?.[1]
}

interface AuthStatus {
  readonly loggedIn: boolean
  readonly authMethod: string
  readonly apiProvider: string
}

function parseAuthStatus(output: string): AuthStatus | undefined {
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const auth = value as Record<string, unknown>
  if (
    typeof auth.loggedIn !== 'boolean' ||
    typeof auth.authMethod !== 'string' ||
    typeof auth.apiProvider !== 'string' ||
    auth.authMethod.length > 64 ||
    auth.apiProvider.length > 64
  ) {
    return undefined
  }
  return {
    loggedIn: auth.loggedIn,
    authMethod: auth.authMethod,
    apiProvider: auth.apiProvider,
  }
}

function overallStatus(checks: readonly DoctorCheck[]): DoctorOverallStatus {
  if (checks.some((check) => check.status === 'fail')) return 'fail'
  if (checks.some((check) => check.status === 'warn' || check.status === 'skip')) return 'warn'
  return 'pass'
}

function check(
  id: string,
  status: DoctorCheckStatus,
  summary: string,
  details?: Readonly<Record<string, string | number | boolean>>,
): DoctorCheck {
  return Object.freeze({ id, status, summary, ...(details === undefined ? {} : { details }) })
}

function nodeCompatible(version: string): boolean {
  return satisfiesVersionRange(version, '^22.19.0 || >=24.0.0')
}

export async function runDoctor(
  input: DoctorOptions = {},
  dependencies: DoctorDependencies = {},
): Promise<DoctorReport> {
  const options = validateDoctorOptions(input)
  const resolveExecutable = dependencies.resolveExecutable ?? resolveDoctorExecutable
  const runCommand = dependencies.runCommand ?? runDoctorCommand
  const probeSdk = dependencies.probeSdk ?? probeClaudeSdk
  const facts = (dependencies.packageFacts ?? installedPackageFacts)()
  const nodeVersion = dependencies.nodeVersion ?? process.versions.node
  const checks: DoctorCheck[] = []

  checks.push(
    check(
      'runtime.node',
      nodeCompatible(nodeVersion) ? 'pass' : 'fail',
      nodeCompatible(nodeVersion)
        ? `Node ${nodeVersion} satisfies the plugin engine contract`
        : `Node ${nodeVersion} does not satisfy ^22.19.0 || >=24.0.0`,
      { version: nodeVersion },
    ),
  )

  const declaredSdk = (() => {
    try {
      const manifest = require('../package.json') as { dependencies?: Record<string, string> }
      return manifest.dependencies?.['@anthropic-ai/claude-agent-sdk']
    } catch {
      return undefined
    }
  })()
  const sdkCompatible =
    declaredSdk === facts.sdkVersion && parseSemver(facts.sdkVersion) !== undefined
  checks.push(
    check(
      'package.sdk',
      sdkCompatible ? 'pass' : 'fail',
      sdkCompatible
        ? `Claude Agent SDK ${facts.sdkVersion} matches the pinned package contract`
        : 'Installed Claude Agent SDK does not match the package pin',
      {
        installed: facts.sdkVersion,
        declared: declaredSdk ?? 'unavailable',
        claudeCode: facts.sdkClaudeCodeVersion,
      },
    ),
  )

  const peerEntries = Object.entries(facts.peers)
  const incompatiblePeers = peerEntries.filter(
    ([, peer]) => peer.version === undefined || !satisfiesVersionRange(peer.version, peer.range),
  )
  checks.push(
    check(
      'package.dsh-peers',
      incompatiblePeers.length === 0 ? 'pass' : 'fail',
      incompatiblePeers.length === 0
        ? `${peerEntries.length} DSH/Cordis peers satisfy their declared ranges`
        : `${incompatiblePeers.length} required DSH/Cordis peers are missing or incompatible`,
      { checked: peerEntries.length, incompatible: incompatiblePeers.length },
    ),
  )

  let executablePath: string | undefined
  let bundled = options.executablePolicy === 'bundled-only'
  if (!bundled) executablePath = await resolveExecutable(options.claudeCommand, process.env)
  if (bundled) {
    checks.push(
      check('executable.resolve', 'pass', 'Configured to use the SDK-bundled Claude Code', {
        source: 'bundled',
      }),
    )
  } else if (executablePath !== undefined) {
    checks.push(
      check('executable.resolve', 'pass', 'Resolved the configured host Claude executable', {
        source: 'host',
      }),
    )
  } else if (options.executablePolicy === 'host-then-bundled') {
    bundled = true
    checks.push(
      check(
        'executable.resolve',
        'warn',
        'Host Claude executable is absent; the configured bundled fallback will be used',
        { source: 'bundled-fallback' },
      ),
    )
  } else {
    checks.push(
      check('executable.resolve', 'fail', 'Configured host Claude executable was not found'),
    )
  }

  let hostVersion: string | undefined
  let auth: AuthStatus | undefined
  let commandLifecycle = true
  let commandRuns = 0
  if (executablePath !== undefined) {
    const versionResult = await runCommand(executablePath, ['--version'], options)
    commandRuns += 1
    commandLifecycle &&= !versionResult.timedOut && versionResult.signal === null
    hostVersion = parseClaudeVersion(versionResult.stdout)
    if (
      versionResult.exitCode !== 0 ||
      versionResult.timedOut ||
      versionResult.truncated ||
      hostVersion === undefined
    ) {
      checks.push(
        check(
          'executable.version',
          'fail',
          'Claude executable did not return a valid bounded version',
          {
            exitCode: versionResult.exitCode ?? -1,
            timedOut: versionResult.timedOut,
          },
        ),
      )
    } else {
      const parity = hostVersion === facts.sdkClaudeCodeVersion
      checks.push(
        check(
          'executable.version',
          parity ? 'pass' : 'warn',
          parity
            ? `Host Claude Code ${hostVersion} matches the SDK-bundled version`
            : `Host Claude Code ${hostVersion} differs from SDK parity ${facts.sdkClaudeCodeVersion}`,
          { version: hostVersion, sdkParity: facts.sdkClaudeCodeVersion },
        ),
      )
    }

    const authResult = await runCommand(executablePath, ['auth', 'status', '--json'], options)
    commandRuns += 1
    commandLifecycle &&= !authResult.timedOut && authResult.signal === null
    auth = !authResult.truncated ? parseAuthStatus(authResult.stdout) : undefined
    if (auth === undefined || authResult.timedOut) {
      checks.push(
        check('auth.metadata', 'fail', 'Claude auth status did not return valid bounded JSON', {
          exitCode: authResult.exitCode ?? -1,
          timedOut: authResult.timedOut,
        }),
      )
    } else if (!auth.loggedIn) {
      checks.push(
        check('auth.metadata', 'fail', 'Claude Code reports that it is logged out', {
          authMethod: auth.authMethod,
          apiProvider: auth.apiProvider,
        }),
      )
    } else {
      checks.push(
        check('auth.metadata', 'pass', 'Claude Code reports authenticated metadata', {
          authMethod: auth.authMethod,
          apiProvider: auth.apiProvider,
        }),
      )
    }
  } else if (bundled) {
    checks.push(
      check(
        'executable.version',
        'pass',
        `SDK-bundled Claude Code version is ${facts.sdkClaudeCodeVersion}`,
        { version: facts.sdkClaudeCodeVersion },
      ),
      check(
        'auth.metadata',
        'skip',
        'No host CLI is available for a separate auth metadata probe; live generation is authoritative',
      ),
    )
  } else {
    checks.push(
      check('executable.version', 'skip', 'Version probe requires a resolved executable'),
      check('auth.metadata', 'skip', 'Auth metadata probe requires a resolved executable'),
    )
  }

  checks.push(
    check(
      'spawn.lifecycle',
      commandRuns === 0 ? 'skip' : commandLifecycle ? 'pass' : 'fail',
      commandRuns === 0
        ? 'No standalone host CLI metadata subprocess was required'
        : commandLifecycle
          ? 'Bounded CLI metadata subprocesses exited without timeout or signal'
          : 'A CLI metadata subprocess timed out or exited by signal',
    ),
  )

  const canProbe = bundled || executablePath !== undefined
  let sdkVersion = bundled ? facts.sdkClaudeCodeVersion : hostVersion
  if (canProbe) {
    const shouldLive =
      options.live === 'always' || (options.live === 'auto' && (bundled || auth?.loggedIn === true))
    try {
      const probeExecutable = bundled ? undefined : executablePath
      const probe = await probeSdk({
        ...(probeExecutable === undefined ? {} : { executablePath: probeExecutable }),
        live: shouldLive,
        model: options.model,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
      })
      sdkVersion = probe.claudeCodeVersion ?? sdkVersion
      checks.push(
        check(
          'sdk.startup',
          probe.startup ? 'pass' : 'fail',
          probe.startup
            ? 'Claude Agent SDK emitted a valid initialization event'
            : 'Claude Agent SDK did not complete initialization',
          { durationMs: probe.durationMs },
        ),
        check(
          'mcp.handshake',
          probe.mcpConnected && probe.dshOnlyTools ? 'pass' : 'fail',
          probe.mcpConnected && probe.dshOnlyTools
            ? 'The in-process DSH MCP server connected and no native tool was advertised'
            : 'The DSH MCP server was disconnected or a non-DSH tool was advertised',
        ),
      )
      if (!shouldLive) {
        checks.push(
          check(
            'generation.live',
            'skip',
            options.live === 'never'
              ? 'Authenticated generation was explicitly disabled'
              : 'Authenticated generation was skipped because auth metadata is logged out or invalid',
          ),
        )
      } else if (probe.live === 'pass') {
        checks.push(
          check(
            'generation.live',
            'pass',
            `Claude returned the exact diagnostic token through model ${options.model}`,
          ),
        )
      } else {
        const stale = auth?.loggedIn === true && probe.liveFailure === 'authentication'
        checks.push(
          check(
            'generation.live',
            'fail',
            stale
              ? 'Auth metadata says logged in, but live generation rejected authentication; run claude auth login'
              : `Live generation failed (${probe.liveFailure ?? 'unknown'})`,
            {
              failure: probe.liveFailure ?? 'unknown',
              resultSubtype: probe.resultSubtype ?? 'none',
            },
          ),
        )
      }
      checks.push(
        check(
          'process.cleanup',
          probe.cleanup ? 'pass' : 'fail',
          probe.cleanup
            ? 'The SDK diagnostic child exited during bounded cleanup'
            : 'The SDK diagnostic child required forced termination',
        ),
      )
    } catch {
      checks.push(
        check('sdk.startup', 'fail', 'Claude Agent SDK startup threw a diagnostic failure'),
        check('mcp.handshake', 'skip', 'MCP handshake requires SDK startup'),
        check('generation.live', 'skip', 'Live generation requires SDK startup'),
        check('process.cleanup', 'fail', 'SDK process cleanup could not be confirmed'),
      )
    }
  } else {
    checks.push(
      check('sdk.startup', 'skip', 'SDK startup requires an executable route'),
      check('mcp.handshake', 'skip', 'MCP handshake requires SDK startup'),
      check('generation.live', 'skip', 'Live generation requires SDK startup'),
      check('process.cleanup', 'skip', 'No SDK child was started'),
    )
  }

  const generatedAt = (dependencies.now ?? (() => new Date()))().toISOString()
  return Object.freeze({
    schemaVersion: DOCTOR_SCHEMA_VERSION,
    generatedAt,
    overall: overallStatus(checks),
    config: Object.freeze({
      claudeCommand: options.claudeCommand,
      executablePolicy: options.executablePolicy,
      live: options.live,
      model: options.model,
      timeoutMs: options.timeoutMs,
    }),
    versions: Object.freeze({
      node: nodeVersion,
      plugin: facts.pluginVersion,
      sdk: facts.sdkVersion,
      sdkClaudeCode: facts.sdkClaudeCodeVersion,
      ...(sdkVersion === undefined ? {} : { runtimeClaudeCode: sdkVersion }),
    }),
    checks: Object.freeze(checks),
  })
}
