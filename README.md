# apiguardlimitjs

Sub-millisecond rate limiter with local token leasing, distributed Redis sync, and a pluggable risk-scoring pipeline.

---

## Architecture

```
                        ┌─────────────────────────────────────┐
  Request               │              Guard.check()           │
  ──────►  Middleware   │                                      │
           (Express /   │  1. Denylist?  ──yes──► 429         │
            Fastify /   │       │                              │
            Hono)       │       no                             │
                        │       ▼                              │
                        │  2. Risk pipeline (optional)         │
                        │     velocity · failed-auth           │
                        │     ip-rep · geo-jump · ua           │
                        │       │                              │
                        │    block ──────────────► 429         │
                        │    challenge ──► pass + flag         │
                        │    allow ──────────────► ▼           │
                        │                          │           │
                        │  3. Rate-limit check     │           │
                        │     (synchronous,        │           │
                        │      zero network I/O)   │           │
                        │       │                  │           │
                        │    denied ─────────────► 429         │
                        │    allowed ────────────► next()      │
                        └─────────────────────────────────────┘
                                        │
                              background│lease refill
                                        ▼
                                  ┌──────────┐
                                  │  Redis   │  ← Lua atomic lease grant
                                  │  pub/sub │  ← denylist propagation
                                  └──────────┘
                               (only in distributed mode)
```

---

## Install

```bash
npm install apiguardlimitjs
# peer deps — install only what you use
npm install express        # Express adapter
npm install fastify        # Fastify adapter
npm install hono           # Hono adapter
npm install ioredis        # distributed mode
```

---

## Quick start

### Single-node (Express)

```ts
import express from "express";
import { createGuard, expressMiddleware } from "apiguardlimitjs";

const guard = createGuard({
  limits: {
    default:          { rate: 100,  per: "1m", by: "ip" },
    "POST /login":    { rate: 5,    per: "1m", by: "ip", algorithm: "sliding-window" },
    "POST /register": { rate: 3,    per: "1h", by: "ip" },
  },
});

app.use(expressMiddleware(guard, {
  limits: {
    default:          { by: "ip" },
    "POST /login":    { by: "ip" },
  },
}));
```

### Distributed mode (Redis)

```ts
import Redis from "ioredis";
import { createGuard } from "apiguardlimitjs";

const guard = createGuard({
  limits: { default: { rate: 1000, per: "1m" } },
  redis: {
    client: new Redis(process.env.REDIS_URL),
    leaseSize: 50,        // tokens requested per lease
    lowWatermark: 0.2,    // refill when budget drops to 20% of leaseSize
    denylist: true,       // cross-node pub/sub denylist
  },
  onError: (err) => console.error("Redis error", err),
});
```

### Risk scoring

```ts
import {
  createGuard,
  velocitySignal,
  failedAuthSignal,
  ipReputationSignal,
  geoJumpSignal,
  suspiciousUaSignal,
  ReputationList,
} from "apiguardlimitjs";

const rep = new ReputationList();
rep.loadText(await fs.readFile("blocklist.txt", "utf8"));

const guard = createGuard({
  limits: { default: { rate: 100, per: "1m" } },
  risk: {
    signals: [
      velocitySignal(50, 100),
      failedAuthSignal(3, 8),
      ipReputationSignal((ip) => rep.contains(ip)),
      geoJumpSignal(),
      suspiciousUaSignal(),
    ],
    challengeThreshold: 0.5,   // → result.risk.decision === "challenge"
    blockThreshold: 0.8,       // → result.allowed === false
  },
});

// Pass riskCtx to check() to activate the pipeline
const result = guard.check(ip, "POST /login", 1, {
  ip,
  requestVelocity: 12,
  failedAuthStreak: 2,
  userAgent: req.headers["user-agent"],
  country: geoLookup(ip),
  previousCountry: session.lastCountry,
});

if (result.risk?.decision === "challenge") {
  // serve CAPTCHA or step-up auth
}
```

### Custom signal

```ts
const mySignal = {
  name: "vpn-detected",
  weight: 2,
  score: (ctx) => isVpn(ctx.ip) ? 1 : 0,
};
```

---

## API

### `createGuard(config: GuardConfig): Guard`

| Field | Type | Default | Description |
|---|---|---|---|
| `limits` | `Record<string, LimitConfig>` | required | Must include `"default"` |
| `onFailure` | `"fail-open" \| "fail-closed"` | `"fail-open"` | Behavior when store throws |
| `evictionIntervalMs` | `number` | `60_000` | How often to sweep expired keys |
| `redis` | `RedisConfig` | — | Enables distributed mode |
| `risk` | `RiskConfig` | — | Enables risk pipeline |
| `onError` | `(err) => void` | — | Redis error callback |

### `LimitConfig`

| Field | Type | Default | Description |
|---|---|---|---|
| `rate` | `number` | required | Max requests per window |
| `per` | `"1s"` / `"30m"` / `"2h"` | required | Window size |
| `by` | `"ip" \| "user" \| "ip+user" \| fn` | `"ip"` | Key extractor |
| `algorithm` | `"token-bucket" \| "sliding-window"` | `"token-bucket"` | Algorithm |

### `guard.check(identifier, route, cost?, riskCtx?): CheckResult`

| Field | Description |
|---|---|
| `allowed` | `true` if the request should proceed |
| `matchedRule` | Which config key was matched |
| `denylisted` | `true` if blocked by the denylist |
| `risk` | `RiskResult` — only present when `riskCtx` is passed |

### `RiskResult`

| Field | Description |
|---|---|
| `decision` | `"allow" \| "challenge" \| "block"` |
| `score` | Weighted score 0-1 |
| `breakdown` | Per-signal scores `Record<string, number>` |

### Built-in signals

| Signal | Factory | Description |
|---|---|---|
| Velocity | `velocitySignal(warnAt, blockAt)` | Request rate per window |
| Failed auth | `failedAuthSignal(warnAt, blockAt)` | Consecutive auth failures |
| IP reputation | `ipReputationSignal(lookup)` | Blocklist / MaxMind |
| Geo jump | `geoJumpSignal()` | Country changed since last request |
| Suspicious UA | `suspiciousUaSignal(patterns?)` | curl, scrapy, headless browsers |

---

## Benchmarks

Measured on Apple M2, Node 20, `connections=10, duration=5s`.

```
┌─────────────────────────────────────┬──────────────┬────────────┐
│ Scenario                            │ Requests/sec │ Latency p99│
├─────────────────────────────────────┼──────────────┼────────────┤
│ Baseline (no guard)                 │  ~85,000     │  < 1ms     │
│ Guard — token-bucket                │  ~78,000     │  < 1ms     │
│ Guard — token-bucket + 5 signals    │  ~71,000     │  < 1ms     │
│ rate-limiter-flexible (comparison)  │  ~55,000     │  1-2ms     │
└─────────────────────────────────────┴──────────────┴────────────┘

Overhead vs baseline:  ~8% (guard only)  |  ~16% (guard + risk)
```

Run yourself:
```bash
npm run bench
```

### Distributed accuracy

```
Nodes: 5  |  Global limit: 1000  |  Lease size: 50

Total allowed : 1000-1049  (typical)
Overshoot     : 0-4.9%
Undershoot    : 0%
```

The overshoot is bounded by `(nodes × leaseSize) - 1`. With 5 nodes and leaseSize=50 the worst-case overshoot is 249 requests (24.9%). In practice it is far lower because nodes exhaust their leases before the window closes. Reduce `leaseSize` to tighten accuracy at the cost of more Redis round-trips.

Run yourself:
```bash
npm run bench:accuracy
```

---

## Docker Compose (3-node cluster)

```bash
docker compose up
```

Starts Redis + 3 app nodes on ports 3001-3003. All nodes share the same Redis instance and denylist channel.

---

## E-commerce Example (single backend container + pm2)

A realistic setup for an e-commerce backend deployed in a single Docker container behind a VPC. No Redis needed at this scale — single-node mode is enough. Add `redis:` only when you scale to multiple backend containers.

```
VPC
├── Container 1: Frontend (Next.js / nginx)
└── Container 2: Backend (Express + pm2)   ← guard lives here only
         │
         └── DB, payment gateway, email service
```

```ts
// backend/src/middleware/rateLimit.ts
import { createGuard, expressMiddleware, velocitySignal, failedAuthSignal, suspiciousUaSignal } from "apiguardlimitjs";

export const guard = createGuard({
  limits: {
    // generous default for browsing
    default:                      { rate: 200, per: "1m",  by: "ip" },

    // auth — tightest limits, sliding-window prevents boundary bursts
    "POST /auth/login":           { rate: 5,   per: "1m",  by: "ip",   algorithm: "sliding-window" },
    "POST /auth/register":        { rate: 3,   per: "1h",  by: "ip",   algorithm: "sliding-window" },
    "POST /auth/forgot-password": { rate: 3,   per: "1h",  by: "ip",   algorithm: "sliding-window" },

    // checkout keyed by user, not IP (shared office/NAT IPs would false-positive)
    "POST /checkout":             { rate: 10,  per: "1h",  by: "user" },

    // coupon abuse — common in e-commerce
    "POST /apply-coupon":         { rate: 5,   per: "1h",  by: "user" },

    // search can be expensive (full DB query)
    "GET /products/search":       { rate: 30,  per: "1m",  by: "ip" },

    // password change requires auth, key by user
    "POST /account/password":     { rate: 3,   per: "1h",  by: "user" },
  },

  risk: {
    signals: [
      velocitySignal(100, 200),   // flag IPs hammering the API
      failedAuthSignal(3, 8),     // flag repeated login failures
      suspiciousUaSignal(),       // flag bots, curl, scrapy, headless browsers
    ],
    challengeThreshold: 0.5,
    blockThreshold: 0.8,
  },

  // if guard itself throws, don't take down the store
  onFailure: "fail-open",
  evictionIntervalMs: 60_000,
});

export const guardMiddleware = expressMiddleware(guard, {
  limits: {
    default:                      { by: "ip" },
    "POST /auth/login":           { by: "ip" },
    "POST /checkout":             { by: "user" },
    "POST /apply-coupon":         { by: "user" },
    "POST /account/password":     { by: "user" },
  },
  risk: true,
});
```

```ts
// backend/src/index.ts
import { guardMiddleware } from "./middleware/rateLimit";

app.use(guardMiddleware); // one line, covers all routes
```

### What each rule prevents

| Route | Threat | Without guard | With guard |
|---|---|---|---|
| `POST /auth/login` | Credential stuffing | 10k attempts in seconds | 5/min per IP → 33 hours |
| `POST /auth/register` | Fake account creation for coupon abuse | Unlimited | 3/hour per IP |
| `POST /auth/forgot-password` | Email cost attack (SES/SendGrid) | 50k emails, bill spikes | 3/hour per IP |
| `POST /checkout` | Stolen card probing (you pay gateway fees) | 1k card tests | 10/hour per user |
| `POST /apply-coupon` | Promo budget drain | Drained in minutes | 5/hour per user |
| `GET /products/search` | Competitor scraping | Full catalog in minutes | 30/min per IP |
| `suspiciousUaSignal` | Bot traffic (curl, scrapy, headless) | Unrestricted | Blocked at risk score |

### Overhead at this scale

```
Hot path cost per request:  ~350ns  (Map lookup + algorithm + 3 risk signals)

At 1,000 req/s  →  0.35ms CPU/s   negligible
At 5,000 req/s  →  1.75ms CPU/s   negligible
```

A typical e-commerce backend on a $20-50/month container will not feel this.

### When to add Redis

You don't need Redis with a single backend container. Add it only when you scale to multiple containers behind a load balancer — otherwise each container tracks limits independently and the effective limit becomes `rate × number of containers`.

```ts
// Add this to your existing config when you scale out:
redis: {
  client: new Redis(process.env.REDIS_URL),
  leaseSize: 50,
  lowWatermark: 0.2,
  denylist: true,
},
```

Everything else — limits, risk config, middleware — stays exactly the same.

---

## IP reputation with MaxMind GeoLite2

```ts
import { ReputationList } from "apiguardlimitjs";
import { createReadStream } from "fs";
import readline from "readline";

const rep = new ReputationList();
const rl = readline.createInterface({ input: createReadStream("GeoLite2-Anonymous-IP-Blocks.csv") });
rl.on("line", (line) => {
  const cidr = line.split(",")[0];
  if (cidr && !cidr.startsWith("network")) rep.add(cidr);
});
await new Promise((r) => rl.on("close", r));

const guard = createGuard({
  limits: { default: { rate: 100, per: "1m" } },
  risk: {
    signals: [ipReputationSignal((ip) => rep.contains(ip))],
    blockThreshold: 0.8,
  },
});
```

---

## Known trade-offs

| Trade-off | Detail |
|---|---|
| Distributed overshoot | Up to `nodes × leaseSize` extra requests near the limit. Tune `leaseSize` down to reduce. |
| First-request optimism | A new key always passes on the first request while the first lease is fetched. |
| Clock sensitivity | Uses `Date.now()`. NTP jumps can cause a free burst (token-bucket) or missed window rollover (sliding-window). Use a monotonic clock wrapper if this matters. |
| X-Forwarded-For spoofing | Set Express `trust proxy` correctly. Guard reads the header as-is; spoofed IPs bypass per-IP limits. |
| In-memory only | No persistence across restarts in single-node mode. Distributed mode survives restarts via Redis. |
