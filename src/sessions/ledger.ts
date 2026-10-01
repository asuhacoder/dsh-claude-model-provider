import { createHash } from 'node:crypto'
import { canonicalToolJson } from '../json.js'
import { StateStore } from '../storage/store.js'
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
export class ToolLedger {
  constructor(readonly store: StateStore) {}
  propose(session: string, turn: string, callId: string, args: unknown): void {
    const key = JSON.stringify([session, turn, callId])
    const argsDigest = createHash('sha256').update(canonicalToolJson(args)).digest('hex')
    const old = this.store
      .list<ToolEntry>('ledger')
      .find((entry) => entry.session === session && entry.callId === callId)
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
    const matches = this.store
      .list<ToolEntry>('ledger')
      .filter((e) => e.session === session && e.callId === callId)
    if (matches.length !== 1) throw new Error('TOOL_RECEIPT_UNMATCHED')
    const entry = matches[0]!
    entry.state = failed ? 'FAILED' : 'COMMITTED'
    this.store.set('ledger', entry.key, entry)
  }
  unresolved(session: string): ToolEntry[] {
    return this.store
      .list<ToolEntry>('ledger')
      .filter((e) => e.session === session && !['COMMITTED', 'FAILED'].includes(e.state))
  }
}
