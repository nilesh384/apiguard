/**
 * Sliding window counter using two fixed slots (current + previous window).
 * Approximation: weight = prev_count * (1 - elapsed/windowMs) + curr_count
 * This avoids storing per-request timestamps while being more accurate than
 * a pure fixed window.
 */
export interface WindowState {
  prevCount: number;
  currCount: number;
  windowStart: number; // ms timestamp of current window start
}

export function slidingWindowCheck(
  state: WindowState,
  limit: number,
  windowMs: number,
  cost = 1,
  nowMs = Date.now()
): boolean {
  const elapsed = nowMs - state.windowStart;

  if (elapsed >= windowMs * 2) {
    // Both windows are stale — full reset
    state.prevCount = 0;
    state.currCount = 0;
    state.windowStart = nowMs;
  } else if (elapsed >= windowMs) {
    // Roll over: current becomes previous
    state.prevCount = state.currCount;
    state.currCount = 0;
    state.windowStart += windowMs;
  }

  const weight = state.prevCount * (1 - (nowMs - state.windowStart) / windowMs);
  const estimated = weight + state.currCount;

  if (estimated + cost > limit) return false;

  state.currCount += cost;
  return true;
}

export function newWindowState(nowMs = Date.now()): WindowState {
  return { prevCount: 0, currCount: 0, windowStart: nowMs };
}
