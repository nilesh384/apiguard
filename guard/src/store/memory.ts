import { BucketState, newBucketState } from "../algorithms/token-bucket";
import { WindowState, newWindowState } from "../algorithms/sliding-window";

type AlgoState = BucketState | WindowState;

interface Entry {
  state: AlgoState;
  algo: "token-bucket" | "sliding-window";
  expiresAt: number;
}

export class MemoryStore {
  private map = new Map<string, Entry>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(evictionIntervalMs = 60_000) {
    this.timer = setInterval(() => this.evict(), evictionIntervalMs);
    // Don't block process exit
    if (this.timer.unref) this.timer.unref();
  }

  getOrCreate(
    key: string,
    algo: "token-bucket" | "sliding-window",
    capacity: number,
    windowMs: number,
    nowMs = Date.now()
  ): AlgoState {
    const existing = this.map.get(key);
    if (existing && existing.expiresAt > nowMs) return existing.state;

    const state: AlgoState =
      algo === "token-bucket" ? newBucketState(capacity, nowMs) : newWindowState(nowMs);

    this.map.set(key, { state, algo, expiresAt: nowMs + windowMs * 2 });
    return state;
  }

  /** Refresh TTL on access so active keys don't get evicted */
  touch(key: string, windowMs: number, nowMs = Date.now()) {
    const e = this.map.get(key);
    if (e) e.expiresAt = nowMs + windowMs * 2;
  }

  evict(nowMs = Date.now()) {
    for (const [key, entry] of this.map) {
      if (entry.expiresAt <= nowMs) this.map.delete(key);
    }
  }

  size() {
    return this.map.size;
  }

  destroy() {
    if (this.timer) clearInterval(this.timer);
    this.map.clear();
  }
}
