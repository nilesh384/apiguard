# @your-org/guard

Sub-millisecond rate limiter for Node.js. The hot path is synchronous — no `await`, no Redis round-trip per request. Distributed sync happens in the background via token leasing (Phase 2).

## Architecture

```
request
  │
  ▼
guard.check(id, route)          ← synchronous, ~1µs
  │
  ├─ matchRule(route)           ← Map lookup
  ├─ MemoryStore.getOrCreate()  ← Map lookup + optional alloc
  └─ tokenBucketCheck() or
     slidingWindowCheck()       ← pure arithmetic, mutates state in place
```

Each node holds all rate-limit state in a `Map`. No network call on the hot path. In Phase 2, nodes lease a batch of tokens from Redis atomically and spend them locally until the lease runs low.

## Phase 1 — Single-node (current)

### Install

```bash
npm install @your-org/guard
```

### Usage

```ts
import { createGuard, expressMiddleware } from "@your-org/guard";

const guard = createGuard({
  limits: {
    default:       { rate: 100, per: "1m" },
    "POST /login": { rate: 5,   per: "1m", algorithm: "sliding-window" },
  },
  onFailure: "fail-open",   // allow requests if the store throws
});

// Express
app.use(expressMiddleware(guard, {
  default:       { by: "ip" },
  "POST /login": { by: "ip+user" },
}));
```

### Config reference

| Field | Type | Default | Description |
|---|---|---|---|
| `limits.default` | `LimitConfig` | required | Fallback limit for unmatched routes |
| `limits["METHOD /path"]` | `LimitConfig` | — | Per-route override |
| `onFailure` | `"fail-open" \| "fail-closed"` | `"fail-open"` | Behaviour when the store throws |
| `evictionIntervalMs` | `number` | `60000` | How often to sweep expired keys |

**LimitConfig**

| Field | Type | Default | Description |
|---|---|---|---|
| `rate` | `number` | required | Max requests per window |
| `per` | `"30s" \| "1m" \| "2h"` etc. | required | Window size |
| `by` | `"ip" \| "user" \| "ip+user" \| fn` | `"ip"` | Key extractor |
| `algorithm` | `"token-bucket" \| "sliding-window"` | `"token-bucket"` | Algorithm |

### Algorithms

**Token bucket** — tokens refill continuously. Allows short bursts up to `rate`, then throttles smoothly. Good default.

**Sliding window counter** — two-slot approximation. More accurate near the boundary than a fixed window, no per-request timestamp storage. Use for strict login/auth endpoints.

### Low-level API

```ts
const result = guard.check("user-123", "POST /login");
// { allowed: boolean, matchedRule: string }
```

`check()` is synchronous and allocation-free on the hot path (no object created if the key already exists in the Map).

## Roadmap

| Phase | Status | Description |
|---|---|---|
| 1 | ✅ done | Single-node, token-bucket + sliding-window, Express adapter |
| 2 | planned | Redis store, Lua lease scripts, background sync, pub/sub denylist, Docker Compose |
| 3 | planned | Risk scoring pipeline (velocity, failed-auth, geo-jump, UA signals) |
| 4 | planned | Fastify + Hono adapters, autocannon benchmarks, accuracy report |
| 5 | optional | Rust hot-path via napi-rs |

## Benchmarks

_Phase 1 — to be filled in after Phase 4 autocannon run._

Measured on: Apple M-series / AMD Ryzen (update with your hardware).

| Scenario | p50 | p99 |
|---|---|---|
| `check()` in-process | — | — |
| Express middleware, 1 route | — | — |

## Honest trade-offs

- **Phase 1**: perfectly accurate — all state is local.
- **Phase 2**: slight overshoot is possible when a lease is granted to multiple nodes simultaneously near the limit. The overshoot is bounded by `leaseSize × nodeCount`. This will be measured and reported.
- The sliding-window counter is an approximation (two fixed slots). It is more accurate than a pure fixed window but less accurate than a full per-request log.
