import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transformSync } from 'esbuild'
import { StateStore } from '../src/storage/store.js'
import { runProviderCli } from '../src/provider-cli.js'

const DEAD_PID = 2147483647
const dirs: string[] = []
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lock-'))
  dirs.push(dir)
  return dir
}
function writeLock(dir: string, pid: number, owner: string): void {
  writeFileSync(join(dir, 'writer.lock'), JSON.stringify({ pid, owner }))
}
function readLock(dir: string): { pid: number; owner: string } {
  return JSON.parse(readFileSync(join(dir, 'writer.lock'), 'utf8'))
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('writer.lock acquisition', () => {
  it('reclaims a lock whose pid is dead', () => {
    const dir = stateDir()
    writeLock(dir, DEAD_PID, 'crashed-writer')
    const store = new StateStore(dir)
    expect(readLock(dir)).toEqual({ pid: process.pid, owner: store.owner })
    store.close()
    expect(existsSync(join(dir, 'writer.lock'))).toBe(false)
  })

  it('refuses a lock whose pid is live or inaccessible', () => {
    const dir = stateDir()
    writeLock(dir, process.pid, 'live-writer')
    expect(() => new StateStore(dir)).toThrow('STATE_IN_USE')
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
    })
    writeLock(dir, DEAD_PID, 'other-user-writer')
    expect(() => new StateStore(dir)).toThrow('STATE_IN_USE')
    expect(readLock(dir).owner).toBe('other-user-writer')
  })

  it('refuses a dead-pid lock whose owner changes before the unlink', () => {
    const dir = stateDir()
    writeLock(dir, DEAD_PID, 'crashed-writer')
    vi.spyOn(process, 'kill').mockImplementation(() => {
      writeLock(dir, process.pid, 'new-writer')
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    })
    expect(() => new StateStore(dir)).toThrow('STATE_IN_USE')
    expect(readLock(dir).owner).toBe('new-writer')
  })

  it('closes once and tolerates a lock that is already gone', () => {
    const dir = stateDir()
    const store = new StateStore(dir)
    rmSync(join(dir, 'writer.lock'))
    expect(() => store.close()).not.toThrow()
    expect(() => store.close()).not.toThrow()
  })
})

describe('writer.lock on clean process exit', () => {
  const store = transformSync(readFileSync('src/storage/store.ts', 'utf8'), {
    loader: 'ts',
    format: 'esm',
  }).code
  for (const [name, exit] of [
    ['an empty event loop', ''],
    ['process.exit(0)', 'process.exit(0)'],
  ] as const) {
    it(`releases the lock after ${name}`, () => {
      const dir = stateDir()
      const module = join(dir, 'store.mjs')
      writeFileSync(module, store)
      const child = spawnSync(
        process.execPath,
        [
          '--no-warnings',
          '--input-type=module',
          '-e',
          `const { StateStore } = await import(${JSON.stringify(module)})
           new StateStore(${JSON.stringify(join(dir, 'state'))}).set('fixture', 'x', 1)
           ${exit}`,
        ],
        { encoding: 'utf8' },
      )
      expect(child.stderr).toBe('')
      expect(child.status).toBe(0)
      expect(existsSync(join(dir, 'state', 'writer.lock'))).toBe(false)
    })
  }
})

describe('doctor --recover', () => {
  it('runs the real recovery and treats an absent lock as recovered', async () => {
    const dir = stateDir()
    const output = vi.fn()
    writeLock(dir, DEAD_PID, 'crashed-writer')
    expect(await runProviderCli(['doctor', '--recover', '--state', dir], { output })).toBe(0)
    expect(output).toHaveBeenLastCalledWith({ status: 'STALE_LOCK_RECOVERED' })
    expect(existsSync(join(dir, 'writer.lock'))).toBe(false)
    expect(await runProviderCli(['doctor', '--recover', '--state', dir], { output })).toBe(0)
    expect(output).toHaveBeenLastCalledWith({ status: 'NO_STALE_LOCK' })
  })

  it('blocks on a live writer and keeps its lock', async () => {
    const dir = stateDir()
    const output = vi.fn()
    const writer = new StateStore(dir)
    expect(await runProviderCli(['doctor', '--recover', '--state', dir], { output })).toBe(2)
    expect(output).toHaveBeenLastCalledWith({ status: 'BLOCKED', code: 'STATE_IN_USE' })
    expect(readLock(dir).owner).toBe(writer.owner)
    writer.close()
  })
})
