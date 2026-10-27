import { createHash } from 'node:crypto'
import { canonicalToolJson } from '../json.js'
import { OPEN_LEDGER, StateStore } from '../storage/store.js'
export type ToolState =
  'PROPOSED' | 'AUTHORIZED' | 'RUNNING' | 'COMMITTED' | 'FAILED' | 'OUTCOME_UNKNOWN'
export interface ToolEntry {
  key: string
  session: string
  turn: string
  callId: string
  argsDigest: string
  state: ToolState
}
const settled = new Set<ToolState>(['COMMITTED', 'FAILED'])
export class ToolLedger {
  constructor(readonly store: StateStore) {}
  propose(session: string, turn: string, callId: string, args: unknown): void {
    const key = JSON.stringify([session, turn, callId])
    const argsDigest = createHash('sha256').update(canonicalToolJson(args)).digest('hex')
    const old = this.#byCall(session, callId)[0]
    if (old)
      throw new Error(
        old.argsDigest !== argsDigest ? 'TOOL_ARGUMENT_MISMATCH' : 'TOOL_ALREADY_PROPOSED',
      )
    this.store.set('ledger', key, {
      key,
      session,
      turn,
      callId,
      argsDigest,
      state: 'PROPOSED',
    } satisfies ToolEntry)
  }
  settle(session: string, callId: string, failed: boolean): void {
    const matches = this.#byCall(session, callId)
    const entry = matches[0]
    if (matches.length !== 1 || entry === undefined) throw new Error('TOOL_RECEIPT_UNMATCHED')
    entry.state = failed ? 'FAILED' : 'COMMITTED'
    this.store.set('ledger', entry.key, entry)
    this.store.pruneSettledLedger()
  }
  unresolved(session: string): ToolEntry[] {
    if (!this.store.indexed)
      return this.store
        .list<ToolEntry>('ledger')
        .filter((entry) => entry.session === session && !settled.has(entry.state))
    return this.store.queryValues<ToolEntry>(
      `SELECT value FROM state INDEXED BY state_ledger_open WHERE ${OPEN_LEDGER} AND k1 = ? ORDER BY key`,
      session,
    )
  }
  #byCall(session: string, callId: string): ToolEntry[] {
    if (!this.store.indexed)
      return this.store
        .list<ToolEntry>('ledger')
        .filter((entry) => entry.session === session && entry.callId === callId)
    return this.store.queryValues<ToolEntry>(
      `SELECT value FROM state INDEXED BY state_ledger_call
       WHERE collection = 'ledger' AND k1 = ? AND k2 = ? ORDER BY key`,
      session,
      callId,
    )
  }
}
