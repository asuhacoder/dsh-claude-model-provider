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
import { RouteBlocked } from '../src/routing/types.js'
import { describeError, describeFailureDetail } from '../src/failure-evidence.js'
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
    { elapsedMs: 15000, signal: 'SIGTERM', stderrBytes: 39 },
  ],
  [
    'a non-zero exit',
    execFailure({ code: 3, killed: false, signal: null }),
    'AUTH_STATUS_COMMAND_FAILED',
    { elapsedMs: 15000, exitCode: 3, stderrBytes: 39 },
  ],
  [
    'a SIGTERM the provider did not send',
    execFailure({ code: null, killed: false, signal: 'SIGTERM' }),
    'AUTH_STATUS_COMMAND_FAILED',
    { elapsedMs: 15000, signal: 'SIGTERM', stderrBytes: 39 },
  ],
  [
    'a launch failure',
    Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT', stdout: '', stderr: '' }),
    'AUTH_STATUS_COMMAND_FAILED',
    { elapsedMs: 15000, stderrBytes: 0 },
  ],
  [
    'an output overflow',
    Object.assign(new RangeError('stdout maxBuffer length exceeded'), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      stdout: '',
      stderr: '',
    }),
    'AUTH_STATUS_COMMAND_FAILED',
    { elapsedMs: 15000, stderrBytes: 0 },
  ],
])('reports %s of claude auth status with its cause', async (_name, failure, code, detail) => {
  vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(16_000)
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
