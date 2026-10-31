import { beforeEach, expect, it, vi } from 'vitest'
import { profileEnvironment } from '../src/auth/official.js'
import { parseProfileRef } from '../src/login-view.js'

const fake = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node-pty', () => ({ spawn: fake.spawn }))
import { loginEnvironment, spawnLoginPty } from '../src/ui/login-pty.js'

beforeEach(() => {
  fake.spawn.mockReset()
  fake.spawn.mockReturnValue({ onData() {}, onExit() {}, write() {}, kill() {} })
})

it('spawns claude auth login on a pty without opening a browser', () => {
  spawnLoginPty('claude', parseProfileRef('/tmp/staging'))
  expect(fake.spawn).toHaveBeenCalledWith(
    'claude',
    ['auth', 'login', '--claudeai'],
    expect.any(Object),
  )
  const options = fake.spawn.mock.calls[0]?.[2] as {
    name?: string
    cols?: number
    rows?: number
    env?: NodeJS.ProcessEnv
    cwd?: string
    stdio?: unknown
  }
  expect(Object.keys(options).sort()).toEqual(['cols', 'env', 'name', 'rows'])
  expect(options).toMatchObject({ name: 'xterm-256color', cols: 200, rows: 24 })
  expect(options.env).toEqual(loginEnvironment(parseProfileRef('/tmp/staging')))
  expect(options.env?.CLAUDE_CONFIG_DIR).toBe('/tmp/staging')
  expect(options.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe('/tmp/staging')
  expect(options.env?.BROWSER).toBe('true')
  expect(options.env?.HOME).toBe(profileEnvironment('/tmp/staging').HOME)
  expect(options.env?.ANTHROPIC_API_KEY).toBeUndefined()
  expect(options).not.toHaveProperty('stdio')
  expect(options).not.toHaveProperty('cwd')
})

it.each([
  ['darwin', ['SIGKILL']],
  ['linux', ['SIGKILL']],
  ['win32', []],
] as const)('kills the login pty on %s', (platform, args) => {
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    const kill = vi.fn()
    fake.spawn.mockReturnValue({ onData() {}, onExit() {}, write() {}, kill })
    spawnLoginPty('claude', parseProfileRef('default')).kill()
    expect(kill).toHaveBeenCalledTimes(1)
    expect(kill).toHaveBeenCalledWith(...args)
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true })
  }
})

it('forwards writes, output and exit to the pty', () => {
  const child = { onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), kill() {} }
  fake.spawn.mockReturnValue(child)
  const pty = spawnLoginPty('claude', parseProfileRef('default'))
  const onData = () => {}
  const onExit = () => {}
  pty.write('code\r')
  pty.onData(onData)
  pty.onExit(onExit)
  expect(child.write).toHaveBeenCalledWith('code\r')
  expect(child.onData).toHaveBeenCalledWith(onData)
  expect(child.onExit).toHaveBeenCalledWith(onExit)
})
