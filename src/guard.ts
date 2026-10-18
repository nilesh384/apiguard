import { GuardConfig, NormalizedLimit, normalizeLimit } from "./config";
import { MemoryStore } from "./store/memory";
import { RedisStore } from "./store/redis";
import { LeaseManager } from "./sync/lease-manager";
import { Denylist } from "./sync/denylist";
import { RiskScorer, RiskResult } from "./risk/scorer";
import type { SignalContext } from "./risk/signals";
import { tokenBucketCheck, BucketState } from "./algorithms/token-bucket";
import { slidingWindowCheck, WindowState } from "./algorithms/sliding-window";

export interface CheckResult {
  allowed: boolean;
  matchedRule: string;
  denylisted?: boolean;
  risk?: RiskResult;
}

export class Guard {
  private store: MemoryStore;
  private rules: Map<string, NormalizedLimit>;
  private onFailure: "fail-open" | "fail-closed";
  private scorer?: RiskScorer;

  // distributed-mode fields
  private leaseManagers?: Map<string, LeaseManager>;
  private denylist?: Denylist;

  constructor(config: GuardConfig) {
    this.store = new MemoryStore(config.evictionIntervalMs);
    this.onFailure = config.onFailure ?? "fail-open";
    this.rules = new Map();

    for (const [route, limit] of Object.entries(config.limits)) {
      this.rules.set(route, normalizeLimit(limit));
    }

    if (config.risk) {
      this.scorer = new RiskScorer(config.risk);
    }

    if (config.redis) {
      const { client, leaseSize = 50, lowWatermark = 0.2, denylist = true } = config.redis;
      const redisStore = new RedisStore(client);

      this.leaseManagers = new Map();
      for (const [route, limit] of this.rules) {
        this.leaseManagers.set(
          route,
          new LeaseManager(redisStore, {
            leaseSize,
            lowWatermark,
            globalLimit: limit.rate,
            windowMs: limit.windowMs,
            onError: config.onError,
          })
        );
      }

      if (denylist) {
        this.denylist = new Denylist(client, config.onError);
        this.denylist.subscribe().catch(config.onError);
      }
    }
  }

  /**
   * Synchronous hot-path check.
   * Runs risk pipeline first (if configured), then rate-limit check.
   * Risk "block" decisions short-circuit the rate-limit check.
   */
  check(identifier: string, route: string, cost = 1, riskCtx?: Partial<SignalContext>): CheckResult {
    const matchedRule = this.matchRule(route);
    const limit = this.rules.get(matchedRule)!;
    const storeKey = `${matchedRule}:${identifier}`;

    // Denylist check
    if (this.denylist?.isBlocked(storeKey)) {
      return { allowed: false, matchedRule, denylisted: true };
    }

    // Risk scoring
    let risk: RiskResult | undefined;
    if (this.scorer && riskCtx) {
      const ctx: SignalContext = {
        identifier,
        route,
        requestVelocity: 0,
        failedAuthStreak: 0,
        ip: identifier,
        ...riskCtx,
      };
      risk = this.scorer.evaluate(ctx);
      if (risk.decision === "block") {
        return { allowed: false, matchedRule, risk };
      }
    }

    try {
      // Distributed mode: consume from local lease budget
      if (this.leaseManagers) {
        const lm = this.leaseManagers.get(matchedRule)!;
        const allowed = lm.consume(storeKey, cost);
        return { allowed, matchedRule, risk };
      }

      // Single-node mode
      const state = this.store.getOrCreate(storeKey, limit.algorithm, limit.rate, limit.windowMs);
      this.store.touch(storeKey, limit.windowMs);

      let allowed: boolean;
      if (limit.algorithm === "token-bucket") {
        allowed = tokenBucketCheck(state as BucketState, limit.rate, limit.windowMs, cost);
      } else {
        allowed = slidingWindowCheck(state as WindowState, limit.rate, limit.windowMs, cost);
      }

      return { allowed, matchedRule, risk };
    } catch {
      return { allowed: this.onFailure === "fail-open", matchedRule, risk };
    }
  }

  async blockIdentifier(identifier: string, route: string): Promise<void> {
    if (!this.denylist) return;
    const matchedRule = this.matchRule(route);
    await this.denylist.block(`${matchedRule}:${identifier}`);
  }

  unblockIdentifier(identifier: string, route: string): void {
    if (!this.denylist) return;
    const matchedRule = this.matchRule(route);
    this.denylist.unblock(`${matchedRule}:${identifier}`);
  }

  private matchRule(route: string): string {
    if (this.rules.has(route)) return route;
    return "default";
  }

  async destroy(): Promise<void> {
    this.store.destroy();
    this.leaseManagers?.forEach((lm) => lm.clear());
    await this.denylist?.destroy();
  }
}

export function createGuard(config: GuardConfig): Guard {
  return new Guard(config);
}
