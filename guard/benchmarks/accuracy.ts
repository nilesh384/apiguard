/**
 * Accuracy test: distributed overshoot measurement
 *
 * Simulates N nodes each consuming from a shared LeaseManager backed by a
 * mock Redis counter. Measures how many requests were allowed vs the global limit.
 *
 * Run with:  node --loader ts-node/esm benchmarks/accuracy.ts
 */

import { LeaseManager } from "../src/sync/lease-manager";
import type { RedisStore } from "../src/store/redis";

const GLOBAL_LIMIT = 1000;
const LEASE_SIZE = 50;
const LOW_WATERMARK = 0.2;
const NODE_COUNT = 5;
const REQUESTS_PER_NODE = 300;

/** Shared atomic counter simulating Redis INCRBY */
function makeMockRedis(globalLimit: number): RedisStore {
  let counter = 0;
  return {
    acquireLease: async (_key: string, _limit: number, lease: number): Promise<number> => {
      const available = globalLimit - counter;
      if (available <= 0) return 0;
      const granted = Math.min(lease, available);
      counter += granted;
      return granted;
    },
  } as unknown as RedisStore;
}

async function run() {
  const redis = makeMockRedis(GLOBAL_LIMIT);

  const nodes = Array.from({ length: NODE_COUNT }, () =>
    new LeaseManager(redis, {
      leaseSize: LEASE_SIZE,
      lowWatermark: LOW_WATERMARK,
      globalLimit: GLOBAL_LIMIT,
      windowMs: 60_000,
    })
  );

  let totalAllowed = 0;

  // Each node fires REQUESTS_PER_NODE requests with a small async gap
  // to let background lease refills resolve
  await Promise.all(
    nodes.map(async (lm) => {
      for (let i = 0; i < REQUESTS_PER_NODE; i++) {
        if (lm.consume("key")) totalAllowed++;
        // Yield to let lease refill microtasks run
        if (i % LEASE_SIZE === 0) await Promise.resolve();
      }
    })
  );

  const overshoot = Math.max(0, totalAllowed - GLOBAL_LIMIT);
  const undershoot = Math.max(0, GLOBAL_LIMIT - totalAllowed);
  const overshootPct = ((overshoot / GLOBAL_LIMIT) * 100).toFixed(2);
  const undershootPct = ((undershoot / GLOBAL_LIMIT) * 100).toFixed(2);

  console.log(`\nDistributed Accuracy Test`);
  console.log(`  Nodes          : ${NODE_COUNT}`);
  console.log(`  Global limit   : ${GLOBAL_LIMIT}`);
  console.log(`  Lease size     : ${LEASE_SIZE}`);
  console.log(`  Total allowed  : ${totalAllowed}`);
  console.log(`  Overshoot      : ${overshoot} (${overshootPct}%)`);
  console.log(`  Undershoot     : ${undershoot} (${undershootPct}%)`);
  console.log(
    `\n  Result: ${overshoot === 0 && undershoot === 0 ? "✓ exact" : overshoot > 0 ? `⚠ overshot by ${overshootPct}%` : `⚠ undershot by ${undershootPct}%`}`
  );
}

run().catch(console.error);
