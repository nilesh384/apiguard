/**
 * Benchmark: guard hot-path throughput
 *
 * Run with:  node --loader ts-node/esm benchmarks/run.ts
 *
 * Measures req/s for:
 *   1. Baseline  — plain HTTP handler, no guard
 *   2. Guard     — token-bucket, single-node
 *   3. Guard+Risk — token-bucket + full 5-signal risk pipeline
 *
 * Uses autocannon (install separately: npm i -g autocannon)
 */

import http from "http";
import { createGuard } from "../src/index";
import {
  velocitySignal,
  failedAuthSignal,
  suspiciousUaSignal,
  geoJumpSignal,
  ipReputationSignal,
} from "../src/risk/signals";
import { ReputationList } from "../src/risk/reputation";

const PORT_BASE = 4100;

function startServer(port: number, handler: http.RequestListener): http.Server {
  const s = http.createServer(handler);
  s.listen(port);
  return s;
}

// ── Baseline ──────────────────────────────────────────────────────────────────
const baseline = startServer(PORT_BASE, (_req, res) => {
  res.writeHead(200);
  res.end("ok");
});

// ── Guard (token-bucket, no risk) ─────────────────────────────────────────────
const guard = createGuard({
  limits: { default: { rate: 1_000_000, per: "1m" } },
  evictionIntervalMs: 999_999,
});

const guardServer = startServer(PORT_BASE + 1, (req, res) => {
  const result = guard.check(req.socket.remoteAddress ?? "unknown", `GET ${req.url}`);
  res.writeHead(result.allowed ? 200 : 429);
  res.end(result.allowed ? "ok" : "limited");
});

// ── Guard + Risk pipeline ─────────────────────────────────────────────────────
const rep = new ReputationList();
const guardRisk = createGuard({
  limits: { default: { rate: 1_000_000, per: "1m" } },
  evictionIntervalMs: 999_999,
  risk: {
    signals: [
      velocitySignal(500, 1000),
      failedAuthSignal(5, 10),
      ipReputationSignal((ip) => rep.contains(ip)),
      geoJumpSignal(),
      suspiciousUaSignal(),
    ],
    challengeThreshold: 0.5,
    blockThreshold: 0.8,
  },
});

const guardRiskServer = startServer(PORT_BASE + 2, (req, res) => {
  const ip = req.socket.remoteAddress ?? "unknown";
  const result = guardRisk.check(ip, `GET ${req.url}`, 1, {
    ip,
    requestVelocity: 1,
    failedAuthStreak: 0,
    userAgent: req.headers["user-agent"],
  });
  res.writeHead(result.allowed ? 200 : 429);
  res.end(result.allowed ? "ok" : "limited");
});

// ── Run autocannon ────────────────────────────────────────────────────────────
async function bench(label: string, port: number) {
  const { default: autocannon } = await import("autocannon");
  return new Promise<void>((resolve) => {
    const instance = autocannon(
      { url: `http://localhost:${port}`, connections: 10, duration: 5 },
      (err, result) => {
        if (err) { console.error(label, err); resolve(); return; }
        console.log(
          `\n${label}\n` +
          `  Requests/sec : ${result.requests.average.toLocaleString()}\n` +
          `  Latency p99  : ${result.latency.p99}ms\n` +
          `  Throughput   : ${(result.throughput.average / 1024).toFixed(1)} KB/s`
        );
        resolve();
      }
    );
    autocannon.track(instance, { renderProgressBar: false });
  });
}

(async () => {
  console.log("Warming up...");
  await new Promise((r) => setTimeout(r, 500));

  await bench("1. Baseline (no guard)", PORT_BASE);
  await bench("2. Guard — token-bucket", PORT_BASE + 1);
  await bench("3. Guard — token-bucket + 5-signal risk", PORT_BASE + 2);

  baseline.close();
  guardServer.close();
  guardRiskServer.close();
  await guard.destroy();
  await guardRisk.destroy();
})();
