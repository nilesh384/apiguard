import { Request, Response, NextFunction } from 'express';
import { FastifyPluginCallback } from 'fastify';
import { MiddlewareHandler } from 'hono';

/**
 * A signal receives a request context and returns a score from 0 (no risk) to 1 (max risk).
 * Signals are pure functions — they must not mutate state.
 */
interface SignalContext {
    identifier: string;
    route: string;
    /** Requests seen for this identifier in the current window */
    requestVelocity: number;
    /** Consecutive failed auth attempts (caller increments this) */
    failedAuthStreak: number;
    /** IP address string, e.g. "1.2.3.4" */
    ip: string;
    /** Previous IP seen for this identifier (undefined on first request) */
    previousIp?: string;
    /** User-agent header value */
    userAgent?: string;
    /** ISO country code from geo lookup, e.g. "US" */
    country?: string;
    /** Previous country seen for this identifier */
    previousCountry?: string;
}
interface Signal {
    name: string;
    /** Weight applied to this signal's score in the final combination (default 1) */
    weight?: number;
    score(ctx: SignalContext): number;
}
/**
 * Velocity: score rises linearly once requests exceed `warnAt` and hits 1 at `blockAt`.
 */
declare function velocitySignal(warnAt: number, blockAt: number): Signal;
/**
 * Failed-auth streak: score rises linearly from `warnAt` streaks to 1 at `blockAt`.
 */
declare function failedAuthSignal(warnAt: number, blockAt: number): Signal;
/**
 * IP reputation: returns 1 if the IP is in the denylist, 0 otherwise.
 * Pass a `ReputationList` instance (see reputation.ts).
 */
declare function ipReputationSignal(lookup: (ip: string) => boolean): Signal;
/**
 * Geo/device jump: returns 1 if the country changed since the last request.
 * Caller is responsible for tracking previousCountry in SignalContext.
 */
declare function geoJumpSignal(): Signal;
declare function suspiciousUaSignal(patterns?: RegExp[]): Signal;

interface BucketState {
    tokens: number;
    lastRefillAt: number;
}

/**
 * Sliding window counter using two fixed slots (current + previous window).
 * Approximation: weight = prev_count * (1 - elapsed/windowMs) + curr_count
 * This avoids storing per-request timestamps while being more accurate than
 * a pure fixed window.
 */
interface WindowState {
    prevCount: number;
    currCount: number;
    windowStart: number;
}

type AlgoState = BucketState | WindowState;
interface Store {
    getOrCreate(key: string, algo: "token-bucket" | "sliding-window", capacity: number, windowMs: number, nowMs?: number): AlgoState;
    touch(key: string, windowMs: number, nowMs?: number): void;
    evict(nowMs?: number): void;
    size(): number;
    destroy(): void;
}

interface RedisClient {
    eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
    set(key: string, value: string, expiryMode: string, time: number): Promise<unknown>;
    get(key: string): Promise<string | null>;
    del(key: string): Promise<unknown>;
    publish(channel: string, message: string): Promise<unknown>;
    subscribe(channel: string, callback: (message: string) => void): Promise<void>;
    unsubscribe(channel: string): Promise<void>;
    quit(): Promise<unknown>;
}
/**
 * RedisStore does NOT replace MemoryStore — it sits alongside it.
 * The Guard uses MemoryStore for the hot path and calls RedisStore
 * only via LeaseManager in the background.
 *
 * acquireLease()  — atomic Lua grant
 * syncCount()     — push local count delta to Redis (for sliding-window sync)
 */
declare class RedisStore implements Store {
    private client;
    constructor(client: RedisClient);
    /**
     * Atomically acquire up to `leaseSize` tokens from the global counter.
     * Returns the number of tokens granted (0 = globally exhausted).
     */
    acquireLease(key: string, globalLimit: number, leaseSize: number, windowMs: number): Promise<number>;
    /**
     * Push a count delta to Redis (used by sliding-window background sync).
     */
    syncCount(key: string, delta: number, windowMs: number): Promise<void>;
    getOrCreate(_key: string, algo: "token-bucket" | "sliding-window", capacity: number, _windowMs: number, nowMs?: number): AlgoState;
    touch(): void;
    evict(): void;
    size(): number;
    destroy(): Promise<void>;
}

type WindowUnit = "s" | "m" | "h";
type PerString = `${number}${WindowUnit}`;
interface LimitConfig {
    /** Max requests allowed in the window */
    rate: number;
    /** Window size, e.g. "1m", "30s", "2h" */
    per: PerString;
    /** Key extractor: "ip" | "user" | "ip+user" | custom fn */
    by?: "ip" | "user" | "ip+user" | ((req: unknown) => string);
    /** Algorithm to use for this limit */
    algorithm?: "token-bucket" | "sliding-window";
}
interface RedisConfig {
    /** ioredis (or compatible) client instance */
    client: RedisClient;
    /** Tokens to request per lease from Redis (default: 50) */
    leaseSize?: number;
    /** Refill when local tokens fall to this fraction of leaseSize (default: 0.2) */
    lowWatermark?: number;
    /** Enable cross-node denylist via pub/sub (default: true) */
    denylist?: boolean;
}
interface RiskConfig {
    signals: Signal[];
    /** Score threshold for "challenge" decision (default 0.5) */
    challengeThreshold?: number;
    /** Score threshold for "block" decision (default 0.8) */
    blockThreshold?: number;
}
interface GuardConfig {
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

type RiskDecision = "allow" | "challenge" | "block";
interface RiskResult {
    decision: RiskDecision;
    /** Final weighted score 0–1 */
    score: number;
    /** Per-signal breakdown for observability */
    breakdown: Record<string, number>;
}
interface ScorerOptions {
    signals: Signal[];
    /** Score threshold above which the decision is "challenge" (default 0.5) */
    challengeThreshold?: number;
    /** Score threshold above which the decision is "block" (default 0.8) */
    blockThreshold?: number;
}
declare class RiskScorer {
    private signals;
    private challengeAt;
    private blockAt;
    constructor(opts: ScorerOptions);
    evaluate(ctx: SignalContext): RiskResult;
}

interface CheckResult {
    allowed: boolean;
    matchedRule: string;
    denylisted?: boolean;
    risk?: RiskResult;
}
declare class Guard {
    private store;
    private rules;
    private onFailure;
    private scorer?;
    private leaseManagers?;
    private denylist?;
    constructor(config: GuardConfig);
    /**
     * Synchronous hot-path check.
     * Runs risk pipeline first (if configured), then rate-limit check.
     * Risk "block" decisions short-circuit the rate-limit check.
     */
    check(identifier: string, route: string, cost?: number, riskCtx?: Partial<SignalContext>): CheckResult;
    blockIdentifier(identifier: string, route: string): Promise<void>;
    unblockIdentifier(identifier: string, route: string): void;
    private matchRule;
    destroy(): Promise<void>;
}
declare function createGuard(config: GuardConfig): Guard;

interface ExpressGuardOptions {
    limits: Record<string, {
        by?: LimitConfig["by"];
    }>;
    /** If true, populate riskCtx from the request for risk scoring */
    risk?: boolean;
}
declare function expressMiddleware(guard: Guard, opts: ExpressGuardOptions): (req: Request, res: Response, next: NextFunction) => void;

interface FastifyGuardOptions {
    guard: Guard;
    limits: Record<string, {
        by?: LimitConfig["by"];
    }>;
    /** If true, populate riskCtx from the request for risk scoring */
    risk?: boolean;
}
declare const fastifyMiddleware: FastifyPluginCallback<FastifyGuardOptions>;

interface HonoGuardOptions {
    guard: Guard;
    limits: Record<string, {
        by?: LimitConfig["by"];
    }>;
    risk?: boolean;
}
declare function honoMiddleware(opts: HonoGuardOptions): MiddlewareHandler;

declare class Denylist {
    private client;
    private onError?;
    private blocked;
    private subscribed;
    constructor(client: RedisClient, onError?: ((err: unknown) => void) | undefined);
    subscribe(): Promise<void>;
    /** Block a key locally and publish to all other nodes */
    block(key: string): Promise<void>;
    isBlocked(key: string): boolean;
    unblock(key: string): void;
    destroy(): Promise<void>;
}

interface LeaseManagerOptions {
    leaseSize: number;
    /** Re-request a lease when local tokens drop to or below this fraction of leaseSize (0–1) */
    lowWatermark: number;
    globalLimit: number;
    windowMs: number;
    onError?: (err: unknown) => void;
}
declare class LeaseManager {
    private redis;
    private opts;
    private leases;
    constructor(redis: RedisStore, opts: LeaseManagerOptions);
    /**
     * Consume one token from the local lease for `key`.
     * Triggers a background refill when the budget is low.
     * Returns false only when the local budget is fully exhausted.
     */
    consume(key: string, cost?: number): boolean;
    private refill;
    clear(): void;
    localTokens(key: string): number;
}

/**
 * Lightweight in-memory IP reputation list.
 * Supports exact IPv4 matches and CIDR blocks (/8 to /32).
 *
 * Compatible with MaxMind GeoLite2 anonymous IP CSV exports and any
 * newline-delimited list of IPs or CIDR ranges.
 */
declare class ReputationList {
    private exact;
    /** [networkInt, maskInt][] */
    private cidrs;
    add(entry: string): void;
    /** Load from a newline-delimited string (e.g. file contents) */
    loadText(text: string): void;
    contains(ip: string): boolean;
    size(): number;
    clear(): void;
}

export { type CheckResult, Denylist, type ExpressGuardOptions, type FastifyGuardOptions, Guard, type GuardConfig, type HonoGuardOptions, LeaseManager, type LimitConfig, type PerString, type RedisClient, type RedisConfig, ReputationList, type RiskConfig, type RiskDecision, type RiskResult, RiskScorer, type Signal, type SignalContext, createGuard, expressMiddleware, failedAuthSignal, fastifyMiddleware, geoJumpSignal, honoMiddleware, ipReputationSignal, suspiciousUaSignal, velocitySignal };
