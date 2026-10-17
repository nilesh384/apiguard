export { createGuard, Guard } from "./guard";
export type { CheckResult } from "./guard";
export type { GuardConfig, LimitConfig, PerString, RedisConfig, RiskConfig } from "./config";
export { expressMiddleware } from "./middleware/express";
export type { RedisClient } from "./store/redis";
export { Denylist } from "./sync/denylist";
export { LeaseManager } from "./sync/lease-manager";
export { RiskScorer } from "./risk/scorer";
export type { RiskResult, RiskDecision } from "./risk/scorer";
export type { Signal, SignalContext } from "./risk/signals";
export {
  velocitySignal,
  failedAuthSignal,
  ipReputationSignal,
  geoJumpSignal,
  suspiciousUaSignal,
} from "./risk/signals";
export { ReputationList } from "./risk/reputation";
