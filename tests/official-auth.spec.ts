import { it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
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
import { officialLogin } from '../src/ui/controller.js'
import { StateStore } from '../src/storage/store.js'
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
    { value: 'opus', supportedEffortLevels: ['low', 'max'] },
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
  for (const [reply, code] of [
    [{ ...status, loggedIn: false }, 'SUBSCRIPTION_AUTH_REQUIRED'],
    [{ ...status, authMethod: 'api_key' }, 'SUBSCRIPTION_AUTH_REQUIRED'],
    [{ ...status, orgId: undefined }, 'STABLE_SUBSCRIPTION_IDENTITY_UNAVAILABLE'],
  ] as const) {
    fake.exec.mockImplementation((_c, _a, _o, cb) => cb(null, { stdout: JSON.stringify(reply) }))
    await expect(officialStatus('claude', 'default')).rejects.toThrow(code)
  }
  fake.exec.mockImplementation((_c, _a, _o, cb) => cb(new Error('secret')))
  await expect(officialStatus('claude', 'default')).rejects.toThrow('AUTH_STATUS_UNAVAILABLE')
  vi.stubEnv('ANTHROPIC_API_KEY', 'private')
  try {
    await expect(officialStatus('claude', 'default')).rejects.toThrow('BILLING_ENV_CONFLICT')
  } finally {
    vi.unstubAllEnvs()
  }
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
it('verifies before and after control, retains only profile reference and enforces billing confirmation', async () => {
  const s = new StateStore(':memory:')
  try {
    const a = await verifyAccount(s, 'claude', 'primary', 'default', true)
    expect(a).toMatchObject({ aliases: ['primary'], models: { opus: ['low', 'max'], haiku: [] } })
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
it('launches only official Claude login and handles cancellation or startup errors', async () => {
  for (const event of ['success', 'exit', 'error']) {
    const child = new EventEmitter()
    fake.spawn.mockReturnValue(child)
    const p = officialLogin('claude', 'default')
    queueMicrotask(() =>
      child.emit(event === 'error' ? 'error' : 'exit', event === 'success' ? 0 : 1),
    )
    if (event === 'success') await p
    else
      await expect(p).rejects.toThrow(event === 'error' ? 'LOGIN_START_FAILED' : 'LOGIN_INCOMPLETE')
  }
  expect(fake.spawn).toHaveBeenCalledWith(
    'claude',
    ['auth', 'login', '--claudeai'],
    expect.objectContaining({ stdio: 'inherit', timeout: 180000 }),
  )
})
