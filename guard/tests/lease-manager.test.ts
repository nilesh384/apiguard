import { describe, it, expect, vi, beforeEach } from "vitest";
import { LeaseManager } from "../src/sync/lease-manager";
import type { RedisStore } from "../src/store/redis";

function makeRedis(grantFn: () => Promise<number>): RedisStore {
  return { acquireLease: vi.fn(grantFn) } as unknown as RedisStore;
}

describe("LeaseManager", () => {
  let errors: unknown[];

  beforeEach(() => { errors = []; });

  it("optimistically allows first request and triggers background refill", async () => {
    let resolveLease!: (n: number) => void;
    const redis = makeRedis(() => new Promise((r) => { resolveLease = r; }));
    const lm = new LeaseManager(redis, { leaseSize: 10, lowWatermark: 0.2, globalLimit: 100, windowMs: 1000 });

    expect(lm.consume("k")).toBe(true); // optimistic pass
    expect(redis.acquireLease).toHaveBeenCalledOnce();

    resolveLease(10);
    await Promise.resolve(); // flush microtask
    expect(lm.localTokens("k")).toBe(10);
  });

  it("blocks when local budget is exhausted", async () => {
    const redis = makeRedis(() => Promise.resolve(0)); // globally exhausted
    const lm = new LeaseManager(redis, { leaseSize: 5, lowWatermark: 0, globalLimit: 5, windowMs: 1000 });

    lm.consume("k"); // optimistic first
    await Promise.resolve(); // lease resolves with 0

    expect(lm.consume("k")).toBe(false);
  });

  it("consumes tokens and triggers refill at low watermark", async () => {
    const redis = makeRedis(() => Promise.resolve(10));
    const lm = new LeaseManager(redis, { leaseSize: 10, lowWatermark: 0.2, globalLimit: 100, windowMs: 1000 });

    lm.consume("k"); // optimistic, triggers first refill
    await Promise.resolve();
    expect(lm.localTokens("k")).toBe(10);

    // Drain to low watermark (10 * 0.2 = 2)
    for (let i = 0; i < 8; i++) lm.consume("k");
    expect(lm.localTokens("k")).toBe(2);
    // Should have triggered a second refill
    expect(redis.acquireLease).toHaveBeenCalledTimes(2);
  });

  it("does not duplicate in-flight refill requests", async () => {
    let resolve!: (n: number) => void;
    const redis = makeRedis(() => new Promise((r) => { resolve = r; }));
    const lm = new LeaseManager(redis, { leaseSize: 10, lowWatermark: 1, globalLimit: 100, windowMs: 1000 });

    lm.consume("k");
    lm.consume("k"); // second call while refill is still in flight
    expect(redis.acquireLease).toHaveBeenCalledOnce();
    resolve(10);
  });

  it("calls onError and clears refilling flag when Redis fails", async () => {
    const redis = makeRedis(() => Promise.reject(new Error("redis down")));
    const lm = new LeaseManager(redis, {
      leaseSize: 10, lowWatermark: 0.2, globalLimit: 100, windowMs: 1000,
      onError: (e) => errors.push(e),
    });

    lm.consume("k");
    // Two ticks: one for the rejection, one for the .catch() handler
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(1);
  });

  it("clear() resets all local budgets", async () => {
    const redis = makeRedis(() => Promise.resolve(10));
    const lm = new LeaseManager(redis, { leaseSize: 10, lowWatermark: 0, globalLimit: 100, windowMs: 1000 });

    lm.consume("k");
    await Promise.resolve();
    lm.clear();
    expect(lm.localTokens("k")).toBe(0);
  });
});
