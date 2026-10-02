import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isAbsolute } from 'node:path'
import { query, type ModelInfo } from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue } from '../async-queue.js'
import { type Account, RouteBlocked } from '../routing/types.js'
import { StateStore } from '../storage/store.js'
const execute = promisify(execFile)
const BILLING =
  /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)|ANTHROPIC_FOUNDRY_BASE_URL|CLAUDE_CODE_API_KEY_HELPER)$/i
export function billingConflicts(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter(
    (k) => BILLING.test(k) && env[k] !== undefined && !['', '0', 'false'].includes(env[k]!),
  )
}
export function profileEnvironment(
  profileRef: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (profileRef !== 'default' && !isAbsolute(profileRef))
    throw new RouteBlocked('PROFILE_MUST_BE_ABSOLUTE')
  const result: NodeJS.ProcessEnv = {}
  for (const key of [
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'HOMEDRIVE',
    'HOMEPATH',
    'PATH',
    'SystemRoot',
    'USER',
    'LOGNAME',
    'TMPDIR',
    'TEMP',
    'TMP',
  ])
    if (env[key] !== undefined) result[key] = env[key]
  if (profileRef !== 'default') result.CLAUDE_CONFIG_DIR = profileRef
  return result
}
export interface OfficialStatus {
  loggedIn: boolean
  authMethod?: string
  apiProvider?: string
  orgId?: string
  subscriptionType?: string
}
export async function officialStatus(command: string, profileRef: string): Promise<OfficialStatus> {
  if (billingConflicts(process.env).length) throw new RouteBlocked('BILLING_ENV_CONFLICT')
  let parsed: OfficialStatus
  try {
    const { stdout } = await execute(command, ['auth', 'status'], {
      env: profileEnvironment(profileRef),
      timeout: 15000,
      maxBuffer: 65536,
    })
    parsed = JSON.parse(stdout) as OfficialStatus
  } catch {
    throw new RouteBlocked('AUTH_STATUS_UNAVAILABLE')
  }
  if (!parsed.loggedIn || parsed.authMethod !== 'claude.ai' || parsed.apiProvider !== 'firstParty')
    throw new RouteBlocked('SUBSCRIPTION_AUTH_REQUIRED')
  if (!parsed.orgId) throw new RouteBlocked('STABLE_SUBSCRIPTION_IDENTITY_UNAVAILABLE')
  return parsed
}
export async function officialModels(command: string, profileRef: string): Promise<ModelInfo[]> {
  const input = new AsyncQueue<import('@anthropic-ai/claude-agent-sdk').SDKUserMessage>()
  const q = query({
    prompt: input,
    options: {
      pathToClaudeCodeExecutable: command,
      env: profileEnvironment(profileRef),
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      hooks: {},
      skills: [],
      plugins: [],
      settings: {
        disableAllHooks: true,
        fastMode: false,
        autoMemoryEnabled: false,
        autoCompactEnabled: false,
      },
      systemPrompt: 'DSH control-only capability check.',
      permissionMode: 'dontAsk',
      persistSession: false,
    },
  })
  const timer = setTimeout(() => q.close(), 20000)
  try {
    return await q.supportedModels()
  } finally {
    clearTimeout(timer)
    q.close()
    input.close()
  }
}
export async function verifyAccount(
  store: StateStore,
  command: string,
  alias: string,
  profileRef: string,
  extraUsageOff: boolean,
): Promise<Account> {
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(alias)) throw new RouteBlocked('INVALID_ALIAS')
  const status = await officialStatus(command, profileRef)
  const models = await officialModels(command, profileRef)
  const after = await officialStatus(command, profileRef)
  if (status.orgId !== after.orgId) throw new RouteBlocked('IDENTITY_CHANGED')
  return {
    identity: store.hash('subscription-org:' + status.orgId),
    aliases: [alias],
    profileRef,
    state: 'READY',
    verifiedAt: Date.now(),
    ...(extraUsageOff ? { extraUsageOffConfirmedAt: Date.now() } : {}),
    models: Object.fromEntries(
      models
        .filter((m) => m.value !== 'default')
        .map((m) => [m.value, m.supportedEffortLevels ?? []]),
    ),
    modelMetadata: Object.fromEntries(
      models
        .filter((m) => m.value !== 'default')
        .map((m) => [m.value, { displayName: m.displayName, description: m.description }]),
    ),
    windows: [],
    parallelLimit: 4,
  }
}
export async function assertAccount(
  store: StateStore,
  command: string,
  account: Account,
): Promise<void> {
  if (!account.extraUsageOffConfirmedAt) throw new RouteBlocked('EXTRA_USAGE_OFF_UNCONFIRMED')
  const status = await officialStatus(command, account.profileRef)
  if (store.hash('subscription-org:' + status.orgId) !== account.identity)
    throw new RouteBlocked('PROFILE_IDENTITY_CHANGED')
}
