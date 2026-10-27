import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import { describe, expect, it, vi } from 'vitest'
import type { UsageRecord } from '../src/metrics/history.js'
import { UsageHistory } from '../src/metrics/history.js'
import type { Account, Binding } from '../src/routing/types.js'
import { ToolLedger } from '../src/sessions/ledger.js'
import type { ToolState } from '../src/sessions/ledger.js'
import { SETTLED_LEDGER_LIMIT, STATE_SCHEMA_VERSION, StateStore } from '../src/storage/store.js'
import { AccountController } from '../src/ui/controller.js'
import { runProviderCli } from '../src/provider-cli.js'

const account = (identity: string): Account => ({
  identity,
  aliases: [identity],
  profileRef: 'default',
  state: 'READY',
  verifiedAt: 1,
  extraUsageOffConfirmedAt: 1,
  models: { opus: ['low'] },
  windows: [],
  parallelLimit: 1,
})
const binding = (key: string, identity: string, reason: string): Binding => ({
  key,
  identity,
  model: 'opus',
  generation: 1,
  committedCursor: 0,
  pendingTools: [],
  reason,
})
function tool(session: string, callId: string, state: ToolState) {
  const turn = 'turn'
  const key = JSON.stringify([session, turn, callId])
  return {
    collection: 'ledger',
    key,
    value: {
      key,
      session,
      turn,
      callId,
      argsDigest: 'ab'.repeat(32),
      state,
    },
  }
}
function legacyDirectory(
  rows: { collection: string; key: string; value: unknown }[],
): string {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-state-'))
  const db = new DatabaseSync(join(dir, 'state.sqlite'))
  db.exec(
    'CREATE TABLE state (collection TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(collection, key))',
  )
  const insert = db.prepare('INSERT INTO state(collection, key, value) VALUES(?, ?, ?)')
  db.exec('BEGIN')
  insert.run('meta', 'schema', JSON.stringify(1))
  for (const row of rows) insert.run(row.collection, row.key, JSON.stringify(row.value))
  db.exec('COMMIT')
  db.close()
  return dir
}
function usage(id: string, finishedAt: number, outcome: UsageRecord['outcome']): UsageRecord {
  return {
    id,
    session: 's',
    identity: 'A',
    model: 'opus',
    startedAt: finishedAt,
    finishedAt,
    outcome,
    attempts: 1,
    usage: { inputTokens: 1, outputTokens: 1 },
    quotaEpochs: {},
    sdkRetries: 0,
  }
}

describe('legacy state files', () => {
  it('keeps crash recovery and refuses retained settled call ids after a writer opens an old database', () => {
    const openStates = ['PROPOSED', 'AUTHORIZED', 'RUNNING', 'OUTCOME_UNKNOWN'] as const
    const openRows = openStates.map((state) => tool('hot', `open-${state}`, state))
    const dropped = Array.from({ length: 10 }, (_, i) =>
      tool('hot', `drop-${String(i).padStart(4, '0')}`, i % 2 === 0 ? 'COMMITTED' : 'FAILED'),
    )
    const kept = Array.from({ length: SETTLED_LEDGER_LIMIT }, (_, i) =>
      tool('hot', `keep-${String(i).padStart(4, '0')}`, 'COMMITTED'),
    )
    const dir = legacyDirectory([...openRows, ...dropped, ...kept])
    try {
      const writer = new StateStore(dir)
      const ledger = new ToolLedger(writer)
      const openIds = openStates.map((state) => `open-${state}`).sort()
      expect(ledger.unresolved('hot').map((entry) => entry.callId).sort()).toEqual(openIds)
      expect(writer.get('meta', 'schema')).toBe(STATE_SCHEMA_VERSION)
      expect(
        writer.list<{ state: string }>('ledger').filter((entry) => entry.state === 'PROPOSED'),
      ).toEqual([expect.objectContaining({ callId: 'open-PROPOSED', state: 'PROPOSED' })])
      expect(writer.count('ledger') - ledger.unresolved('hot').length).toBe(SETTLED_LEDGER_LIMIT)
      writer.close()
      const again = new StateStore(dir)
      const reopened = new ToolLedger(again)
      expect(reopened.unresolved('hot').map((entry) => entry.callId).sort()).toEqual(openIds)
      expect(again.count('ledger') - reopened.unresolved('hot').length).toBe(SETTLED_LEDGER_LIMIT)
      expect(() => reopened.propose('hot', 'turn', 'keep-0000', { x: 1 })).toThrow(
        'TOOL_ARGUMENT_MISMATCH',
      )
      expect(() => reopened.propose('hot', 'turn', 'drop-0000', { x: 1 })).not.toThrow()
      again.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads an old database without rewriting it', () => {
    const proposed = tool('hot', 'pending', 'PROPOSED')
    const dir = legacyDirectory([
      proposed,
      tool('hot', 'done-1', 'COMMITTED'),
      tool('hot', 'done-2', 'FAILED'),
      {
        collection: 'accounts',
        key: 'A',
        value: account('A'),
      },
      {
        collection: 'bindings',
        key: 'a-session',
        value: binding('a-session', 'A', 'older'),
      },
      {
        collection: 'bindings',
        key: 'm-session',
        value: binding('m-session', 'A', 'newer'),
      },
    ])
    try {
      const reader = new StateStore(dir, { readOnly: true })
      expect(reader.get('meta', 'schema')).toBe(1)
      expect(reader.indexed).toBe(false)
      expect(reader.count('ledger')).toBe(3)
      expect(new ToolLedger(reader).unresolved('hot').map((entry) => entry.callId)).toEqual([
        'pending',
      ])
      expect(reader.get('ledger', proposed.key)).toMatchObject({ state: 'PROPOSED', callId: 'pending' })
      const status = new AccountController(() => reader, 'claude').status()
      expect(status.accounts[0]?.lastRouteReason).toBe('newer')
      reader.close()
      const raw = new DatabaseSync(join(dir, 'state.sqlite'), { readOnly: true })
      const columns = raw.prepare('PRAGMA table_info(state)').all()
      expect(columns.some((column) => column.name === 'k1')).toBe(false)
      expect(raw.prepare('SELECT COUNT(*) AS n FROM state WHERE collection = ?').get('ledger')).toMatchObject({
        n: 3,
      })
      raw.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses the greatest binding key when a migrated file still has an unindexed row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'binding-index-'))
    try {
      const writer = new StateStore(dir)
      writer.set('accounts', 'A', account('A'))
      writer.set('bindings', 'a', binding('a', 'A', 'indexed'))
      writer.close()
      const raw = new DatabaseSync(join(dir, 'state.sqlite'))
      raw
        .prepare('INSERT INTO state(collection, key, value, k1, k2, k3) VALUES(?, ?, ?, NULL, NULL, NULL)')
        .run('bindings', 'z', JSON.stringify(binding('z', 'A', 'unindexed')))
      raw.close()
      const reader = new StateStore(dir, { readOnly: true })
      expect(new AccountController(() => reader, 'claude').status().accounts[0]?.lastRouteReason).toBe(
        'unindexed',
      )
      reader.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads a migrated file and leaves it unchanged when the previous insert runs', () => {
    const proposed = tool('hot', 'pending', 'PROPOSED')
    const dir = legacyDirectory([proposed])
    try {
      const writer = new StateStore(dir)
      expect(writer.get('meta', 'schema')).toBe(STATE_SCHEMA_VERSION)
      writer.close()
      const reader = new StateStore(dir, { readOnly: true })
      expect(new ToolLedger(reader).unresolved('hot').map((entry) => entry.callId)).toEqual([
        'pending',
      ])
      reader.close()
      const db = new DatabaseSync(join(dir, 'state.sqlite'))
      const count = () =>
        db.prepare(`SELECT COUNT(*) AS n FROM state WHERE collection = 'ledger'`).get() as { n: number }
      const before = count()
      expect(() =>
        db
          .prepare(
            'INSERT INTO state VALUES(?,?,?) ON CONFLICT(collection,key) DO UPDATE SET value=excluded.value',
          )
          .run('ledger', 'extra', '{}'),
      ).toThrow(/6 columns but 3 values/)
      expect(count()).toEqual(before)
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('finishes index columns for schema 2 and does not read that file without them', () => {
    const dir = legacyDirectory([tool('hot', 'pending', 'PROPOSED')])
    try {
      const raw = new DatabaseSync(join(dir, 'state.sqlite'))
      raw.prepare(`UPDATE state SET value = ? WHERE collection = 'meta' AND key = 'schema'`).run(
        JSON.stringify(STATE_SCHEMA_VERSION),
      )
      raw.close()
      expect(() => new StateStore(dir, { readOnly: true })).toThrow('UNSUPPORTED_STATE_SCHEMA')
      const writer = new StateStore(dir)
      expect(new ToolLedger(writer).unresolved('hot').map((entry) => entry.callId)).toEqual(['pending'])
      expect(writer.get('meta', 'schema')).toBe(STATE_SCHEMA_VERSION)
      writer.close()
      const reader = new StateStore(dir, { readOnly: true })
      expect(reader.indexed).toBe(true)
      expect(new ToolLedger(reader).unresolved('hot').map((entry) => entry.callId)).toEqual(['pending'])
      reader.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a schema other than 1 or 2 without deleting rows', () => {
    const dir = legacyDirectory([tool('hot', 'pending', 'PROPOSED')])
    try {
      const raw = new DatabaseSync(join(dir, 'state.sqlite'))
      raw.prepare(`UPDATE state SET value = ? WHERE collection = 'meta' AND key = 'schema'`).run(
        JSON.stringify(3),
      )
      raw.close()
      expect(() => new StateStore(dir)).toThrow('UNSUPPORTED_STATE_SCHEMA')
      expect(() => new StateStore(dir, { readOnly: true })).toThrow('UNSUPPORTED_STATE_SCHEMA')
      const check = new DatabaseSync(join(dir, 'state.sqlite'), { readOnly: true })
      expect(check.prepare(`SELECT value FROM state WHERE collection = 'meta' AND key = 'schema'`).get()).toMatchObject({
        value: '3',
      })
      expect(check.prepare(`SELECT COUNT(*) AS n FROM state WHERE collection = 'ledger'`).get()).toMatchObject({
        n: 1,
      })
      check.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('settled ledger and usage retention', () => {
  it('keeps a settled receipt while the retained tail has room, including a second settle', () => {
    const store = new StateStore(':memory:')
    const ledger = new ToolLedger(store)
    ledger.propose('s', 't', 'call', { x: 1 })
    ledger.settle('s', 'call', true)
    expect(ledger.unresolved('s')).toEqual([])
    expect(store.list<{ state: string }>('ledger')).toEqual([
      expect.objectContaining({ callId: 'call', state: 'FAILED' }),
    ])
    ledger.settle('s', 'call', false)
    expect(store.list<{ state: string }>('ledger')[0]).toMatchObject({ state: 'COMMITTED' })
    expect(() => ledger.propose('s', 't', 'call', { x: 1 })).toThrow('TOOL_ALREADY_PROPOSED')
    expect(() => ledger.propose('s', 't', 'call', { x: 2 })).toThrow('TOOL_ARGUMENT_MISMATCH')
    store.close()
  })

  it('drops the oldest usage row by finishedAt when the history limit is exceeded', () => {
    const dir = legacyDirectory([
      { collection: 'usage', key: 'old', value: usage('old', 100, 'response') },
      { collection: 'usage', key: 'mid', value: usage('mid', 40, 'error') },
    ])
    try {
      const store = new StateStore(dir)
      new UsageHistory(store, 1).record(usage('new', 10, 'tool-boundary'))
      expect(new UsageHistory(store, 1).recent().map((row) => row.id)).toEqual(['old'])
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports the last route for an identity without mixing in another account', () => {
    const store = new StateStore(':memory:')
    store.set('accounts', 'A', account('A'))
    store.set('accounts', 'B', account('B'))
    store.set('bindings', 'a', binding('a', 'A', 'first'))
    store.set('bindings', 'm', binding('m', 'A', 'second'))
    store.set('bindings', 'z', binding('z', 'B', 'other'))
    const status = new AccountController(() => store, 'claude').status()
    expect(status.accounts.map((row) => [row.id, row.lastRouteReason])).toEqual([
      ['A', 'second'],
      ['B', 'other'],
    ])
    store.close()
  })
})

describe('ledger request cost', () => {
  it(
    'looks up one request without parsing the rest of a large ledger',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'ledger-scale-'))
      const store = new StateStore(dir)
      try {
        store.transaction(() => {
          for (let i = 0; i < 100_000; i++) {
            const session = i < 2 ? 'hot' : `s${i % 40}`
            const callId = i < 2 ? `pending-${i}` : `c${i}`
            const turn = 'turn'
            const key = JSON.stringify([session, turn, callId])
            store.set('ledger', key, {
              key,
              session,
              turn,
              callId,
              argsDigest: 'ab'.repeat(32),
              state: 'PROPOSED' as const,
              pad: 'x'.repeat(280),
            })
          }
        })
        const ledger = new ToolLedger(store)
        const original = JSON.parse
        let parses = 0
        JSON.parse = ((text: string, reviver?: (key: string, value: unknown) => unknown) => {
          parses++
          return original(text, reviver)
        }) as typeof JSON.parse
        const samples: number[] = []
        try {
          for (let n = 0; n < 5; n++) {
            const before = parses
            const start = performance.now()
            const open = ledger.unresolved('hot')
            ledger.unresolved('hot')
            ledger.unresolved('hot')
            ledger.propose('hot', 'turn', `fresh-${n}`, { n })
            ledger.settle('hot', `fresh-${n}`, false)
            ledger.unresolved('hot')
            samples.push(performance.now() - start)
            const parsed = parses - before
            expect(parsed).toBeLessThan(40)
            expect(open.map((entry) => entry.callId).sort()).toEqual(['pending-0', 'pending-1'])
          }
        } finally {
          JSON.parse = original
        }
        samples.sort((left, right) => left - right)
        const median = samples[2] ?? 0
        expect(median).toBeLessThan(50)
        expect(ledger.unresolved('hot').map((entry) => entry.callId).sort()).toEqual([
          'pending-0',
          'pending-1',
        ])
        expect(() => ledger.propose('hot', 'turn', 'pending-0', { n: 1 })).toThrow(
          'TOOL_ARGUMENT_MISMATCH',
        )
        expect(() => ledger.propose('hot', 'turn', 'fresh-0', { n: 0 })).toThrow(
          'TOOL_ALREADY_PROPOSED',
        )
        expect(store.count('ledger')).toBe(100_005)
      } finally {
        store.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
    120_000,
  )
})

it('explain-route reads one session and diagnostics counts bindings', async () => {
  const opened = () => {
    const store = new StateStore(':memory:')
    store.set('bindings', 'one', binding('one', 'AAAAAAAAAAAAAA', 'sticky'))
    store.set('bindings', 'two', binding('two', 'BBBBBBBBBBBBBB', 'other'))
    return store
  }
  const routeStore = opened()
  const route = vi.fn()
  expect(
    await runProviderCli(['explain-route', 'one'], { store: () => routeStore, output: route }),
  ).toBe(0)
  expect(route).toHaveBeenCalledWith([
    expect.objectContaining({ key: 'one', identity: 'AAAAAAAAAAAA', reason: 'sticky' }),
  ])
  const diagnosticsStore = opened()
  const diagnostics = vi.fn()
  expect(
    await runProviderCli(['diagnostics', 'export', '--redacted'], {
      store: () => diagnosticsStore,
      output: diagnostics,
    }),
  ).toBe(0)
  expect(diagnostics).toHaveBeenCalledWith(
    expect.objectContaining({ bindings: 2, containsCredentials: false }),
  )
})
