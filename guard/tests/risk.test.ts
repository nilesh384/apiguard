import { describe, it, expect } from "vitest";
import {
  velocitySignal,
  failedAuthSignal,
  ipReputationSignal,
  geoJumpSignal,
  suspiciousUaSignal,
  type SignalContext,
} from "../src/risk/signals";
import { RiskScorer } from "../src/risk/scorer";
import { ReputationList } from "../src/risk/reputation";
import { Guard } from "../src/guard";

const base: SignalContext = {
  identifier: "1.2.3.4",
  route: "POST /login",
  requestVelocity: 0,
  failedAuthStreak: 0,
  ip: "1.2.3.4",
};

// ── velocitySignal ────────────────────────────────────────────────────────────
describe("velocitySignal", () => {
  const s = velocitySignal(10, 20);

  it("returns 0 below warnAt", () => {
    expect(s.score({ ...base, requestVelocity: 5 })).toBe(0);
  });

  it("returns 0 at warnAt", () => {
    expect(s.score({ ...base, requestVelocity: 10 })).toBe(0);
  });

  it("returns 0.5 halfway between warnAt and blockAt", () => {
    expect(s.score({ ...base, requestVelocity: 15 })).toBe(0.5);
  });

  it("returns 1 at blockAt", () => {
    expect(s.score({ ...base, requestVelocity: 20 })).toBe(1);
  });

  it("clamps to 1 above blockAt", () => {
    expect(s.score({ ...base, requestVelocity: 100 })).toBe(1);
  });
});

// ── failedAuthSignal ──────────────────────────────────────────────────────────
describe("failedAuthSignal", () => {
  const s = failedAuthSignal(3, 8);

  it("returns 0 at or below warnAt", () => {
    expect(s.score({ ...base, failedAuthStreak: 3 })).toBe(0);
  });

  it("returns 1 at blockAt", () => {
    expect(s.score({ ...base, failedAuthStreak: 8 })).toBe(1);
  });
});

// ── ipReputationSignal ────────────────────────────────────────────────────────
describe("ipReputationSignal", () => {
  const list = new ReputationList();
  list.add("5.5.5.5");
  list.add("10.0.0.0/8");
  const s = ipReputationSignal((ip) => list.contains(ip));

  it("returns 1 for exact match", () => {
    expect(s.score({ ...base, ip: "5.5.5.5" })).toBe(1);
  });

  it("returns 1 for CIDR match", () => {
    expect(s.score({ ...base, ip: "10.1.2.3" })).toBe(1);
  });

  it("returns 0 for clean IP", () => {
    expect(s.score({ ...base, ip: "8.8.8.8" })).toBe(0);
  });
});

// ── geoJumpSignal ─────────────────────────────────────────────────────────────
describe("geoJumpSignal", () => {
  const s = geoJumpSignal();

  it("returns 0 when countries match", () => {
    expect(s.score({ ...base, country: "US", previousCountry: "US" })).toBe(0);
  });

  it("returns 1 when country changed", () => {
    expect(s.score({ ...base, country: "RU", previousCountry: "US" })).toBe(1);
  });

  it("returns 0 when no previous country", () => {
    expect(s.score({ ...base, country: "US" })).toBe(0);
  });
});

// ── suspiciousUaSignal ────────────────────────────────────────────────────────
describe("suspiciousUaSignal", () => {
  const s = suspiciousUaSignal();

  it("returns 1 for python-requests", () => {
    expect(s.score({ ...base, userAgent: "python-requests/2.28" })).toBe(1);
  });

  it("returns 1 for curl", () => {
    expect(s.score({ ...base, userAgent: "curl/7.88" })).toBe(1);
  });

  it("returns 0 for normal browser UA", () => {
    expect(s.score({ ...base, userAgent: "Mozilla/5.0 Chrome/120" })).toBe(0);
  });

  it("returns 0 when userAgent is undefined", () => {
    expect(s.score({ ...base })).toBe(0);
  });
});

// ── RiskScorer pipeline ───────────────────────────────────────────────────────
describe("RiskScorer", () => {
  it("returns allow when score is below challengeThreshold", () => {
    const scorer = new RiskScorer({
      signals: [velocitySignal(10, 20)],
      challengeThreshold: 0.5,
      blockThreshold: 0.8,
    });
    const r = scorer.evaluate({ ...base, requestVelocity: 5 });
    expect(r.decision).toBe("allow");
    expect(r.score).toBe(0);
  });

  it("returns challenge when score is between thresholds", () => {
    const scorer = new RiskScorer({
      signals: [velocitySignal(0, 10)],
      challengeThreshold: 0.5,
      blockThreshold: 0.8,
    });
    const r = scorer.evaluate({ ...base, requestVelocity: 6 });
    expect(r.decision).toBe("challenge");
  });

  it("returns block when score exceeds blockThreshold", () => {
    const scorer = new RiskScorer({
      signals: [velocitySignal(0, 10)],
      blockThreshold: 0.8,
    });
    const r = scorer.evaluate({ ...base, requestVelocity: 10 });
    expect(r.decision).toBe("block");
    expect(r.score).toBe(1);
  });

  it("combines weighted signals correctly", () => {
    // signal A weight=1 score=1, signal B weight=3 score=0 → weighted avg = 0.25
    const scorer = new RiskScorer({
      signals: [
        { name: "a", weight: 1, score: () => 1 },
        { name: "b", weight: 3, score: () => 0 },
      ],
      challengeThreshold: 0.5,
      blockThreshold: 0.8,
    });
    const r = scorer.evaluate(base);
    expect(r.score).toBe(0.25);
    expect(r.decision).toBe("allow");
  });

  it("includes per-signal breakdown", () => {
    const scorer = new RiskScorer({
      signals: [velocitySignal(0, 10), failedAuthSignal(0, 5)],
    });
    const r = scorer.evaluate({ ...base, requestVelocity: 5, failedAuthStreak: 5 });
    expect(r.breakdown["velocity"]).toBe(0.5);
    expect(r.breakdown["failed-auth"]).toBe(1);
  });
});

// ── Guard + risk integration ──────────────────────────────────────────────────
describe("Guard risk integration", () => {
  it("blocks when risk decision is block", () => {
    const guard = new Guard({
      limits: { default: { rate: 100, per: "1m" } },
      risk: {
        signals: [{ name: "always-block", score: () => 1 }],
        blockThreshold: 0.8,
      },
    });
    const result = guard.check("1.2.3.4", "GET /api", 1, { ip: "1.2.3.4", requestVelocity: 0, failedAuthStreak: 0 });
    expect(result.allowed).toBe(false);
    expect(result.risk?.decision).toBe("block");
    guard.destroy();
  });

  it("allows and attaches risk result when decision is challenge", () => {
    const guard = new Guard({
      limits: { default: { rate: 100, per: "1m" } },
      risk: {
        signals: [{ name: "mid", score: () => 0.6 }],
        challengeThreshold: 0.5,
        blockThreshold: 0.9,
      },
    });
    const result = guard.check("1.2.3.4", "GET /api", 1, { ip: "1.2.3.4", requestVelocity: 0, failedAuthStreak: 0 });
    expect(result.allowed).toBe(true);
    expect(result.risk?.decision).toBe("challenge");
    guard.destroy();
  });

  it("skips risk scoring when no riskCtx is passed", () => {
    const guard = new Guard({
      limits: { default: { rate: 100, per: "1m" } },
      risk: { signals: [{ name: "always-block", score: () => 1 }] },
    });
    const result = guard.check("1.2.3.4", "GET /api");
    expect(result.allowed).toBe(true);
    expect(result.risk).toBeUndefined();
    guard.destroy();
  });
});

// ── ReputationList ────────────────────────────────────────────────────────────
describe("ReputationList", () => {
  it("matches exact IPs", () => {
    const list = new ReputationList();
    list.add("1.2.3.4");
    expect(list.contains("1.2.3.4")).toBe(true);
    expect(list.contains("1.2.3.5")).toBe(false);
  });

  it("matches CIDR /24", () => {
    const list = new ReputationList();
    list.add("192.168.1.0/24");
    expect(list.contains("192.168.1.100")).toBe(true);
    expect(list.contains("192.168.2.1")).toBe(false);
  });

  it("ignores comments and blank lines", () => {
    const list = new ReputationList();
    list.loadText("# comment\n\n1.1.1.1\n");
    expect(list.size()).toBe(1);
  });

  it("clear() empties the list", () => {
    const list = new ReputationList();
    list.add("1.2.3.4");
    list.clear();
    expect(list.contains("1.2.3.4")).toBe(false);
  });
});
