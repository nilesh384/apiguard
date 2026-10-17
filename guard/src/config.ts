export type WindowUnit = "s" | "m" | "h";
export type PerString = `${number}${WindowUnit}`;

export interface LimitConfig {
  /** Max requests allowed in the window */
  rate: number;
  /** Window size, e.g. "1m", "30s", "2h" */
  per: PerString;
  /** Key extractor: "ip" | "user" | "ip+user" | custom fn */
  by?: "ip" | "user" | "ip+user" | ((req: unknown) => string);
  /** Algorithm to use for this limit */
  algorithm?: "token-bucket" | "sliding-window";
}

export interface RedisConfig {
  /** ioredis (or compatible) client instance */
  client: import("./store/redis").RedisClient;
  /** Tokens to request per lease from Redis (default: 50) */
  leaseSize?: number;
  /** Refill when local tokens fall to this fraction of leaseSize (default: 0.2) */
  lowWatermark?: number;
  /** Enable cross-node denylist via pub/sub (default: true) */
  denylist?: boolean;
}

export interface RiskConfig {
  signals: import("./risk/signals").Signal[];
  /** Score threshold for "challenge" decision (default 0.5) */
  challengeThreshold?: number;
  /** Score threshold for "block" decision (default 0.8) */
  blockThreshold?: number;
}

export interface GuardConfig {
  limits: {
    default: LimitConfig;
    [route: string]: LimitConfig;
  };
  /** "fail-open" allows requests when store errors; "fail-closed" blocks them */
  onFailure?: "fail-open" | "fail-closed";
  /** How often (ms) to run TTL eviction on the memory store */
  evictionIntervalMs?: number;
  /** Provide a Redis config to enable distributed mode */
  redis?: RedisConfig;
  /** Called whenever a Redis error occurs */
  onError?: (err: unknown) => void;
  /** Enable risk scoring pipeline */
  risk?: RiskConfig;
}

/** Parsed, normalized limit with window in milliseconds */
export interface NormalizedLimit {
  rate: number;
  windowMs: number;
  by: NonNullable<LimitConfig["by"]>;
  algorithm: NonNullable<LimitConfig["algorithm"]>;
}

export function parseWindow(per: PerString): number {
  const unit = per.slice(-1) as WindowUnit;
  const n = parseInt(per.slice(0, -1), 10);
  if (unit === "s") return n * 1000;
  if (unit === "m") return n * 60_000;
  return n * 3_600_000;
}

export function normalizeLimit(cfg: LimitConfig): NormalizedLimit {
  return {
    rate: cfg.rate,
    windowMs: parseWindow(cfg.per),
    by: cfg.by ?? "ip",
    algorithm: cfg.algorithm ?? "token-bucket",
  };
}
