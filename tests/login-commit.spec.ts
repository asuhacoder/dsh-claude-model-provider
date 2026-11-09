import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: fake.execFile,
}))
import { parseLoginPayload } from '../src/login-view.js'
import type { Account, AccountState } from '../src/routing/types.js'
import { StateStore } from '../src/storage/store.js'
import { AccountController } from '../src/ui/controller.js'
import type { LoginPty, LoginPtyExit } from '../src/ui/login-pty.js'

const STAGED_SECRET = 'staged-dummy-value'
const ATTEMPT = '00000000-0000-4000-8000-000000000001'
const platform = process.platform

type Callback = (error: Error | null, result?: { stdout: string; stderr: string }) => void
interface SecurityCall {
  args: string[]
  stdin: string
}

let calls: SecurityCall[] = []
let addFails = false
let dirs: string[] = []

function fakeSecurity(): void {
  fake.execFile.mockImplementation(
    (_command: string, args: string[], _options: unknown, callback: Callback) => {
      const call: SecurityCall = { args, stdin: '' }
      calls.push(call)
      const reply = () => {
        const adding =
          args.includes('add-generic-password') || call.stdin.includes('add-generic-password')
        if (adding && addFails) callback(new Error('denied'))
        else if (args[0] === 'find-generic-password')
          callback(null, { stdout: `${STAGED_SECRET}\n`, stderr: '' })
        else callback(null, { stdout: '', stderr: '' })
      }
      if (args[0] !== '-i') queueMicrotask(reply)
      return {
        stdin: {
          on() {},
          end(data: string) {
            call.stdin += data
            queueMicrotask(reply)
          },
        },
      }
    },
  )
}

class ExitedPty implements LoginPty {
  write(): void {}
  kill(): void {}
  onData(): void {}
  onExit(listener: (event: LoginPtyExit) => void): void {
    listener({ exitCode: 0, signal: 0 })
  }
}

function row(state: AccountState, profileRef: string): Account {
  return {
    identity: 'A',
    aliases: ['primary'],
    profileRef,
    state,
    verifiedAt: 1,
    extraUsageOffConfirmedAt: 1,
    models: { opus: ['low'] },
    windows: [],
    parallelLimit: 2,
  }
}

async function login(): Promise<{
  phase: string
  failureCode: string | undefined
  credential: string
  stored: Account | undefined
  sibling: Account | undefined
}> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-commit-'))
  dirs.push(root)
  const profile = join(root, 'profile')
  mkdirSync(profile, { mode: 0o700 })
  const credential = join(profile, '.credentials.json')
  writeFileSync(credential, 'old-sentinel\n', { mode: 0o600 })
  const web = new StateStore(join(root, 'claude-sdk-web'))
  const local = new StateStore(join(root, 'claude-sdk-local'))
  web.set('accounts', 'A', row('AUTH_REQUIRED', profile))
  local.set('accounts', 'A', row('AUTH_REQUIRED', profile))
  local.close()
  const verify = vi.fn(async (_s: StateStore, _c: string, _a: string, stagingDir: string) => {
    writeFileSync(join(stagingDir, '.credentials.json'), 'fresh-login\n', { mode: 0o600 })
    return { ...row('READY', profile), verifiedAt: 2 }
  })
  const controller = new AccountController(() => web, 'claude', undefined, {
    verify,
    spawnLogin: () => new ExitedPty(),
  })
  try {
    const done = await controller.login(
      parseLoginPayload({ op: 'open', attempt: ATTEMPT, alias: 'primary', profile }),
    )
    const exchange = done.exchange as { phase: string; failureCode?: string }
    const stored = web.get<Account>('accounts', 'A')
    controller.dispose()
    web.close()
    const check = new StateStore(join(root, 'claude-sdk-local'))
    const sibling = check.get<Account>('accounts', 'A')
    check.close()
    return {
      phase: exchange.phase,
      failureCode: exchange.failureCode,
      credential: readFileSync(credential, 'utf8'),
      stored,
      sibling,
    }
  } finally {
    controller.dispose()
  }
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  vi.stubEnv('USER', 'tester')
  calls = []
  addFails = false
  fake.execFile.mockReset()
  fakeSecurity()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  vi.unstubAllEnvs()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

it('fails the login and keeps the previous file and account when the Keychain copy fails', async () => {
  addFails = true
  const result = await login()
  expect(result).toMatchObject({ phase: 'failed', failureCode: 'LOGIN_NOT_COMMITTED' })
  expect(result.credential).toBe('old-sentinel\n')
  expect(result.stored).toMatchObject({ state: 'AUTH_REQUIRED', verifiedAt: 1 })
  expect(result.sibling).toMatchObject({ state: 'AUTH_REQUIRED', verifiedAt: 1 })
})

it('commits the file and the Keychain item together without the secret on argv', async () => {
  const result = await login()
  expect(result).toMatchObject({ phase: 'ready', credential: 'fresh-login\n' })
  expect(result.stored).toMatchObject({ state: 'READY', verifiedAt: 2 })
  expect(result.sibling).toMatchObject({ state: 'READY', verifiedAt: 2 })
  const hex = Buffer.from(STAGED_SECRET, 'utf8').toString('hex')
  expect(calls.some((call) => call.stdin.includes(hex))).toBe(true)
  for (const call of calls) {
    expect(call.args.join(' ')).not.toContain(STAGED_SECRET)
    expect(call.args.join(' ')).not.toContain(hex)
  }
})
