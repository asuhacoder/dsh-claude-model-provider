import { DatabaseSync } from 'node:sqlite'
import {
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  chmodSync,
} from 'node:fs'
import { join } from 'node:path'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'

/** One local writer, transactional state, private permissions. No credential blobs. */
export class StateStore {
  readonly db: DatabaseSync
  readonly owner = randomUUID()
  readonly lock: string | undefined
  #closed = false
  constructor(
    readonly directory: string,
    readonly options: { readOnly?: boolean } = {},
  ) {
    if (options.readOnly) {
      this.db = new DatabaseSync(join(directory, 'state.sqlite'), { readOnly: true })
      if (this.get<number>('meta', 'schema') !== 1) {
        this.db.close()
        throw new Error('UNSUPPORTED_STATE_SCHEMA')
      }
      return
    }
    if (directory !== ':memory:') {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      chmodSync(directory, 0o700)
      this.lock = join(directory, 'writer.lock')
      try {
        const fd = openSync(this.lock, 'wx', 0o600)
        writeFileSync(fd, JSON.stringify({ pid: process.pid, owner: this.owner }))
        closeSync(fd)
      } catch {
        throw new Error(
          'STATE_IN_USE: close the other writer; doctor recovery requires a confirmed dead PID',
        )
      }
    }
    try {
      this.db = new DatabaseSync(
        directory === ':memory:' ? directory : join(directory, 'state.sqlite'),
      )
      this.db.exec(
        'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state (collection TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(collection,key));',
      )
      const version = this.get<number>('meta', 'schema')
      if (version !== undefined && version !== 1) throw new Error('UNSUPPORTED_STATE_SCHEMA')
      this.set('meta', 'schema', 1)
      if (!this.get('meta', 'salt')) this.set('meta', 'salt', randomBytes(32).toString('hex'))
      this.delete('meta', 'auth-mutation')
      const circuit = this.get<Record<string, unknown>>('meta', 'provider-circuit')
      if (circuit) {
        delete circuit.probe
        this.set('meta', 'provider-circuit', circuit)
      }
      // A crash may consume quota: release local reservations but never infer refunded usage.
      this.db.exec("DELETE FROM state WHERE collection='reservations'")
      if (directory !== ':memory:') chmodSync(join(directory, 'state.sqlite'), 0o600)
    } catch (error) {
      if (this.lock) unlinkSync(this.lock)
      throw error
    }
  }
  get<T>(collection: string, key: string): T | undefined {
    const row = this.db
      .prepare('SELECT value FROM state WHERE collection=? AND key=?')
      .get(collection, key)
    return row ? (JSON.parse(String(row.value)) as T) : undefined
  }
  list<T>(collection: string): T[] {
    return this.db
      .prepare('SELECT value FROM state WHERE collection=? ORDER BY key')
      .all(collection)
      .map((r) => JSON.parse(String(r.value)) as T)
  }
  set(collection: string, key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO state VALUES(?,?,?) ON CONFLICT(collection,key) DO UPDATE SET value=excluded.value',
      )
      .run(collection, key, JSON.stringify(value))
  }
  delete(collection: string, key: string): void {
    this.db.prepare('DELETE FROM state WHERE collection=? AND key=?').run(collection, key)
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
  hash(value: string): string {
    return createHmac('sha256', this.get<string>('meta', 'salt')!).update(value).digest('hex')
  }
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.db.close()
    if (this.lock) {
      const row = JSON.parse(readFileSync(this.lock, 'utf8'))
      if (row.owner === this.owner) unlinkSync(this.lock)
    }
  }
}

/** Explicit recovery: a live or inaccessible PID is never considered dead. */
export function recoverStateLock(directory: string): { status: string } {
  const lock = join(directory, 'writer.lock')
  let old: { pid: number; owner: string }
  try {
    old = JSON.parse(readFileSync(lock, 'utf8'))
  } catch {
    throw new Error('RECOVERY_LOCK_UNREADABLE')
  }
  if (!Number.isInteger(old.pid) || old.pid <= 0 || typeof old.owner !== 'string')
    throw new Error('RECOVERY_LOCK_INVALID')
  try {
    process.kill(old.pid, 0)
    throw new Error('STATE_IN_USE')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
  }
  const current = JSON.parse(readFileSync(lock, 'utf8'))
  if (current.owner !== old.owner) throw new Error('RECOVERY_OWNER_CHANGED')
  unlinkSync(lock)
  return { status: 'STALE_LOCK_RECOVERED' }
}
