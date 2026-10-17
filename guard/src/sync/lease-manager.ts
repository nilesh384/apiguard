import type { RedisStore } from "../store/redis";

export interface LeaseManagerOptions {
  leaseSize: number;
  /** Re-request a lease when local tokens drop to or below this fraction of leaseSize (0–1) */
  lowWatermark: number;
  globalLimit: number;
  windowMs: number;
  onError?: (err: unknown) => void;
}

interface LeaseEntry {
  tokens: number;
  /** True while a background refill is in flight — prevents duplicate requests */
  refilling: boolean;
}

export class LeaseManager {
  private leases = new Map<string, LeaseEntry>();

  constructor(
    private redis: RedisStore,
    private opts: LeaseManagerOptions
  ) {}

  /**
   * Consume one token from the local lease for `key`.
   * Triggers a background refill when the budget is low.
   * Returns false only when the local budget is fully exhausted.
   */
  consume(key: string, cost = 1): boolean {
    let entry = this.leases.get(key);

    if (!entry) {
      // No lease yet — kick off async fetch, optimistically allow first request
      this.refill(key);
      return true;
    }

    if (entry.tokens < cost) return false;

    entry.tokens -= cost;

    if (entry.tokens <= this.opts.leaseSize * this.opts.lowWatermark && !entry.refilling) {
      this.refill(key);
    }

    return true;
  }

  private refill(key: string): void {
    let entry = this.leases.get(key);
    if (!entry) {
      entry = { tokens: 0, refilling: true };
      this.leases.set(key, entry);
    }
    entry.refilling = true;

    this.redis
      .acquireLease(key, this.opts.globalLimit, this.opts.leaseSize, this.opts.windowMs)
      .then((granted) => {
        const e = this.leases.get(key)!;
        e.tokens += granted;
        e.refilling = false;
      })
      .catch((err) => {
        const e = this.leases.get(key);
        if (e) e.refilling = false;
        this.opts.onError?.(err);
      });
  }

  clear(): void {
    this.leases.clear();
  }

  localTokens(key: string): number {
    return this.leases.get(key)?.tokens ?? 0;
  }
}
