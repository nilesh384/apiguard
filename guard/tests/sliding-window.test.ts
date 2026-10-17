import { describe, it, expect } from "vitest";
import { slidingWindowCheck, newWindowState } from "../src/algorithms/sliding-window";

describe("sliding-window", () => {
  it("allows requests up to limit within a window", () => {
    const state = newWindowState(0);
    for (let i = 0; i < 10; i++) {
      expect(slidingWindowCheck(state, 10, 1000, 1, 0)).toBe(true);
    }
    expect(slidingWindowCheck(state, 10, 1000, 1, 0)).toBe(false);
  });

  it("rolls over to next window", () => {
    const state = newWindowState(0);
    for (let i = 0; i < 10; i++) slidingWindowCheck(state, 10, 1000, 1, 0);

    // At t=1000: new window starts, prev_weight = 10*(1-0/1000) = 10 → still at limit
    expect(slidingWindowCheck(state, 10, 1000, 1, 1000)).toBe(false);
    // At t=1500: prev_weight = 10*0.5 = 5, so 1 more is allowed
    expect(slidingWindowCheck(state, 10, 1000, 1, 1500)).toBe(true);
  });

  it("applies sliding weight from previous window", () => {
    const state2 = newWindowState(0);
    for (let i = 0; i < 10; i++) slidingWindowCheck(state2, 10, 1000, 1, 0);
    // At t=1500: prev_weight=10*0.5=5, so 5 requests should be allowed
    let allowed = 0;
    for (let i = 0; i < 10; i++) {
      if (slidingWindowCheck(state2, 10, 1000, 1, 1500)) allowed++;
    }
    expect(allowed).toBe(5);
  });

  it("resets fully after 2 windows", () => {
    const state = newWindowState(0);
    for (let i = 0; i < 10; i++) slidingWindowCheck(state, 10, 1000, 1, 0);
    // After 2 full windows, both slots are stale
    for (let i = 0; i < 10; i++) {
      expect(slidingWindowCheck(state, 10, 1000, 1, 2001)).toBe(true);
    }
  });
});
