import { RouteBlocked } from './types.js'
import { StateStore } from '../storage/store.js'

/** Abortable FIFO lock; a cancelled waiter never owns a lease. */
export class KeyedQueue {
  #tails = new Map<string, Promise<void>>()
  async acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new RouteBlocked('ABORTED')
    const prior = this.#tails.get(key) ?? Promise.resolve()
    let unlock!: () => void
    const own = new Promise<void>((resolve) => {
      unlock = resolve
    })
    const tail = prior.then(() => own)
    this.#tails.set(key, tail)
    const cleanup = () => {
      unlock()
      if (this.#tails.get(key) === tail) this.#tails.delete(key)
    }
    try {
      await abortable(prior, signal)
      return cleanup
    } catch (error) {
      void prior.then(cleanup)
      throw error
    }
  }
}
export async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) throw new RouteBlocked('ABORTED')
  let abort!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new RouteBlocked('ABORTED'))
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([promise, cancelled])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
/** Wakes on local capacity changes; the timer only handles deadlines/reset, never inference. */
export class CapacitySignal {
  #waiters = new Set<() => void>()
  async wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
    let wake!: () => void
    const promise = new Promise<void>((resolve) => {
      wake = resolve
      this.#waiters.add(wake)
    })
    const timer = setTimeout(wake, Math.max(1, milliseconds))
    try {
      await abortable(promise, signal)
    } finally {
      clearTimeout(timer)
      this.#waiters.delete(wake)
    }
  }
  notify(): void {
    for (const wake of this.#waiters) wake()
    this.#waiters.clear()
  }
}
interface CircuitState {
  failures: number
  lastFailure: number
  until: number
  probe?: string
}
export class ProviderCircuit {
  constructor(
    readonly store: StateStore,
    readonly threshold = 3,
    readonly backoffMs = 30_000,
  ) {}
  enter(request: string, now: number): void {
    const state = this.store.get<CircuitState>('meta', 'provider-circuit')
    if (!state || state.failures < this.threshold) return
    if (state.until > now || (state.probe && state.probe !== request))
      throw new RouteBlocked('PROVIDER_CIRCUIT_OPEN', state.until)
    state.probe = request
    this.store.set('meta', 'provider-circuit', state)
  }
  success(): void {
    this.store.delete('meta', 'provider-circuit')
  }
  fail(now: number): void {
    const old = this.store.get<CircuitState>('meta', 'provider-circuit')
    const failures = old && now - old.lastFailure < 60_000 ? old.failures + 1 : 1
    this.store.set('meta', 'provider-circuit', {
      failures,
      lastFailure: now,
      until: failures >= this.threshold ? now + this.backoffMs : 0,
    })
  }
  release(request: string): void {
    const state = this.store.get<CircuitState>('meta', 'provider-circuit')
    if (state?.probe === request) {
      delete state.probe
      this.store.set('meta', 'provider-circuit', state)
    }
  }
}
