/**
 * The repository refresh coordinator.
 *
 * Before 2026-09-02 every trigger — a watcher burst, a save, a stage click, a checkout — called
 * `refreshRepo()` directly, each one firing six IPC calls in parallel with no ordering. Two
 * refreshes in flight could resolve out of order and the OLDER status would overwrite the newer.
 * This class makes the refresh a resource with rules:
 *
 *   - watcher-driven requests are DEBOUNCED (default 100 ms), so a burst of writes is one read;
 *   - at most ONE fetch is in flight per coordinator (one per repository);
 *   - a request that arrives mid-flight is COALESCED into a single trailing run;
 *   - a result is applied only if the coordinator was not invalidated or disposed while it ran,
 *     so a project switch can never paint the old project's status over the new one;
 *   - `request(true)` runs immediately (after a mutation we caused ourselves).
 *
 * No timers of its own beyond `setTimeout`, no React, no IPC — the fetch and apply are injected,
 * which is what lets the headless suite drive it with fake clocks and out-of-order promises.
 */

export interface CoordinatorStats {
  requested: number
  runs: number
  coalesced: number
  /** Results thrown away because the coordinator was invalidated or disposed while they ran. */
  dropped: number
  lastMs: number
  inFlight: boolean
}

export interface CoordinatorTimers {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
  now: () => number
}

const REAL: CoordinatorTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now()
}

export class RefreshCoordinator<T> {
  readonly stats: CoordinatorStats = { requested: 0, runs: 0, coalesced: 0, dropped: 0, lastMs: 0, inFlight: false }
  private timer: unknown = null
  private again = false
  private generation = 0
  private disposed = false

  constructor(
    private readonly fetch: () => Promise<T>,
    private readonly apply: (value: T) => void,
    private readonly debounceMs = 100,
    private readonly timers: CoordinatorTimers = REAL
  ) {}

  /** Ask for a refresh. `immediate` skips the debounce — for a mutation this code just made. */
  request(immediate = false): void {
    if (this.disposed) return
    this.stats.requested++
    if (immediate) {
      if (this.timer !== null) {
        this.timers.clear(this.timer)
        this.timer = null
      }
      this.run()
      return
    }
    if (this.timer !== null) {
      // Already scheduled: this request rides the pending one.
      this.stats.coalesced++
      return
    }
    this.timer = this.timers.set(() => {
      this.timer = null
      this.run()
    }, this.debounceMs)
  }

  /** Forget any result still in flight (the repository or project changed under us). */
  invalidate(): void {
    this.generation++
  }

  dispose(): void {
    this.disposed = true
    this.invalidate()
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
  }

  private run(): void {
    if (this.stats.inFlight) {
      // One in flight: remember to go again when it lands. Two requests become one run.
      this.again = true
      this.stats.coalesced++
      return
    }
    this.stats.inFlight = true
    this.stats.runs++
    const gen = ++this.generation
    const t0 = this.timers.now()
    this.fetch()
      .then((value) => {
        if (this.disposed || gen !== this.generation) {
          this.stats.dropped++
          return
        }
        this.apply(value)
      })
      .catch(() => {
        /* a failed read leaves the last good view in place; the next trigger retries */
      })
      .finally(() => {
        this.stats.lastMs = this.timers.now() - t0
        this.stats.inFlight = false
        if (this.again && !this.disposed) {
          this.again = false
          this.run()
        }
      })
  }
}
