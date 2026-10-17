import type { Store, AlgoState } from "./interface";
import { newBucketState } from "../algorithms/token-bucket";
import { newWindowState } from "../algorithms/sliding-window";

export interface RedisClient {
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
 * Atomic Lua script: grants up to `lease` tokens from the global counter.
 * KEYS[1] = rate-limit key
 * ARGV[1] = global limit, ARGV[2] = lease size requested, ARGV[3] = window TTL (ms→s)
 * Returns the number of tokens actually granted (may be less than requested near the limit).
 */
const LEASE_SCRIPT = `
local current = tonumber(redis.call("GET", KEYS[1])) or 0
local limit   = tonumber(ARGV[1])
local lease   = tonumber(ARGV[2])
local ttl     = tonumber(ARGV[3])
local available = limit - current
if available <= 0 then return 0 end
local granted = math.min(lease, available)
redis.call("INCRBY", KEYS[1], granted)
redis.call("PEXPIRE", KEYS[1], ttl)
return granted
`;

/**
 * RedisStore does NOT replace MemoryStore — it sits alongside it.
 * The Guard uses MemoryStore for the hot path and calls RedisStore
 * only via LeaseManager in the background.
 *
 * acquireLease()  — atomic Lua grant
 * syncCount()     — push local count delta to Redis (for sliding-window sync)
 */
export class RedisStore implements Store {
  constructor(private client: RedisClient) {}

  /**
   * Atomically acquire up to `leaseSize` tokens from the global counter.
   * Returns the number of tokens granted (0 = globally exhausted).
   */
  async acquireLease(
    key: string,
    globalLimit: number,
    leaseSize: number,
    windowMs: number
  ): Promise<number> {
    const granted = await this.client.eval(
      LEASE_SCRIPT,
      1,
      key,
      globalLimit,
      leaseSize,
      windowMs
    );
    return typeof granted === "number" ? granted : 0;
  }

  /**
   * Push a count delta to Redis (used by sliding-window background sync).
   */
  async syncCount(key: string, delta: number, windowMs: number): Promise<void> {
    if (delta <= 0) return;
    await this.client.eval(
      `redis.call("INCRBY", KEYS[1], ARGV[1]); redis.call("PEXPIRE", KEYS[1], ARGV[2]); return 1`,
      1,
      key,
      delta,
      windowMs
    );
  }

  // ── Store interface (delegates to in-memory; Redis is background-only) ──

  getOrCreate(
    _key: string,
    algo: "token-bucket" | "sliding-window",
    capacity: number,
    _windowMs: number,
    nowMs = Date.now()
  ): AlgoState {
    return algo === "token-bucket" ? newBucketState(capacity, nowMs) : newWindowState(nowMs);
  }

  touch(): void { /* no-op — TTL managed by PEXPIRE in Lua */ }
  evict(): void { /* no-op — Redis handles expiry */ }
  size(): number { return 0; }
  async destroy(): Promise<void> { await this.client.quit(); }
}
