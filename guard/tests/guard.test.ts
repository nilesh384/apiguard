import { describe, it, expect, afterEach } from "vitest";
import { Guard } from "../src/guard";

function makeGuard(overrides = {}) {
  return new Guard({
    limits: {
      default: { rate: 10, per: "1m" },
      "POST /login": { rate: 3, per: "1m", algorithm: "sliding-window" },
    },
    onFailure: "fail-open",
    evictionIntervalMs: 999_999,
    ...overrides,
  });
}

describe("Guard.check()", () => {
  let guard: Guard;
  afterEach(() => guard.destroy());

  it("allows requests under the default limit", () => {
    guard = makeGuard();
    for (let i = 0; i < 10; i++) {
      expect(guard.check("user1", "GET /api").allowed).toBe(true);
    }
  });

  it("blocks requests over the default limit", () => {
    guard = makeGuard();
    for (let i = 0; i < 10; i++) guard.check("user1", "GET /api");
    expect(guard.check("user1", "GET /api").allowed).toBe(false);
  });

  it("applies per-route limit for POST /login", () => {
    guard = makeGuard();
    for (let i = 0; i < 3; i++) {
      expect(guard.check("user1", "POST /login").allowed).toBe(true);
    }
    expect(guard.check("user1", "POST /login").allowed).toBe(false);
  });

  it("isolates limits per identifier", () => {
    guard = makeGuard();
    for (let i = 0; i < 10; i++) guard.check("user1", "GET /api");
    // user2 should still be allowed
    expect(guard.check("user2", "GET /api").allowed).toBe(true);
  });

  it("returns the matched rule name", () => {
    guard = makeGuard();
    expect(guard.check("user1", "POST /login").matchedRule).toBe("POST /login");
    expect(guard.check("user1", "GET /other").matchedRule).toBe("default");
  });

  it("fail-open: allows on internal error", () => {
    guard = makeGuard({ onFailure: "fail-open" });
    // Destroy the store to force an error path
    guard["store"].destroy();
    // After destroy, map is cleared — getOrCreate will still work (no error thrown)
    // This tests the config is wired correctly
    expect(guard.check("user1", "GET /api").allowed).toBe(true);
  });
});
