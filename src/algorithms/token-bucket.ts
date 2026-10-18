export interface BucketState {
  tokens: number;
  lastRefillAt: number; // hrtime-based ms
}

/**
 * Token bucket: refills tokens continuously over the window.
 * Returns true if the request is allowed (tokens consumed), false if denied.
 * Mutates state in place — no allocations on the hot path.
 */
export function tokenBucketCheck(
  state: BucketState,
  capacity: number,
  windowMs: number,
  cost = 1,
  nowMs = Date.now()
): boolean {
  const elapsed = nowMs - state.lastRefillAt;
  // Refill proportionally to elapsed time
  const refill = (elapsed / windowMs) * capacity;
  state.tokens = Math.min(capacity, state.tokens + refill);
  state.lastRefillAt = nowMs;

  if (state.tokens >= cost) {
    state.tokens -= cost;
    return true;
  }
  return false;
}

export function newBucketState(capacity: number, nowMs = Date.now()): BucketState {
  return { tokens: capacity, lastRefillAt: nowMs };
}
