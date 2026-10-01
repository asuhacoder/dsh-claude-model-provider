import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../src/storage/store.js'
import { StickyRouter, choose, availableWork } from '../src/routing/router.js'
import type { Account, Binding } from '../src/routing/types.js'
import { ToolLedger } from '../src/sessions/ledger.js'
import { billingConflicts, profileEnvironment } from '../src/auth/official.js'
import { prepareDshRequest } from '../src/sessions/provider.js'
const account = (id: string): Account => ({
  identity: id,
  aliases: [id],
  profileRef: 'default',
  state: 'READY',
  verifiedAt: 1,
  extraUsageOffConfirmedAt: 1,
  models: { opus: ['low', 'high'], sonnet: ['low'] },
  windows: [],
  parallelLimit: 10,
})
const req = (session: string, now = 1) => ({ session, requestId: session, model: 'opus', now })
describe('subscription routing acceptance', () => {
  it('A-008 A-009 A-010 A-012 preserves bindings, deduplicates profiles and spreads simultaneous reservations', () => {
    const s = new StateStore(':memory:')
    const r = new StickyRouter(s)
    for (const id of ['A', 'B', 'C']) r.register(account(id))
    r.register({ ...account('A'), aliases: ['alias'] })
    expect(s.list('accounts')).toHaveLength(3)
    const bindings = Array.from({ length: 30 }, (_, i) => r.route(req('s' + i)))
    expect(new Set(bindings.map((b) => b.identity)).size).toBe(3)
    for (const b of bindings) {
      r.release(b.key)
      expect(r.route(req(b.key)).identity).toBe(b.identity)
      r.release(b.key)
    }
    s.close()
  })
  it('A-013 A-014 A-015 intersects hard scoped windows; a weekly reset cannot erase a short block', () => {
    const a = account('A'),
      b = account('B')
    a.windows = [
      {
        key: 'five',
        scope: '*',
        epoch: '1',
        observedAt: 0,
        hardBlockedUntil: 50,
        source: 'fixture',
      },
      {
        key: 'week',
        scope: '*',
        epoch: '2',
        observedAt: 0,
        resetsAt: 2,
        remainingWork: 999,
        source: 'fixture',
      },
    ]
    expect(choose([a, b], req('s'), []).identity).toBe('B')
    expect(() => choose([a], req('s'), [])).toThrow('POOL_UNAVAILABLE')
    a.windows[0]!.scope = 'sonnet'
    expect(choose([a], req('s'), []).identity).toBe('A')
  })
  it('A-016 A-017 A-018 unknown is not zero; utilization alone never compares capacity', () => {
    const a = account('A')
    a.windows = [
      { key: 'week', scope: '*', epoch: '1', observedAt: 1, utilization: 0.99, source: 'sdk' },
    ]
    expect(availableWork(a, 'opus', 1, [])).toBeUndefined()
    expect(choose([a], req('s'), []).identity).toBe('A')
  })
  it('A-019 excludes old epochs from reservations and rejects stale observations', () => {
    const s = new StateStore(':memory:')
    const r = new StickyRouter(s)
    r.register(account('A'))
    r.observe('A', {
      key: 'five',
      scope: '*',
      epoch: '2',
      observedAt: 20,
      remainingWork: 3,
      source: 'fixture',
    })
    r.observe('A', {
      key: 'five',
      scope: '*',
      epoch: '1',
      observedAt: 10,
      remainingWork: 0,
      source: 'fixture',
    })
    const a = s.get<Account>('accounts', 'A')!
    expect(a.windows[0]!.epoch).toBe('2')
    expect(
      availableWork(a, 'opus', 20, [
        {
          requestId: 'r',
          session: 's',
          identity: 'A',
          epochs: { five: '1' },
          predictedWork: 100,
          createdAt: 0,
        },
      ]),
    ).toBe(3)
    s.close()
  })
  it('A-011 A-012 A-032 A-034 migration fences stale generations and never bypasses suspension', () => {
    const s = new StateStore(':memory:')
    const r = new StickyRouter(s)
    r.register(account('A'))
    r.register(account('B'))
    const first = r.route(req('s'))
    r.release('s')
    expect(() => r.migrate(req('s'), 'quota', true)).toThrow('QUOTA_MIGRATION_UNCONFIRMED')
    r.observe(first.identity, {
      key: 'five',
      scope: '*',
      epoch: '1',
      observedAt: 1,
      hardBlockedUntil: 50,
      source: 'fixture',
    })
    const next = r.migrate(req('s'), 'quota', true)
    expect(next.identity).not.toBe(first.identity)
    expect(next.generation).toBe(2)
    expect(() => r.fence('s', 1)).toThrow('STALE_GENERATION')
    expect(r.route(req('s')).identity).toBe(next.identity)
    expect(() => r.migrate(req('s'), 'suspension' as 'quota', true)).toThrow('UNSAFE_MIGRATION')
    s.close()
  })
  it('A-031 records distinct IDs separately, refuses duplicate effects and reconciles authoritative receipts', () => {
    const s = new StateStore(':memory:')
    const l = new ToolLedger(s)
    l.propose('s', 't', 'call1', { x: 1 })
    l.propose('s', 't', 'call2', { x: 1 })
    expect(() => l.propose('s', 't', 'call1', { x: 1 })).toThrow('TOOL_ALREADY_PROPOSED')
    expect(() => l.propose('s', 't', 'call1', { x: 2 })).toThrow('TOOL_ARGUMENT_MISMATCH')
    expect(l.unresolved('s')).toHaveLength(2)
    l.settle('s', 'call1', false)
    expect(l.unresolved('s')).toHaveLength(1)
    s.close()
  })
  it('A-006 separates profiles and refuses every known alternate billing route', () => {
    expect(
      billingConflicts({ ANTHROPIC_API_KEY: 'fixture', CLAUDE_CODE_USE_VERTEX: '1' }),
    ).toHaveLength(2)
    const env = profileEnvironment('/tmp/profile', {
      HOME: '/tmp/home',
      ANTHROPIC_API_KEY: 'fixture',
    })
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/profile')
  })
  it('A-025 A-027 projects the real DSH 0.2 system-role slot without promoting tool text', () => {
    const result = prepareDshRequest({
      provider: 'claude-sdk-local',
      model: 'opus',
      messages: [
        {
          id: 's' as never,
          role: 'system',
          source: { kind: 'system-prompt' },
          content: [{ type: 'text', text: 'real system' }],
        },
        { role: 'user', content: [{ type: 'text', text: 'data' }] },
      ],
    })
    expect(result.system).toBe('real system')
    expect(result.messages).toHaveLength(1)
  })
  it('A-010 A-040 persists sticky identity and rejects two writers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'provider-state-test-'))
    try {
      const s = new StateStore(dir)
      const r = new StickyRouter(s)
      r.register(account('A'))
      r.route(req('session'))
      expect(() => new StateStore(dir)).toThrow('STATE_IN_USE')
      s.close()
      const reopened = new StateStore(dir)
      expect(reopened.get<Binding>('bindings', 'session')?.identity).toBe('A')
      expect(reopened.list('reservations')).toHaveLength(0)
      reopened.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('100 seeds x 1000 events agrees with an independent sticky-state model', () => {
    for (let seed = 1; seed <= 100; seed++) {
      let rng = seed
      const rand = () => {
        rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0
        return rng
      }
      const s = new StateStore(':memory:')
      const r = new StickyRouter(s)
      const model = new Map<string, string>()
      const enabled = new Map<string, boolean>()
      for (let i = 0; i < 3; i++) {
        r.register(account(String(i)))
        enabled.set(String(i), true)
      }
      for (let event = 0; event < 1000; event++) {
        const key = 's' + (rand() % 20),
          identity = String(rand() % 3)
        if (event % 7 === 0) {
          const a = s.get<Account>('accounts', identity)!
          a.state = a.state === 'DISABLED' ? 'READY' : 'DISABLED'
          enabled.set(identity, a.state === 'READY')
          s.set('accounts', identity, a)
        }
        const previous = model.get(key),
          shouldBlock =
            previous !== undefined ? !enabled.get(previous) : ![...enabled.values()].some(Boolean)
        if (shouldBlock) expect(() => r.route(req(key, event))).toThrow()
        else {
          const b = r.route(req(key, event))
          if (previous !== undefined) expect(b.identity).toBe(previous)
          else model.set(key, b.identity)
          expect(enabled.get(b.identity)).toBe(true)
          r.release(key)
        }
        expect(s.list('reservations')).toHaveLength(0)
      }
      s.close()
    }
  }, 30000)
})
