import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { BridgeManager, defaultQueryFactory, type ClaudeQueryFactory } from '../bridge.js'
import type { ResolvedConfig } from '../index.js'
import type { AttachmentReader } from '../content.js'
import { StateStore } from '../storage/store.js'
import { StickyRouter, blockedUntil, type RouteRequest } from '../routing/router.js'
import { RouteBlocked, type Account, type Binding } from '../routing/types.js'
import { ToolLedger } from './ledger.js'
import { assertAccount } from '../auth/official.js'
import { canonicalToolJson } from '../json.js'
import { messageFingerprint } from '../replay.js'
import { CapacitySignal, KeyedQueue, ProviderCircuit, abortable } from '../routing/control.js'
import { UsageHistory, addUsage, type UsageRecord } from '../metrics/history.js'
import { shadowForecast } from '../routing/forecast.js'
export function defaultStateDirectory(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'claude-sdk-local')
}
export function prepareDshRequest(options: GenerateOptions): GenerateOptions {
  const prompts: string[] = [],
    messages = [...options.messages]
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
export interface ManagedBridge {
  stream(options: GenerateOptions, model: string): AsyncIterable<StreamChunk>
  dispose(): Promise<void>
}
export interface ProviderDependencies {
  authenticate?: typeof assertAccount
  createManager?: (
    account: Account,
    config: ResolvedConfig,
    observe: (event: SDKMessage) => void,
  ) => ManagedBridge
  now?: () => number
  requestTimeoutMs?: number
  maxAttempts?: number
}
export interface AttemptObservation {
  failure?: 'quota' | 'auth' | 'suspended' | 'request' | 'server' | 'temporary' | 'billing'
  retryAt?: number
  sdkRetries: number
}
/** Typed official events, never text-matched account rotation. */
export function observeSdk(
  store: StateStore,
  router: StickyRouter,
  binding: Binding,
  state: AttemptObservation,
  event: SDKMessage,
  now: number,
): void {
  router.fence(binding.key, binding.generation)
  if (event.type === 'rate_limit_event') {
    const info = event.rate_limit_info,
      account = store.get<Account>('accounts', binding.identity)!
    if (
      info.isUsingOverage ||
      info.overageInUse ||
      info.errorCode === 'credits_required' ||
      info.rateLimitType === 'overage'
    ) {
      delete account.extraUsageOffConfirmedAt
      account.state = 'AUTH_REQUIRED'
      store.set('accounts', account.identity, account)
      state.failure = 'billing'
      throw new RouteBlocked('EXTRA_USAGE_DETECTED')
    }
    const key = info.rateLimitType ?? 'unknown',
      reset = info.resetsAt === undefined ? undefined : info.resetsAt * 1000
    router.observe(binding.identity, {
      key,
      scope: key.includes('opus') ? 'opus' : key.includes('sonnet') ? 'sonnet' : '*',
      epoch: String(reset ?? 'unknown'),
      observedAt: now,
      source: 'sdk',
      ...(reset === undefined ? {} : { resetsAt: reset }),
      ...(info.utilization === undefined ? {} : { utilization: info.utilization }),
      ...(info.status === 'rejected' ? { hardBlockedUntil: reset ?? Number.MAX_SAFE_INTEGER } : {}),
    })
    if (info.status === 'rejected') {
      state.failure = 'quota'
      if (reset !== undefined) state.retryAt = reset
    }
  }
  if (event.type === 'system' && event.subtype === 'api_retry') {
    state.sdkRetries++
    if (event.error === 'server_error' || event.error === 'overloaded') state.failure = 'server'
    if (event.error === 'rate_limit' && state.failure !== 'quota') {
      state.failure = 'temporary'
      state.retryAt = now + Math.max(0, event.retry_delay_ms)
    }
    // The SDK owns its retry delay; outer layers share a strict attempt ceiling.
    if (event.attempt >= 3) throw new RouteBlocked('SDK_RETRY_BUDGET_EXHAUSTED')
  }
  if (event.type === 'assistant' && event.error) {
    if (['account_on_hold', 'oauth_org_not_allowed', 'verification_required'].includes(event.error))
      state.failure = 'suspended'
    else if (['authentication_failed', 'cloud_credential_error'].includes(event.error))
      state.failure = 'auth'
    else if (event.error === 'billing_error') state.failure = 'billing'
    else if (['invalid_request', 'model_not_found', 'max_output_tokens'].includes(event.error))
      state.failure = 'request'
    else if (['server_error', 'overloaded'].includes(event.error)) state.failure = 'server'
    else if (event.error === 'rate_limit' && state.failure !== 'quota') state.failure = 'temporary'
  }
}
export class SubscriptionProvider {
  #store: StateStore | undefined
  #managers = new Map<
    string,
    { generation: number; manager: ManagedBridge; state: AttemptObservation }
  >()
  #sessions = new KeyedQueue()
  #auth = new KeyedQueue()
  #capacity = new CapacitySignal()
  #controllers = new Set<AbortController>()
  #closed = false
  #authPending = 0
  #pending = new Map<string, { phase: string; identity?: string }>()
  pendingRequests() {
    return [...this.#pending.values()]
  }
  readonly now: () => number
  constructor(
    readonly subprocess: SubprocessRuntime,
    readonly config: ResolvedConfig,
    readonly attachments?: AttachmentReader,
    readonly dependencies: ProviderDependencies = {},
  ) {
    this.now = dependencies.now ?? Date.now
  }
  get store(): StateStore {
    if (this.#closed) throw new RouteBlocked('PROVIDER_CLOSED')
    return (this.#store ??= new StateStore(this.config.stateDirectory || defaultStateDirectory()))
  }
  defaultModel(): string {
    return this.store.get<string>('preferences', 'default-model') ?? this.config.defaultModel
  }
  accounts(): Account[] {
    return this.store.list<Account>('accounts')
  }
  #closeIfIdle(): void {
    if (this.#closed && this.#controllers.size === 0 && this.#authPending === 0) {
      this.#store?.close()
      this.#store = undefined
    }
  }
  async #drop(key: string): Promise<void> {
    const holder = this.#managers.get(key)
    this.#managers.delete(key)
    await holder?.manager.dispose()
  }
  async #route(
    router: StickyRouter,
    req: RouteRequest,
    deadline: number,
    signal: AbortSignal,
  ): Promise<Binding> {
    while (true) {
      req.now = this.now()
      const bound = router.store.get<Binding>('bindings', req.session)
      this.#pending.set(req.requestId, {
        phase: 'waiting-for-capacity',
        ...(bound ? { identity: bound.identity } : {}),
      })
      try {
        return router.route(req)
      } catch (error) {
        if (!(error instanceof RouteBlocked)) throw error
        if (error.code === 'BOUND_ACCOUNT_COOLDOWN') {
          try {
            router.migrate(req, 'quota', true)
            continue
          } catch (migration) {
            if (!(migration instanceof RouteBlocked) || migration.code !== 'POOL_UNAVAILABLE')
              throw migration
          }
        }
        const canWait =
          error.code === 'ACCOUNT_QUEUE' ||
          (error.code === 'POOL_UNAVAILABLE' &&
            this.accounts().some(
              (a) =>
                ['READY', 'DRAINING', 'COOLDOWN'].includes(a.state) &&
                a.models[req.model] !== undefined &&
                (req.effort === undefined || a.models[req.model]!.includes(req.effort)) &&
                blockedUntil(a, req.model, req.now) === undefined,
            ))
        const resetWait =
          error.retryAt !== undefined && error.retryAt > req.now && error.retryAt < deadline
            ? error.retryAt - req.now
            : undefined
        if (!canWait && resetWait === undefined) throw error
        if (req.now >= deadline) throw new RouteBlocked('REQUEST_DEADLINE')
        await this.#capacity.wait(Math.min(deadline - req.now, resetWait ?? 1000), signal)
      }
    }
  }
  async *stream(raw: GenerateOptions, model: string): AsyncIterable<StreamChunk> {
    const options = prepareDshRequest(raw),
      store = this.store,
      router = new StickyRouter(store),
      ledger = new ToolLedger(store),
      history = new UsageHistory(store),
      circuit = new ProviderCircuit(store)
    const controller = new AbortController()
    this.#controllers.add(controller)
    const timeoutMs = this.dependencies.requestTimeoutMs ?? this.config.requestTimeoutMs
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = AbortSignal.any([
      controller.signal,
      timeout,
      ...(options.signal ? [options.signal] : []),
    ])
    const key = store.hash(
      JSON.stringify([
        process.cwd(),
        options.sessionId ?? randomUUID(),
        options.purpose ?? 'conversation',
      ]),
    )
    const requestId = randomUUID(),
      startedAt = this.now(),
      deadline = startedAt + timeoutMs
    const req: RouteRequest = {
      session: key,
      requestId,
      model,
      ...(options.reasoningEffort ? { effort: String(options.reasoningEffort) } : {}),
      now: startedAt,
    }
    let unlock: (() => void) | undefined,
      binding: Binding | undefined,
      usage: TokenUsage = { inputTokens: 0, outputTokens: 0 },
      outcome: UsageRecord['outcome'] = 'error',
      firstOutputAt: number | undefined,
      attempts = 0,
      sdkRetries = 0,
      attemptRetries = 0,
      finished = false,
      attemptRecorded = false
    const recordAttempt = () => {
      if (!binding || attemptRecorded) return
      history.record({
        id: requestId + ':' + attempts,
        session: key,
        identity: binding.identity,
        model,
        ...(req.effort === undefined ? {} : { effort: req.effort }),
        startedAt,
        finishedAt: this.now(),
        ...(firstOutputAt === undefined ? {} : { firstOutputAt }),
        outcome,
        attempts: 1,
        usage,
        quotaEpochs: Object.fromEntries(
          (store.get<Account>('accounts', binding.identity)?.windows ?? []).map((w) => [
            w.key,
            w.epoch,
          ]),
        ),
        sdkRetries: attemptRetries,
      })
      attemptRecorded = true
    }
    try {
      this.#pending.set(requestId, { phase: 'waiting-for-session' })
      unlock = await this.#sessions.acquire(key, signal)
      if (store.get('meta', 'auth-mutation')) throw new RouteBlocked('AUTH_BUSY')
      circuit.enter(requestId, this.now())
      for (const m of options.messages)
        if (
          m.role === 'tool' &&
          ledger.unresolved(key).some((e) => e.callId === String(m.toolCallId))
        )
          ledger.settle(key, String(m.toolCallId), m.isError ?? false)
      const previous = store.get<Binding>('bindings', key)
      if (previous) {
        previous.pendingTools = ledger.unresolved(key).map((e) => e.callId)
        store.set('bindings', key, previous)
      }
      if (ledger.unresolved(key).length) throw new RouteBlocked('OUTCOME_UNKNOWN')
      if (!previous && this.accounts().length) {
        try {
          const prediction = shadowForecast(
            this.accounts(),
            req,
            store.list('reservations'),
            history.recent().map((x) => ({
              at: x.startedAt,
              work: 1,
              durationMs: Math.max(1, x.finishedAt - x.startedAt),
            })),
          )
          store.set('shadow', key, prediction)
        } catch (error) {
          if (!(error instanceof RouteBlocked)) throw error
        }
      }
      const visited = new Set<string>()
      while (attempts < (this.dependencies.maxAttempts ?? 3)) {
        if (signal.aborted) throw new RouteBlocked(timeout.aborted ? 'REQUEST_DEADLINE' : 'ABORTED')
        binding = await this.#route(router, req, deadline, signal)
        attempts++
        usage = { inputTokens: 0, outputTokens: 0 }
        attemptRetries = 0
        attemptRecorded = false
        if (visited.has(binding.identity)) throw new RouteBlocked('ATTEMPT_BUDGET_EXHAUSTED')
        visited.add(binding.identity)
        circuit.enter(requestId, this.now())
        const account = store.get<Account>('accounts', binding.identity)!
        this.#pending.set(requestId, {
          phase: 'checking-official-login',
          identity: account.identity,
        })
        const releaseAuth = await this.#auth.acquire(account.identity, signal)
        this.#authPending++
        const authPromise = Promise.resolve()
          .then(() =>
            (this.dependencies.authenticate ?? assertAccount)(
              store,
              this.config.claudeCommand,
              account,
            ),
          )
          .finally(() => {
            releaseAuth()
            this.#authPending--
            this.#closeIfIdle()
          })
        await abortable(authPromise, signal)
        this.#pending.set(requestId, { phase: 'generating', identity: account.identity })
        let holder = this.#managers.get(key)
        if (holder && holder.generation !== binding.generation) {
          await this.#drop(key)
          holder = undefined
        }
        const state: AttemptObservation = { sdkRetries: 0 }
        if (!holder) {
          const bound = { ...binding },
            created = {
              generation: binding.generation,
              state,
              manager: undefined as unknown as ManagedBridge,
            }
          const observe = (event: SDKMessage) =>
            observeSdk(store, router, bound, created.state, event, this.now())
          const configuration = {
            ...this.config,
            profileRef: account.profileRef,
            portableColdStart: true,
          }
          if (this.dependencies.createManager)
            created.manager = this.dependencies.createManager(account, configuration, observe)
          else {
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
            created.manager = new BridgeManager(
              this.subprocess,
              configuration,
              factory,
              this.attachments,
            )
          }
          holder = created
          this.#managers.set(key, created)
        } else holder.state = state
        let terminal: Extract<StreamChunk, { type: 'finish' }> | undefined,
          thrown: unknown,
          visible = false
        try {
          for await (const chunk of holder.manager.stream({ ...options, signal }, model)) {
            router.fence(key, binding.generation)
            if (signal.aborted) throw new RouteBlocked('ABORTED')
            if (chunk.type === 'usage') usage = addUsage(usage, chunk.usage)
            if (chunk.type === 'finish') {
              terminal = chunk
              continue
            }
            if (chunk.type !== 'usage') {
              visible = true
              firstOutputAt ??= this.now()
              if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
                ledger.propose(
                  key,
                  hash(options.messages.map((m) => m.id ?? null)),
                  String(chunk.block.id),
                  JSON.parse(chunk.block.arguments),
                )
                binding.pendingTools = ledger.unresolved(key).map((e) => e.callId)
                store.set('bindings', key, binding)
              }
            }
            yield chunk
          }
        } catch (error) {
          thrown = error
        }
        attemptRetries = state.sdkRetries
        sdkRetries += state.sdkRetries
        if (thrown !== undefined || terminal?.reason.kind === 'error') {
          if (
            state.failure === 'auth' ||
            state.failure === 'suspended' ||
            state.failure === 'billing'
          ) {
            account.state = state.failure === 'suspended' ? 'SUSPENDED' : 'AUTH_REQUIRED'
            if (state.failure === 'billing') delete account.extraUsageOffConfirmedAt
            store.set('accounts', account.identity, account)
          }
          if (
            state.failure === 'server' ||
            (thrown instanceof Error &&
              'code' in thrown &&
              thrown.code === 'CLAUDE_TRANSPORT_ERROR')
          )
            circuit.fail(this.now())
          if (
            state.failure === 'quota' &&
            !visible &&
            ledger.unresolved(key).length === 0 &&
            sdkRetries === 0 &&
            attempts < (this.dependencies.maxAttempts ?? 3) &&
            !signal.aborted
          ) {
            recordAttempt()
            router.release(requestId)
            this.#capacity.notify()
            await this.#drop(key)
            router.migrate({ ...req, now: this.now() }, 'quota', true)
            continue
          }
          if (thrown !== undefined) throw thrown
        }
        if (!terminal) throw new RouteBlocked('MISSING_TERMINAL')
        if (terminal.reason.kind === 'stop' || terminal.reason.kind === 'tool-calls')
          circuit.success()
        binding.historyRevision = messageFingerprint(options.messages)
        binding.systemDigest = hash(options.system ?? '')
        binding.toolDigest = hash(options.tools ?? [])
        binding.committedCursor = options.messages.length
        binding.runtimeVersion = 'sdk:0.3.286'
        store.set('bindings', key, binding)
        outcome =
          terminal.reason.kind === 'stop'
            ? 'response'
            : terminal.reason.kind === 'tool-calls'
              ? 'tool-boundary'
              : terminal.reason.kind === 'aborted'
                ? 'aborted'
                : 'error'
        if (outcome === 'error' || outcome === 'aborted') await this.#drop(key)
        finished = true
        yield terminal
        return
      }
      throw new RouteBlocked('ATTEMPT_BUDGET_EXHAUSTED')
    } catch (error) {
      if (signal.aborted) {
        outcome = 'aborted'
        if (unlock) {
          const old = store.get<Binding>('bindings', key)
          if (old) {
            old.generation++
            old.reason = 'cancelled'
            store.set('bindings', key, old)
          }
        }
      }
      if (unlock) await this.#drop(key)
      const code = timeout.aborted
        ? 'REQUEST_DEADLINE'
        : error instanceof RouteBlocked
          ? error.code
          : error instanceof Error && 'code' in error && typeof error.code === 'string'
            ? error.code
            : 'SUBSCRIPTION_PROVIDER_FAILED'
      finished = true
      yield {
        type: 'finish',
        reason: {
          kind: outcome === 'aborted' ? 'aborted' : 'error',
          failure: {
            code,
            message: code,
            ...(error instanceof RouteBlocked &&
            error.retryAt !== undefined &&
            error.retryAt < Number.MAX_SAFE_INTEGER
              ? { providerRetryAfterMs: Math.max(0, error.retryAt - this.now()) }
              : {}),
          },
        },
      }
    } finally {
      if (!finished) {
        controller.abort()
        if (unlock) await this.#drop(key)
        outcome = 'aborted'
      }
      recordAttempt()
      router.release(requestId)
      circuit.release(requestId)
      this.#capacity.notify()
      unlock?.()
      this.#controllers.delete(controller)
      this.#pending.delete(requestId)
      this.#closeIfIdle()
    }
  }
  async dispose(): Promise<void> {
    this.#closed = true
    for (const c of this.#controllers) c.abort()
    this.#capacity.notify()
    await Promise.all([...this.#managers.values()].map((x) => x.manager.dispose()))
    this.#managers.clear()
    this.#closeIfIdle()
  }
}
