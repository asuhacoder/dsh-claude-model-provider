/** A single-consumer async queue used for SDK stdin and stdout framing. */
export class AsyncQueue<T> implements AsyncIterableIterator<T> {
  readonly #values: T[] = []
  readonly #waiters: Array<{
    resolve: (result: IteratorResult<T>) => void
    reject: (error: unknown) => void
  }> = []
  #closed = false
  #failure: unknown

  get closed(): boolean {
    return this.#closed
  }

  push(value: T): void {
    if (this.#closed) throw new Error('cannot push to a closed async queue')
    const waiter = this.#waiters.shift()
    if (waiter === undefined) this.#values.push(value)
    else waiter.resolve({ done: false, value })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined })
  }

  fail(error: unknown): void {
    if (this.#closed) return
    this.#failure = error
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error)
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.#values.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (this.#closed) {
      return this.#failure === undefined
        ? Promise.resolve({ done: true, value: undefined })
        : Promise.reject(this.#failure)
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.#waiters.push({ resolve, reject })
    })
  }

  return(): Promise<IteratorResult<T>> {
    this.close()
    return Promise.resolve({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this
  }
}
