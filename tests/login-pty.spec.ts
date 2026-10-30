import { beforeEach, expect, it, vi } from 'vitest'
import { profileEnvironment } from '../src/auth/official.js'
import { parseProfileRef } from '../src/login-view.js'

const fake = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node-pty', () => ({ spawn: fake.spawn }))
import { spawnLoginPty } from '../src/ui/login-pty.js'

beforeEach(() => {
  fake.spawn.mockReset()
  fake.spawn.mockReturnValue({ onData() {}, onExit() {}, write() {}, kill() {} })
})

it('spawns claude auth login on a pty with only the profile environment', () => {
  spawnLoginPty('claude', parseProfileRef('default'))
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
  expect(options.env).toEqual(profileEnvironment('default'))
  expect(options.env?.CLAUDE_CONFIG_DIR).toBeUndefined()
  expect(options.env?.ANTHROPIC_API_KEY).toBeUndefined()
  expect(options).not.toHaveProperty('stdio')
  expect(options).not.toHaveProperty('cwd')

  spawnLoginPty('claude', parseProfileRef('/tmp/profile'))
  const isolated = fake.spawn.mock.calls[1]?.[2] as { env?: NodeJS.ProcessEnv }
  expect(isolated.env).toEqual(profileEnvironment('/tmp/profile'))
  expect(isolated.env?.CLAUDE_CONFIG_DIR).toBe('/tmp/profile')
})

it('kills the login pty with SIGKILL', () => {
  expect(process.platform).not.toBe('win32')
  const kill = vi.fn()
  fake.spawn.mockReturnValue({ onData() {}, onExit() {}, write() {}, kill })
  spawnLoginPty('claude', parseProfileRef('default')).kill()
  expect(kill).toHaveBeenCalledTimes(1)
  expect(kill).toHaveBeenCalledWith('SIGKILL')
})
