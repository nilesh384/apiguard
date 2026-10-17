import { describe, it, expect } from "vitest";
import { tokenBucketCheck, newBucketState } from "../src/algorithms/token-bucket";

describe("token-bucket", () => {
  it("allows requests up to capacity", () => {
    const state = newBucketState(5, 0);
    for (let i = 0; i < 5; i++) {
      expect(tokenBucketCheck(state, 5, 1000, 1, 0)).toBe(true);
    }
    expect(tokenBucketCheck(state, 5, 1000, 1, 0)).toBe(false);
  });

  it("refills tokens over time", () => {
    const state = newBucketState(10, 0);
    // Drain all tokens
    for (let i = 0; i < 10; i++) tokenBucketCheck(state, 10, 1000, 1, 0);
    expect(tokenBucketCheck(state, 10, 1000, 1, 0)).toBe(false);

    // After half the window, half the tokens should be back
    expect(tokenBucketCheck(state, 10, 1000, 1, 500)).toBe(true);
  });

  it("does not exceed capacity on refill", () => {
    const state = newBucketState(5, 0);
    // Wait 10x the window — tokens should cap at capacity
    tokenBucketCheck(state, 5, 1000, 1, 10_000);
    expect(state.tokens).toBeLessThanOrEqual(5);
  });

  it("supports cost > 1", () => {
    const state = newBucketState(10, 0);
    expect(tokenBucketCheck(state, 10, 1000, 5, 0)).toBe(true);
    expect(tokenBucketCheck(state, 10, 1000, 5, 0)).toBe(true);
    expect(tokenBucketCheck(state, 10, 1000, 5, 0)).toBe(false);
  });
});
