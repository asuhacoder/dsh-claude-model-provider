import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { BridgeManager, defaultQueryFactory, type ClaudeQueryFactory } from '../bridge.js'
import type { ResolvedConfig } from '../index.js'
import type { AttachmentReader } from '../content.js'
import { StateStore } from '../storage/store.js'
import { StickyRouter } from '../routing/router.js'
import { RouteBlocked, type Account, type Binding } from '../routing/types.js'
import { ToolLedger } from './ledger.js'
import { assertAccount } from '../auth/official.js'
import { canonicalToolJson } from '../json.js'
import { messageFingerprint } from '../replay.js'
export function defaultStateDirectory(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'claude-sdk-local')
}
export function prepareDshRequest(options: GenerateOptions): GenerateOptions {
  const prompts: string[] = []
  const messages = [...options.messages]
  if (options.system) prompts.push(options.system)
  while (messages[0]?.role === 'system') {
    const m = messages.shift()!
    if (m.content.some((b) => b.type !== 'text'))
      throw new RouteBlocked('UNSUPPORTED_SYSTEM_CONTENT')
    prompts.push(m.content.map((b) => (b.type === 'text' ? b.text : '')).join(''))
  }
  if (messages.some((m) => m.role === 'system')) throw new RouteBlocked('NONLEADING_SYSTEM_MESSAGE')
  return { ...options, system: prompts.join('\n\n'), messages }
}
const hash = (x: unknown) => createHash('sha256').update(canonicalToolJson(x)).digest('hex')
export class SubscriptionProvider {
  #store: StateStore | undefined
  #managers = new Map<string, { generation: number; manager: BridgeManager }>()
  #tails = new Map<string, Promise<void>>()
  constructor(
    readonly subprocess: SubprocessRuntime,
    readonly config: ResolvedConfig,
    readonly attachments?: AttachmentReader,
  ) {}
  get store(): StateStore {
    return (this.#store ??= new StateStore(this.config.stateDirectory || defaultStateDirectory()))
  }
  accounts(): Account[] {
    return this.store.list<Account>('accounts')
  }
  async *stream(raw: GenerateOptions, model: string): AsyncIterable<StreamChunk> {
    const options = prepareDshRequest(raw)
    const key = this.store.hash(
      JSON.stringify([
        process.cwd(),
        options.sessionId ?? randomUUID(),
        options.purpose ?? 'conversation',
      ]),
    )
    let release!: () => void
    const next = new Promise<void>((r) => {
      release = r
    })
    const prior = this.#tails.get(key) ?? Promise.resolve()
    const tail = prior.then(() => next)
    this.#tails.set(key, tail)
    await prior
    const requestId = randomUUID()
    const router = new StickyRouter(this.store)
    const ledger = new ToolLedger(this.store)
    const req = {
      session: key,
      requestId,
      model,
      ...(options.reasoningEffort ? { effort: String(options.reasoningEffort) } : {}),
      now: Date.now(),
    }
    try {
      if (options.signal?.aborted) throw new RouteBlocked('ABORTED')
      // DSH's committed receipts are authoritative, even after a local crash.
      for (const m of options.messages)
        if (m.role === 'tool') {
          const entries = ledger.unresolved(key).filter((e) => e.callId === String(m.toolCallId))
          if (entries.length) ledger.settle(key, String(m.toolCallId), m.isError ?? false)
        }
      const previous = this.store.get<Binding>('bindings', key)
      if (previous) {
        previous.pendingTools = ledger.unresolved(key).map((e) => e.callId)
        this.store.set('bindings', key, previous)
      }
      if (ledger.unresolved(key).length) throw new RouteBlocked('OUTCOME_UNKNOWN')
      let binding: Binding
      try {
        binding = router.route(req)
      } catch (e) {
        if (!(e instanceof RouteBlocked) || e.code !== 'BOUND_ACCOUNT_COOLDOWN') throw e
        router.migrate(req, 'quota', true)
        binding = router.route(req)
      }
      const account = this.store.get<Account>('accounts', binding.identity)!
      await assertAccount(this.store, this.config.claudeCommand, account)
      let holder = this.#managers.get(key)
      if (holder && holder.generation !== binding.generation) {
        await holder.manager.dispose()
        this.#managers.delete(key)
        holder = undefined
      }
      if (!holder) {
        const factory: ClaudeQueryFactory = (request) => {
          const q = defaultQueryFactory(request)
          return {
            setModel: (m) => q.setModel(m),
            applyFlagSettings: (s) => q.applyFlagSettings(s),
            interrupt: () => q.interrupt(),
            close: () => q.close(),
            async *[Symbol.asyncIterator]() {
              for await (const event of q) {
                observe(event)
                yield event
              }
            },
          }
        }
        const observe = (event: SDKMessage) => {
          router.fence(key, binding.generation)
          if (event.type === 'rate_limit_event') {
            const info = event.rate_limit_info
            if (info.isUsingOverage || info.overageInUse) {
              const unsafe = this.store.get<Account>('accounts', binding.identity)!
              delete unsafe.extraUsageOffConfirmedAt
              unsafe.state = 'AUTH_REQUIRED'
              this.store.set('accounts', unsafe.identity, unsafe)
              throw new RouteBlocked('EXTRA_USAGE_DETECTED')
            }
            const windowKey = info.rateLimitType ?? 'unknown'
            const reset = info.resetsAt === undefined ? undefined : info.resetsAt * 1000
            // Unknown duration stays blocked; do not fabricate a reset.
            router.observe(binding.identity, {
              key: windowKey,
              scope: windowKey.includes('opus')
                ? 'opus'
                : windowKey.includes('sonnet')
                  ? 'sonnet'
                  : '*',
              epoch: String(reset ?? 'unknown'),
              observedAt: Date.now(),
              source: 'sdk',
              ...(reset ? { resetsAt: reset } : {}),
              ...(info.utilization === undefined ? {} : { utilization: info.utilization }),
              ...(info.status === 'rejected'
                ? { hardBlockedUntil: reset ?? Number.MAX_SAFE_INTEGER }
                : {}),
            })
          }
        }
        holder = {
          generation: binding.generation,
          manager: new BridgeManager(
            this.subprocess,
            { ...this.config, profileRef: account.profileRef, portableColdStart: true },
            factory,
            this.attachments,
          ),
        }
        this.#managers.set(key, holder)
      }
      const turn = hash(options.messages.map((m) => m.id ?? null))
      const proposed: string[] = []
      for await (const chunk of holder.manager.stream(options, model)) {
        router.fence(key, binding.generation)
        if (options.signal?.aborted) throw new RouteBlocked('ABORTED')
        if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
          ledger.propose(key, turn, String(chunk.block.id), JSON.parse(chunk.block.arguments))
          proposed.push(String(chunk.block.id))
          binding.pendingTools = [...proposed]
          this.store.set('bindings', key, binding)
        }
        if (chunk.type === 'finish') {
          binding.historyRevision = messageFingerprint(options.messages)
          binding.systemDigest = hash(options.system ?? '')
          binding.toolDigest = hash(options.tools ?? [])
          binding.committedCursor = options.messages.length
          binding.runtimeVersion = 'sdk:0.3.286'
          this.store.set('bindings', key, binding)
        }
        yield chunk
      }
    } catch (e) {
      const holder = this.#managers.get(key)
      this.#managers.delete(key)
      await holder?.manager.dispose()
      const code = e instanceof RouteBlocked ? e.code : 'SUBSCRIPTION_PROVIDER_FAILED'
      yield {
        type: 'finish',
        reason: {
          kind: options.signal?.aborted ? 'aborted' : 'error',
          failure: {
            code,
            message: code,
            ...(e instanceof RouteBlocked &&
            e.retryAt !== undefined &&
            e.retryAt < Number.MAX_SAFE_INTEGER
              ? { providerRetryAfterMs: Math.max(0, e.retryAt - Date.now()) }
              : {}),
          },
        },
      }
    } finally {
      router.release(requestId)
      release()
      if (this.#tails.get(key) === tail) this.#tails.delete(key)
    }
  }
  async dispose(): Promise<void> {
    await Promise.all([...this.#managers.values()].map((x) => x.manager.dispose()))
    this.#managers.clear()
    this.#store?.close()
    this.#store = undefined
  }
}
