import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fake = vi.hoisted(() => ({ execFile: vi.fn(), userInfo: vi.fn(), homedir: vi.fn() }))
vi.mock('node:os', async (original) => {
  const os = await original<typeof import('node:os')>()
  return { ...os, default: os, userInfo: fake.userInfo, homedir: fake.homedir }
})
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: fake.execFile,
}))
import {
  credentialServiceName,
  discardStagingKeychain,
  installDarwinKeychain,
  installVerifiedCredentials,
  mirrorProfileReady,
  siblingStateDirectory,
} from '../src/login-install.js'
import type { Account } from '../src/routing/types.js'
import { StateStore } from '../src/storage/store.js'

type Reply = Error | string
const platform = process.platform
let dirs: string[] = []

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

function answer(...replies: Reply[]): void {
  for (const reply of replies) {
    fake.execFile.mockImplementationOnce((_command, _args, _options, callback) => {
      if (reply instanceof Error) callback(reply)
      else callback(null, { stdout: reply, stderr: '' })
    })
  }
}

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'login-install-'))
  dirs.push(dir)
  return dir
}

beforeEach(() => {
  fake.execFile.mockReset()
  fake.userInfo.mockReset()
  fake.homedir.mockReset()
  vi.stubEnv('USER', 'tester')
})

afterEach(() => {
  setPlatform(platform)
  vi.unstubAllEnvs()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

describe('credentialServiceName', () => {
  it('uses the unsuffixed service for the default profile and a stable hash otherwise', () => {
    expect(credentialServiceName(undefined)).toBe('Claude Code-credentials')
    expect(credentialServiceName('/a')).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/)
    expect(credentialServiceName('/a')).toBe(credentialServiceName('/a'))
    expect(credentialServiceName('/a')).not.toBe(credentialServiceName('/b'))
  })
})

describe('installVerifiedCredentials', () => {
  it('reports nothing to install when the staging login wrote no file', () => {
    expect(installVerifiedCredentials(temp(), join(temp(), 'profile'))).toBe(false)
  })

  it('copies the staged credentials into the profile with owner-only access', () => {
    const staging = temp()
    const profile = join(temp(), 'profile')
    writeFileSync(join(staging, '.credentials.json'), '{"token":"new"}')
    expect(installVerifiedCredentials(staging, profile)).toBe(true)
    const installed = join(profile, '.credentials.json')
    expect(readFileSync(installed, 'utf8')).toBe('{"token":"new"}')
    if (platform !== 'win32') expect(statSync(installed).mode & 0o777).toBe(0o600)
  })

  it('installs the default profile into ~/.claude', () => {
    const staging = temp()
    const home = temp()
    fake.homedir.mockReturnValue(home)
    writeFileSync(join(staging, '.credentials.json'), '{"token":"default"}')
    expect(installVerifiedCredentials(staging, 'default')).toBe(true)
    expect(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8')).toBe('{"token":"default"}')
  })

  it('reports LOGIN_NOT_COMMITTED and leaves no temporary file when the copy fails', () => {
    const staging = temp()
    const profile = temp()
    writeFileSync(join(staging, '.credentials.json'), '{}')
    mkdirSync(join(profile, '.credentials.json'))
    writeFileSync(join(profile, '.credentials.json', 'occupied'), '')
    expect(() => installVerifiedCredentials(staging, profile)).toThrow(
      expect.objectContaining({ code: 'LOGIN_NOT_COMMITTED' }),
    )
    expect(() => statSync(join(profile, `..credentials.json.${process.pid}.tmp`))).toThrow()
  })
})

describe('installDarwinKeychain', () => {
  it('does nothing outside macOS', async () => {
    setPlatform('linux')
    await expect(installDarwinKeychain('/staging', '/profile')).resolves.toBe(false)
    expect(fake.execFile).not.toHaveBeenCalled()
  })

  it('falls back to the account name when USER and LOGNAME are empty', async () => {
    setPlatform('darwin')
    vi.stubEnv('USER', '')
    vi.stubEnv('LOGNAME', '')
    fake.userInfo.mockReturnValue({ username: 'fallback' })
    answer(new Error('not found'))
    await expect(installDarwinKeychain('/staging', '/profile')).resolves.toBe(false)
    expect((fake.execFile.mock.calls[0]?.[1] as string[])[2]).toBe('fallback')
  })

  it('does nothing when no user name can be found', async () => {
    setPlatform('darwin')
    vi.stubEnv('USER', '')
    vi.stubEnv('LOGNAME', '')
    fake.userInfo.mockImplementation(() => {
      throw new Error('no user')
    })
    await expect(installDarwinKeychain('/staging', '/profile')).resolves.toBe(false)
    expect(fake.execFile).not.toHaveBeenCalled()
  })

  it('moves the staged secret to the profile service and deletes the staged entry', async () => {
    setPlatform('darwin')
    answer('secret\n', '', '')
    await expect(installDarwinKeychain('/staging', 'default')).resolves.toBe(true)
    const calls = fake.execFile.mock.calls.map((call) => call[1] as string[])
    expect(calls[0]).toEqual(['find-generic-password', '-a', 'tester', '-s', credentialServiceName('/staging'), '-w'])
    expect(calls[1]).toEqual(['add-generic-password', '-U', '-a', 'tester', '-s', 'Claude Code-credentials', '-w', 'secret'])
    expect(calls[2]).toEqual(['delete-generic-password', '-a', 'tester', '-s', credentialServiceName('/staging')])
  })

  it('writes a named profile to its hashed service', async () => {
    setPlatform('darwin')
    answer('secret', '', '')
    await expect(installDarwinKeychain('/staging', '/profile')).resolves.toBe(true)
    expect((fake.execFile.mock.calls[1]?.[1] as string[])[5]).toBe(credentialServiceName('/profile'))
  })

  it.each([
    ['the staged entry is missing', [new Error('not found')]],
    ['the staged entry is empty', [' \n']],
    ['the profile entry cannot be written', ['secret', new Error('denied')]],
  ] as const)('keeps the staged entry when %s', async (_case, replies) => {
    setPlatform('darwin')
    answer(...replies)
    await expect(installDarwinKeychain('/staging', '/profile')).resolves.toBe(false)
    expect(fake.execFile.mock.calls.map((call) => (call[1] as string[])[0])).not.toContain('delete-generic-password')
  })
})

describe('discardStagingKeychain', () => {
  it('deletes the staged entry on macOS', () => {
    setPlatform('darwin')
    answer('')
    discardStagingKeychain('/staging')
    expect(fake.execFile.mock.calls[0]?.[1]).toEqual(['delete-generic-password', '-a', 'tester', '-s', credentialServiceName('/staging')])
  })

  it('ignores a failed delete', async () => {
    setPlatform('darwin')
    answer(new Error('not found'))
    expect(() => discardStagingKeychain('/staging')).not.toThrow()
    await Promise.resolve()
  })

  it('does nothing outside macOS, without a staging directory, or without a user name', () => {
    setPlatform('linux')
    discardStagingKeychain('/staging')
    setPlatform('darwin')
    discardStagingKeychain('')
    vi.stubEnv('USER', '')
    vi.stubEnv('LOGNAME', '')
    fake.userInfo.mockReturnValue({ username: '' })
    discardStagingKeychain('/staging')
    expect(fake.execFile).not.toHaveBeenCalled()
  })
})

describe('siblingStateDirectory', () => {
  it('pairs the web and local state directories and nothing else', () => {
    expect(siblingStateDirectory(join('/h', 'claude-sdk-web'))).toBe(join('/h', 'claude-sdk-local'))
    expect(siblingStateDirectory(join('/h', 'claude-sdk-local'))).toBe(join('/h', 'claude-sdk-web'))
    expect(siblingStateDirectory(join('/h', 'other'))).toBeUndefined()
    expect(siblingStateDirectory(':memory:')).toBeUndefined()
  })
})

describe('mirrorProfileReady', () => {
  function account(overrides: Partial<Account> = {}): Account {
    return {
      identity: 'id-1',
      aliases: ['main'],
      profileRef: '/profiles/main',
      state: 'AUTH_REQUIRED',
      verifiedAt: 1,
      models: {},
      windows: [],
      parallelLimit: 1,
      ...overrides,
    }
  }

  function pools(): { web: string; local: string } {
    const root = temp()
    return { web: join(root, 'claude-sdk-web'), local: join(root, 'claude-sdk-local') }
  }

  it('marks the matching profile ready in the other pool', () => {
    const { web, local } = pools()
    const sibling = new StateStore(local)
    sibling.set('accounts', 'id-1', account())
    sibling.set('accounts', 'id-2', account({ identity: 'id-2', profileRef: '/profiles/other' }))
    sibling.close()
    const committed = account({ state: 'READY', verifiedAt: 99, models: { opus: ['high'] }, extraUsageOffConfirmedAt: 98 })
    expect(mirrorProfileReady(web, committed)).toBe('mirrored')
    const check = new StateStore(local)
    try {
      const rows = new Map(check.list<Account>('accounts').map((row) => [row.identity, row]))
      expect(rows.get('id-1')).toMatchObject({ state: 'READY', verifiedAt: 99, models: { opus: ['high'] }, extraUsageOffConfirmedAt: 98 })
      expect(rows.get('id-2')).toMatchObject({ state: 'AUTH_REQUIRED', verifiedAt: 1 })
    } finally {
      check.close()
    }
  })

  it('copies model metadata and leaves absent optional fields unset', () => {
    const { web, local } = pools()
    const sibling = new StateStore(local)
    sibling.set('accounts', 'id-1', account())
    sibling.close()
    const metadata = { opus: { displayName: 'Claude Opus' } } as unknown as NonNullable<Account['modelMetadata']>
    expect(mirrorProfileReady(web, account({ state: 'READY', modelMetadata: metadata }))).toBe('mirrored')
    const check = new StateStore(local)
    try {
      const row = check.list<Account>('accounts')[0]
      expect(row?.modelMetadata).toEqual(metadata)
      expect(row).not.toHaveProperty('extraUsageOffConfirmedAt')
    } finally {
      check.close()
    }
  })

  it('reports absent when the other pool has no state or no matching profile', () => {
    const { web, local } = pools()
    expect(mirrorProfileReady(web, account())).toBe('absent')
    new StateStore(local).close()
    expect(mirrorProfileReady(web, account({ profileRef: '/profiles/none' }))).toBe('absent')
    expect(mirrorProfileReady(join(temp(), 'other'), account())).toBe('absent')
  })

  it('reports absent when the other pool cannot be opened', () => {
    const { web, local } = pools()
    mkdirSync(local, { recursive: true })
    writeFileSync(join(local, 'state.sqlite'), 'not a database')
    expect(mirrorProfileReady(web, account())).toBe('absent')
  })

  it('reports locked while another writer holds the other pool', () => {
    const { web, local } = pools()
    const writer = new StateStore(local)
    try {
      expect(mirrorProfileReady(web, account())).toBe('locked')
    } finally {
      writer.close()
    }
  })
})
