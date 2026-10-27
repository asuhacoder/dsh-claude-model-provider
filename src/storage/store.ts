import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
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

export const SETTLED_LEDGER_LIMIT = 1024

export const OPEN_LEDGER = `collection = 'ledger' AND IFNULL(k3, '') NOT IN ('COMMITTED', 'FAILED')`

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}
function finishedOrder(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null
  return String(value).padStart(16, '0')
}
function indexKeys(
  collection: string,
  value: unknown,
): [string | null, string | null, string | null] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [null, null, null]
  const record = value as Record<string, unknown>
  switch (collection) {
    case 'ledger':
      return [text(record.session), text(record.callId), text(record.state)]
    case 'bindings':
      return [text(record.identity), null, null]
    case 'usage':
      return [finishedOrder(record.finishedAt), null, null]
    default:
      return [null, null, null]
  }
}

export class StateStore {
  readonly db: DatabaseSync
  readonly owner = randomUUID()
  readonly lock: string | undefined
  readonly indexed: boolean = false
  #closed = false
  constructor(
    readonly directory: string,
    readonly options: { readOnly?: boolean } = {},
  ) {
    if (options.readOnly) {
      this.db = new DatabaseSync(join(directory, 'state.sqlite'), { readOnly: true })
      this.indexed = this.#hasIndexColumns()
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
      } catch (error) {
        throw new Error(
          'STATE_IN_USE: close the other writer; doctor recovery requires a confirmed dead PID',
          { cause: error },
        )
      }
    }
    try {
      this.db = new DatabaseSync(
        directory === ':memory:' ? directory : join(directory, 'state.sqlite'),
      )
      this.db.exec(
        'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state (collection TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, k1 TEXT, k2 TEXT, k3 TEXT, PRIMARY KEY(collection,key));',
      )
      const version = this.get<number>('meta', 'schema')
      if (version !== undefined && version !== 1) throw new Error('UNSUPPORTED_STATE_SCHEMA')
      this.transaction(() => {
        this.#ensureIndexColumns()
        this.set('meta', 'schema', 1)
        if (!this.get('meta', 'salt')) this.set('meta', 'salt', randomBytes(32).toString('hex'))
        this.delete('meta', 'auth-mutation')
        const circuit = this.get<Record<string, unknown>>('meta', 'provider-circuit')
        if (circuit) {
          delete circuit.probe
          this.set('meta', 'provider-circuit', circuit)
        }
        this.db.exec("DELETE FROM state WHERE collection='reservations'")
        this.#indexRows()
      })
      this.indexed = true
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
    const [k1, k2, k3] = indexKeys(collection, value)
    this.db
      .prepare(
        `INSERT INTO state(collection, key, value, k1, k2, k3) VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(collection, key) DO UPDATE SET
           value = excluded.value, k1 = excluded.k1, k2 = excluded.k2, k3 = excluded.k3`,
      )
      .run(collection, key, JSON.stringify(value), k1, k2, k3)
  }
  count(collection: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM state WHERE collection = ?')
      .get(collection) as { n: number }
    return Number(row.n)
  }
  queryValues<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db
      .prepare(sql)
      .all(...params)
      .map((row) => JSON.parse(String(row.value)) as T)
  }
  missingIndexKey(collection: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 AS hit FROM state WHERE collection = ? AND k1 IS NULL LIMIT 1')
        .get(collection) !== undefined
    )
  }
  pruneSettledLedger(limit = SETTLED_LEDGER_LIMIT): void {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM state INDEXED BY state_ledger_settled
         WHERE collection = 'ledger' AND k3 IN ('COMMITTED', 'FAILED')`,
      )
      .get() as { n: number }
    const overflow = Number(row.n) - limit
    if (overflow <= 0) return
    this.db
      .prepare(
        `DELETE FROM state WHERE rowid IN (
           SELECT rowid FROM state INDEXED BY state_ledger_settled
           WHERE collection = 'ledger' AND k3 IN ('COMMITTED', 'FAILED')
           ORDER BY rowid
           LIMIT ?
         )`,
      )
      .run(overflow)
  }
  #hasIndexColumns(): boolean {
    return this.db
      .prepare('PRAGMA table_info(state)')
      .all()
      .some((column) => column.name === 'k1')
  }
  #ensureIndexColumns(): void {
    if (this.#hasIndexColumns()) return
    this.db.exec('ALTER TABLE state ADD COLUMN k1 TEXT')
    this.db.exec('ALTER TABLE state ADD COLUMN k2 TEXT')
    this.db.exec('ALTER TABLE state ADD COLUMN k3 TEXT')
  }
  #indexRows(): void {
    this.db.exec(
      `UPDATE state SET
         k1 = json_extract(value, '$.session'),
         k2 = json_extract(value, '$.callId'),
         k3 = json_extract(value, '$.state')
       WHERE collection = 'ledger' AND (
         k1 IS NOT json_extract(value, '$.session') OR
         k2 IS NOT json_extract(value, '$.callId') OR
         k3 IS NOT json_extract(value, '$.state')
       )`,
    )
    this.db.exec(
      `UPDATE state SET k1 = json_extract(value, '$.identity'), k2 = NULL, k3 = NULL
       WHERE collection = 'bindings' AND k1 IS NOT json_extract(value, '$.identity')`,
    )
    this.db.exec(
      `UPDATE state SET
         k1 = printf('%016d', json_extract(value, '$.finishedAt')),
         k2 = NULL,
         k3 = NULL
       WHERE collection = 'usage' AND (
         k1 IS NOT printf('%016d', json_extract(value, '$.finishedAt')) OR
         k2 IS NOT NULL
       )`,
    )
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS state_ledger_call ON state(k1, k2) WHERE collection = 'ledger'`,
    )
    this.db.exec(`CREATE INDEX IF NOT EXISTS state_ledger_open ON state(k1) WHERE ${OPEN_LEDGER}`)
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS state_ledger_settled ON state(k3)
       WHERE collection = 'ledger' AND k3 IN ('COMMITTED', 'FAILED')`,
    )
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS state_binding_identity ON state(k1, key) WHERE collection = 'bindings'`,
    )
    this.pruneSettledLedger()
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
  } catch (error) {
    throw new Error('RECOVERY_LOCK_UNREADABLE', { cause: error })
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
