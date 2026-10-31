import { it, expect, vi, beforeEach } from 'vitest'
const fake = vi.hoisted(() => ({
  exec: vi.fn(),
  models: vi.fn(),
  close: vi.fn(),
  query: vi.fn(),
  spawn: vi.fn(),
}))
vi.mock('node:child_process', () => ({ execFile: fake.exec, spawn: fake.spawn }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: fake.query }))
import {
  officialStatus,
  officialModels,
  verifyAccount,
  assertAccount,
  billingConflicts,
  profileEnvironment,
} from '../src/auth/official.js'
import { StateStore } from '../src/storage/store.js'
import { RouteBlocked } from '../src/routing/types.js'
import { describeError, describeFailureDetail } from '../src/failure-evidence.js'
import { publicFailureMessage } from '../src/errors.js'
import type { Account } from '../src/routing/types.js'
const status = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  orgId: 'fixture-org',
}
beforeEach(() => {
  vi.clearAllMocks()
  fake.exec.mockImplementation((_cmd, _args, _opts, cb) =>
    cb(null, { stdout: JSON.stringify(status) }),
  )
  fake.models.mockResolvedValue([
    { value: 'default' },
    {
      value: 'opus',
      displayName: 'Opus 5.5',
      description: 'For complex work',
      supportedEffortLevels: ['low', 'max'],
    },
    { value: 'haiku' },
  ])
  fake.query.mockImplementation(() => ({ supportedModels: fake.models, close: fake.close }))
})
it('isolates profile environment and rejects billing conflicts without leaking values', () => {
  expect(
    billingConflicts({
      ANTHROPIC_API_KEY: 'secret',
      CLAUDE_CODE_USE_BEDROCK: '0',
      OTHER: 'secret',
    }),
  ).toEqual(['ANTHROPIC_API_KEY'])
  expect(
    profileEnvironment('/tmp/profile', { PATH: '/bin', HOME: '/tmp', ANTHROPIC_API_KEY: 'secret' }),
  ).toEqual({ PATH: '/bin', HOME: '/tmp', CLAUDE_CONFIG_DIR: '/tmp/profile' })
  expect(() => profileEnvironment('relative')).toThrow('PROFILE_MUST_BE_ABSOLUTE')
})
it('validates official subscription status and stable identity', async () => {
  expect(await officialStatus('claude', 'default')).toEqual(status)
  expect(fake.exec).toHaveBeenCalledWith(
    'claude',
    ['auth', 'status'],
    expect.objectContaining({ timeout: 45_000, killSignal: 'SIGKILL', maxBuffer: 65536 }),
    expect.any(Function),
  )
  for (const [reply, code] of [
    [{ ...status, loggedIn: false }, 'SUBSCRIPTION_LOGIN_REQUIRED'],
    [{ ...status, authMethod: 'api_key' }, 'SUBSCRIPTION_AUTH_REQUIRED'],
    [{ ...status, orgId: undefined }, 'STABLE_SUBSCRIPTION_IDENTITY_UNAVAILABLE'],
  ] as const) {
    fake.exec.mockImplementation((_c, _a, _o, cb) => cb(null, { stdout: JSON.stringify(reply) }))
    await expect(officialStatus('claude', 'default')).rejects.toThrow(code)
  }
  fake.exec.mockImplementation((_c, _a, _o, cb) => cb(new Error('secret')))
  await expect(officialStatus('claude', 'default')).rejects.toThrow('AUTH_STATUS_COMMAND_FAILED')
  vi.stubEnv('ANTHROPIC_API_KEY', 'private')
  try {
    await expect(officialStatus('claude', 'default')).rejects.toThrow('BILLING_ENV_CONFLICT')
  } finally {
    vi.unstubAllEnvs()
  }
})
const execFailure = (fields: Record<string, unknown>) =>
  Object.assign(new Error(`Command failed: claude auth status\n${secretStderr}`), {
    stdout: '',
    stderr: secretStderr,
    ...fields,
  })
const secretStderr = '    at leak (/home/secret/token.js:1:1)'
it.each([
  [
    'a timeout',
    execFailure({ code: null, killed: true, signal: 'SIGTERM' }),
    'AUTH_STATUS_TIMEOUT',
    { startedAt: 31_000, elapsedMs: 15000, signal: 'SIGTERM', stderrBytes: 39 },
  ],
  [
    'a non-zero exit',
    execFailure({ code: 3, killed: false, signal: null }),
    'AUTH_STATUS_COMMAND_FAILED',
    { startedAt: 1_000, elapsedMs: 15000, exitCode: 3, stderrBytes: 39 },
  ],
  [
    'a SIGTERM the provider did not send',
    execFailure({ code: null, killed: false, signal: 'SIGTERM' }),
    'AUTH_STATUS_COMMAND_FAILED',
    { startedAt: 1_000, elapsedMs: 15000, signal: 'SIGTERM', stderrBytes: 39 },
  ],
  [
    'a launch failure',
    Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT', stdout: '', stderr: '' }),
    'AUTH_STATUS_COMMAND_FAILED',
    { startedAt: 1_000, elapsedMs: 15000, stderrBytes: 0 },
  ],
  [
    'an output overflow',
    Object.assign(new RangeError('stdout maxBuffer length exceeded'), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      stdout: '',
      stderr: '',
    }),
    'AUTH_STATUS_COMMAND_FAILED',
    { startedAt: 1_000, elapsedMs: 15000, stderrBytes: 0 },
  ],
])('reports %s of claude auth status with its cause', async (_name, failure, code, detail) => {
  const times = [1_000, 16_000, 31_000, 46_000]
  vi.spyOn(Date, 'now').mockImplementation(() => times.shift() ?? 0)
  fake.exec.mockImplementation((_c, _a, _o, cb) => cb(failure))
  const error = await officialStatus('claude', 'default').catch((e: unknown) => e)
  vi.restoreAllMocks()
  expect(error).toBeInstanceOf(RouteBlocked)
  expect(error).toMatchObject({ code, cause: failure })
  expect(describeFailureDetail(error)).toEqual(detail)
  expect(JSON.stringify([describeError(error), describeFailureDetail(error)])).not.toContain(
    'secret',
  )
})
const commandFailure = (stdout: string, stderr = '') =>
  Object.assign(new Error(`Command failed: claude auth status\n${stderr}`), {
    code: 1,
    killed: false,
    signal: null,
    stdout,
    stderr,
  })
it('treats non-zero auth status JSON as login state instead of a command failure', async () => {
  const secret = 'sk-ant-fixture-secret'
  const loggedOut = commandFailure(JSON.stringify({ loggedIn: false, accessToken: secret }), secret)
  fake.exec.mockImplementation((_c, _a, _o, cb) => cb(loggedOut))
  const loggedOutError = await officialStatus('claude', '/tmp/claude-primary').catch(
    (error: unknown) => error,
  )
  expect(loggedOutError).toMatchObject({
    code: 'SUBSCRIPTION_LOGIN_REQUIRED',
    accountLabel: '/tmp/claude-primary',
  })
  expect(publicFailureMessage(loggedOutError, 'SUBSCRIPTION_LOGIN_REQUIRED')).toBe(
    'SUBSCRIPTION_LOGIN_REQUIRED: /tmp/claude-primary · /claude-login /tmp/claude-primary',
  )
  expect(JSON.stringify(describeError(loggedOutError))).not.toContain(secret)
  expect(publicFailureMessage(loggedOutError, 'SUBSCRIPTION_LOGIN_REQUIRED')).not.toContain(secret)
  expect(fake.exec).toHaveBeenCalledOnce()

  fake.exec.mockImplementation((_c, _a, _o, cb) => cb(commandFailure('not-json', secret)))
  const broken = await officialStatus('claude', 'default').catch((error: unknown) => error)
  expect(broken).toMatchObject({ code: 'AUTH_STATUS_COMMAND_FAILED' })
  expect(JSON.stringify(describeError(broken))).not.toContain(secret)

  fake.exec.mockImplementation((_c, _a, _o, cb) =>
    cb(commandFailure(JSON.stringify(status), secret)),
  )
  await expect(officialStatus('claude', 'default')).resolves.toEqual(status)

  const store = new StateStore(':memory:')
  const account: Account = {
    identity: 'ignored',
    aliases: ['asuhasub'],
    profileRef: '/tmp/claude-asuhasub',
    state: 'READY',
    verifiedAt: 1,
    extraUsageOffConfirmedAt: 1,
    models: {},
    windows: [],
    parallelLimit: 1,
  }
  try {
    fake.exec.mockImplementation((_c, _a, _o, cb) => cb(loggedOut))
    const named = await assertAccount(store, 'claude', account).catch((error: unknown) => error)
    expect(named).toMatchObject({ code: 'SUBSCRIPTION_LOGIN_REQUIRED', accountLabel: 'asuhasub' })
    expect(publicFailureMessage(named, 'SUBSCRIPTION_LOGIN_REQUIRED')).toBe(
      'SUBSCRIPTION_LOGIN_REQUIRED: asuhasub · /claude-login asuhasub',
    )
    expect(publicFailureMessage(named, 'SUBSCRIPTION_LOGIN_REQUIRED')).not.toContain(secret)
    expect(publicFailureMessage(named, 'SUBSCRIPTION_LOGIN_REQUIRED')).not.toContain(
      '/tmp/claude-asuhasub',
    )
  } finally {
    store.close()
  }
})
it('reports auth status output that is not a JSON object with its cause', async () => {
  for (const stdout of ['secret banner', 'null']) {
    fake.exec.mockImplementation((_c, _a, _o, cb) => cb(null, { stdout }))
    const error = await officialStatus('claude', 'default').catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'AUTH_STATUS_INVALID_OUTPUT' })
    expect((error as Error).cause).toBeInstanceOf(Error)
    expect(describeFailureDetail(error)).toMatchObject({ stdoutBytes: stdout.length })
    expect(JSON.stringify(describeError(error))).not.toContain('secret')
  }
})
it('reports a relative profile instead of an unavailable auth status', async () => {
  await expect(officialStatus('claude', 'relative/profile')).rejects.toMatchObject({
    code: 'PROFILE_MUST_BE_ABSOLUTE',
  })
  expect(fake.exec).not.toHaveBeenCalled()
})
it('queries capabilities without enqueueing inference and always closes', async () => {
  expect(await officialModels('claude', 'default')).toHaveLength(3)
  const request = fake.query.mock.calls[0]![0]
  expect(request.options).toMatchObject({
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    persistSession: false,
  })
  expect(fake.close).toHaveBeenCalledOnce()
  fake.models.mockRejectedValue(new Error('control failed'))
  await expect(officialModels('claude', 'default')).rejects.toThrow('control failed')
  expect(fake.close).toHaveBeenCalledTimes(2)
})

it('keeps the capability failure when closing the probe also fails', async () => {
  fake.models.mockRejectedValue(new Error('models failed'))
  fake.close.mockImplementationOnce(() => {
    throw new Error('close failed')
  })
  await expect(officialModels('claude', 'default')).rejects.toThrow('models failed')
})
it('verifies before and after control, retains only profile reference and enforces billing confirmation', async () => {
  const s = new StateStore(':memory:')
  try {
    const a = await verifyAccount(s, 'claude', 'primary', 'default', true)
    expect(a).toMatchObject({ aliases: ['primary'], models: { opus: ['low', 'max'], haiku: [] } })
    expect(a.modelMetadata?.opus).toEqual({
      displayName: 'Opus 5.5',
      description: 'For complex work',
    })
    expect(a.modelMetadata).not.toHaveProperty('default')
    expect(a.identity).not.toContain('fixture-org')
    expect(JSON.stringify(a)).not.toContain('orgId')
    await assertAccount(s, 'claude', a)
    const unconfirmed = await verifyAccount(s, 'claude', 'other', 'default', false)
    await expect(assertAccount(s, 'claude', unconfirmed)).rejects.toThrow(
      'EXTRA_USAGE_OFF_UNCONFIRMED',
    )
    await expect(assertAccount(s, 'claude', { ...a, identity: 'other' })).rejects.toThrow(
      'PROFILE_IDENTITY_CHANGED',
    )
    await expect(verifyAccount(s, 'claude', 'bad name', 'default', true)).rejects.toThrow(
      'INVALID_ALIAS',
    )
    let calls = 0
    fake.exec.mockImplementation((_c, _a, _o, cb) =>
      cb(null, { stdout: JSON.stringify({ ...status, orgId: ++calls === 1 ? 'a' : 'b' }) }),
    )
    await expect(verifyAccount(s, 'claude', 'primary', 'default', true)).rejects.toThrow(
      'IDENTITY_CHANGED',
    )
  } finally {
    s.close()
  }
})
