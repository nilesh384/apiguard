import { GuardConfig, NormalizedLimit, normalizeLimit } from "./config";
import { MemoryStore } from "./store/memory";
import { tokenBucketCheck } from "./algorithms/token-bucket";
import { BucketState } from "./algorithms/token-bucket";
import { slidingWindowCheck } from "./algorithms/sliding-window";
import { WindowState } from "./algorithms/sliding-window";

export interface CheckResult {
  allowed: boolean;
  /** Matched route key, e.g. "POST /login" or "default" */
  matchedRule: string;
  remaining?: number;
}

export class Guard {
  private store: MemoryStore;
  private rules: Map<string, NormalizedLimit>;
  private onFailure: "fail-open" | "fail-closed";

  constructor(config: GuardConfig) {
    this.store = new MemoryStore(config.evictionIntervalMs);
    this.onFailure = config.onFailure ?? "fail-open";
    this.rules = new Map();

    for (const [route, limit] of Object.entries(config.limits)) {
      this.rules.set(route, normalizeLimit(limit));
    }
  }

  /**
   * Synchronous hot-path check. No awaits, no allocations beyond Map lookup.
   * @param identifier  Pre-extracted key (IP, user ID, composite)
   * @param route       e.g. "POST /login" — matched against config keys
   * @param cost        Token cost for this request (default 1)
   */
  check(identifier: string, route: string, cost = 1): CheckResult {
    const matchedRule = this.matchRule(route);
    const limit = this.rules.get(matchedRule)!;
    const storeKey = `${matchedRule}:${identifier}`;

    try {
      const state = this.store.getOrCreate(
        storeKey,
        limit.algorithm,
        limit.rate,
        limit.windowMs
      );
      this.store.touch(storeKey, limit.windowMs);

      let allowed: boolean;
      if (limit.algorithm === "token-bucket") {
        allowed = tokenBucketCheck(state as BucketState, limit.rate, limit.windowMs, cost);
      } else {
        allowed = slidingWindowCheck(state as WindowState, limit.rate, limit.windowMs, cost);
      }

      return { allowed, matchedRule };
    } catch {
      return { allowed: this.onFailure === "fail-open", matchedRule };
    }
  }

  private matchRule(route: string): string {
    if (this.rules.has(route)) return route;
    return "default";
  }

  destroy() {
    this.store.destroy();
  }
}

export function createGuard(config: GuardConfig): Guard {
  return new Guard(config);
}
