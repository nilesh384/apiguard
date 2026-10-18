"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  Denylist: () => Denylist,
  Guard: () => Guard,
  LeaseManager: () => LeaseManager,
  ReputationList: () => ReputationList,
  RiskScorer: () => RiskScorer,
  createGuard: () => createGuard,
  expressMiddleware: () => expressMiddleware,
  failedAuthSignal: () => failedAuthSignal,
  fastifyMiddleware: () => fastifyMiddleware,
  geoJumpSignal: () => geoJumpSignal,
  honoMiddleware: () => honoMiddleware,
  ipReputationSignal: () => ipReputationSignal,
  suspiciousUaSignal: () => suspiciousUaSignal,
  velocitySignal: () => velocitySignal
});
module.exports = __toCommonJS(index_exports);

// src/config.ts
function parseWindow(per) {
  const unit = per.slice(-1);
  const n = parseInt(per.slice(0, -1), 10);
  if (unit === "s") return n * 1e3;
  if (unit === "m") return n * 6e4;
  return n * 36e5;
}
function normalizeLimit(cfg) {
  return {
    rate: cfg.rate,
    windowMs: parseWindow(cfg.per),
    by: cfg.by ?? "ip",
    algorithm: cfg.algorithm ?? "token-bucket"
  };
}

// src/algorithms/token-bucket.ts
function tokenBucketCheck(state, capacity, windowMs, cost = 1, nowMs = Date.now()) {
  const elapsed = nowMs - state.lastRefillAt;
  const refill = elapsed / windowMs * capacity;
  state.tokens = Math.min(capacity, state.tokens + refill);
  state.lastRefillAt = nowMs;
  if (state.tokens >= cost) {
    state.tokens -= cost;
    return true;
  }
  return false;
}
function newBucketState(capacity, nowMs = Date.now()) {
  return { tokens: capacity, lastRefillAt: nowMs };
}

// src/algorithms/sliding-window.ts
function slidingWindowCheck(state, limit, windowMs, cost = 1, nowMs = Date.now()) {
  const elapsed = nowMs - state.windowStart;
  if (elapsed >= windowMs * 2) {
    state.prevCount = 0;
    state.currCount = 0;
    state.windowStart = nowMs;
  } else if (elapsed >= windowMs) {
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
function newWindowState(nowMs = Date.now()) {
  return { prevCount: 0, currCount: 0, windowStart: nowMs };
}

// src/store/memory.ts
var MemoryStore = class {
  constructor(evictionIntervalMs = 6e4) {
    this.map = /* @__PURE__ */ new Map();
    this.timer = null;
    this.timer = setInterval(() => this.evict(), evictionIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }
  getOrCreate(key, algo, capacity, windowMs, nowMs = Date.now()) {
    const existing = this.map.get(key);
    if (existing && existing.expiresAt > nowMs) return existing.state;
    const state = algo === "token-bucket" ? newBucketState(capacity, nowMs) : newWindowState(nowMs);
    this.map.set(key, { state, algo, expiresAt: nowMs + windowMs * 2 });
    return state;
  }
  /** Refresh TTL on access so active keys don't get evicted */
  touch(key, windowMs, nowMs = Date.now()) {
    const e = this.map.get(key);
    if (e) e.expiresAt = nowMs + windowMs * 2;
  }
  evict(nowMs = Date.now()) {
    for (const [key, entry] of this.map) {
      if (entry.expiresAt <= nowMs) this.map.delete(key);
    }
  }
  size() {
    return this.map.size;
  }
  destroy() {
    if (this.timer) clearInterval(this.timer);
    this.map.clear();
  }
};

// src/store/redis.ts
var LEASE_SCRIPT = `
local current = tonumber(redis.call("GET", KEYS[1])) or 0
local limit   = tonumber(ARGV[1])
local lease   = tonumber(ARGV[2])
local ttl     = tonumber(ARGV[3])
local available = limit - current
if available <= 0 then return 0 end
local granted = math.min(lease, available)
redis.call("INCRBY", KEYS[1], granted)
redis.call("PEXPIRE", KEYS[1], ttl)
return granted
`;
var RedisStore = class {
  constructor(client) {
    this.client = client;
  }
  /**
   * Atomically acquire up to `leaseSize` tokens from the global counter.
   * Returns the number of tokens granted (0 = globally exhausted).
   */
  async acquireLease(key, globalLimit, leaseSize, windowMs) {
    const granted = await this.client.eval(
      LEASE_SCRIPT,
      1,
      key,
      globalLimit,
      leaseSize,
      windowMs
    );
    return typeof granted === "number" ? granted : 0;
  }
  /**
   * Push a count delta to Redis (used by sliding-window background sync).
   */
  async syncCount(key, delta, windowMs) {
    if (delta <= 0) return;
    await this.client.eval(
      `redis.call("INCRBY", KEYS[1], ARGV[1]); redis.call("PEXPIRE", KEYS[1], ARGV[2]); return 1`,
      1,
      key,
      delta,
      windowMs
    );
  }
  // ── Store interface (delegates to in-memory; Redis is background-only) ──
  getOrCreate(_key, algo, capacity, _windowMs, nowMs = Date.now()) {
    return algo === "token-bucket" ? newBucketState(capacity, nowMs) : newWindowState(nowMs);
  }
  touch() {
  }
  evict() {
  }
  size() {
    return 0;
  }
  async destroy() {
    await this.client.quit();
  }
};

// src/sync/lease-manager.ts
var LeaseManager = class {
  constructor(redis, opts) {
    this.redis = redis;
    this.opts = opts;
    this.leases = /* @__PURE__ */ new Map();
  }
  /**
   * Consume one token from the local lease for `key`.
   * Triggers a background refill when the budget is low.
   * Returns false only when the local budget is fully exhausted.
   */
  consume(key, cost = 1) {
    let entry = this.leases.get(key);
    if (!entry) {
      this.refill(key);
      return true;
    }
    if (entry.tokens < cost) return false;
    entry.tokens -= cost;
    if (entry.tokens <= this.opts.leaseSize * this.opts.lowWatermark && !entry.refilling) {
      this.refill(key);
    }
    return true;
  }
  refill(key) {
    let entry = this.leases.get(key);
    if (!entry) {
      entry = { tokens: 0, refilling: true };
      this.leases.set(key, entry);
    }
    entry.refilling = true;
    this.redis.acquireLease(key, this.opts.globalLimit, this.opts.leaseSize, this.opts.windowMs).then((granted) => {
      const e = this.leases.get(key);
      e.tokens += granted;
      e.refilling = false;
    }).catch((err) => {
      const e = this.leases.get(key);
      if (e) e.refilling = false;
      this.opts.onError?.(err);
    });
  }
  clear() {
    this.leases.clear();
  }
  localTokens(key) {
    return this.leases.get(key)?.tokens ?? 0;
  }
};

// src/sync/denylist.ts
var CHANNEL = "guard:denylist";
var Denylist = class {
  constructor(client, onError) {
    this.client = client;
    this.onError = onError;
    this.blocked = /* @__PURE__ */ new Set();
    this.subscribed = false;
  }
  async subscribe() {
    if (this.subscribed) return;
    this.subscribed = true;
    await this.client.subscribe(CHANNEL, (message) => {
      this.blocked.add(message);
    });
  }
  /** Block a key locally and publish to all other nodes */
  async block(key) {
    this.blocked.add(key);
    try {
      await this.client.publish(CHANNEL, key);
    } catch (err) {
      this.onError?.(err);
    }
  }
  isBlocked(key) {
    return this.blocked.has(key);
  }
  unblock(key) {
    this.blocked.delete(key);
  }
  async destroy() {
    try {
      await this.client.unsubscribe(CHANNEL);
    } catch (err) {
      this.onError?.(err);
    }
    this.blocked.clear();
  }
};

// src/risk/scorer.ts
var RiskScorer = class {
  constructor(opts) {
    this.signals = opts.signals;
    this.challengeAt = opts.challengeThreshold ?? 0.5;
    this.blockAt = opts.blockThreshold ?? 0.8;
  }
  evaluate(ctx) {
    let weightedSum = 0;
    let totalWeight = 0;
    const breakdown = {};
    for (const signal of this.signals) {
      const w = signal.weight ?? 1;
      const s = Math.max(0, Math.min(1, signal.score(ctx)));
      breakdown[signal.name] = s;
      weightedSum += s * w;
      totalWeight += w;
    }
    const score = totalWeight === 0 ? 0 : weightedSum / totalWeight;
    let decision = "allow";
    if (score >= this.blockAt) decision = "block";
    else if (score >= this.challengeAt) decision = "challenge";
    return { decision, score, breakdown };
  }
};

// src/guard.ts
var Guard = class {
  constructor(config) {
    this.store = new MemoryStore(config.evictionIntervalMs);
    this.onFailure = config.onFailure ?? "fail-open";
    this.rules = /* @__PURE__ */ new Map();
    for (const [route, limit] of Object.entries(config.limits)) {
      this.rules.set(route, normalizeLimit(limit));
    }
    if (config.risk) {
      this.scorer = new RiskScorer(config.risk);
    }
    if (config.redis) {
      const { client, leaseSize = 50, lowWatermark = 0.2, denylist = true } = config.redis;
      const redisStore = new RedisStore(client);
      this.leaseManagers = /* @__PURE__ */ new Map();
      for (const [route, limit] of this.rules) {
        this.leaseManagers.set(
          route,
          new LeaseManager(redisStore, {
            leaseSize,
            lowWatermark,
            globalLimit: limit.rate,
            windowMs: limit.windowMs,
            onError: config.onError
          })
        );
      }
      if (denylist) {
        this.denylist = new Denylist(client, config.onError);
        this.denylist.subscribe().catch(config.onError);
      }
    }
  }
  /**
   * Synchronous hot-path check.
   * Runs risk pipeline first (if configured), then rate-limit check.
   * Risk "block" decisions short-circuit the rate-limit check.
   */
  check(identifier, route, cost = 1, riskCtx) {
    const matchedRule = this.matchRule(route);
    const limit = this.rules.get(matchedRule);
    const storeKey = `${matchedRule}:${identifier}`;
    if (this.denylist?.isBlocked(storeKey)) {
      return { allowed: false, matchedRule, denylisted: true };
    }
    let risk;
    if (this.scorer && riskCtx) {
      const ctx = {
        identifier,
        route,
        requestVelocity: 0,
        failedAuthStreak: 0,
        ip: identifier,
        ...riskCtx
      };
      risk = this.scorer.evaluate(ctx);
      if (risk.decision === "block") {
        return { allowed: false, matchedRule, risk };
      }
    }
    try {
      if (this.leaseManagers) {
        const lm = this.leaseManagers.get(matchedRule);
        const allowed2 = lm.consume(storeKey, cost);
        return { allowed: allowed2, matchedRule, risk };
      }
      const state = this.store.getOrCreate(storeKey, limit.algorithm, limit.rate, limit.windowMs);
      this.store.touch(storeKey, limit.windowMs);
      let allowed;
      if (limit.algorithm === "token-bucket") {
        allowed = tokenBucketCheck(state, limit.rate, limit.windowMs, cost);
      } else {
        allowed = slidingWindowCheck(state, limit.rate, limit.windowMs, cost);
      }
      return { allowed, matchedRule, risk };
    } catch {
      return { allowed: this.onFailure === "fail-open", matchedRule, risk };
    }
  }
  async blockIdentifier(identifier, route) {
    if (!this.denylist) return;
    const matchedRule = this.matchRule(route);
    await this.denylist.block(`${matchedRule}:${identifier}`);
  }
  unblockIdentifier(identifier, route) {
    if (!this.denylist) return;
    const matchedRule = this.matchRule(route);
    this.denylist.unblock(`${matchedRule}:${identifier}`);
  }
  matchRule(route) {
    if (this.rules.has(route)) return route;
    return "default";
  }
  async destroy() {
    this.store.destroy();
    this.leaseManagers?.forEach((lm) => lm.clear());
    await this.denylist?.destroy();
  }
};
function createGuard(config) {
  return new Guard(config);
}

// src/middleware/express.ts
function extractIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress ?? "unknown";
}
function extractIdentifier(req, by = "ip") {
  if (typeof by === "function") return by(req);
  const ip = extractIp(req);
  const user = req.user?.id ?? req.user?.sub ?? "anon";
  if (by === "user") return user;
  if (by === "ip+user") return `${ip}:${user}`;
  return ip;
}
function expressMiddleware(guard, opts) {
  return (req, res, next) => {
    const route = `${req.method} ${req.path}`;
    const ruleName = opts.limits[route] ? route : "default";
    const by = opts.limits[ruleName]?.by ?? opts.limits["default"]?.by ?? "ip";
    const identifier = extractIdentifier(req, by);
    const riskCtx = opts.risk ? {
      ip: extractIp(req),
      requestVelocity: 0,
      failedAuthStreak: 0,
      userAgent: req.headers["user-agent"]
    } : void 0;
    const result = guard.check(identifier, route, 1, riskCtx);
    if (!result.allowed) {
      res.status(429).json({
        error: "Too Many Requests",
        rule: result.matchedRule,
        ...result.risk && { riskScore: result.risk.score }
      });
      return;
    }
    next();
  };
}

// src/middleware/fastify.ts
function extractIp2(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return (Array.isArray(fwd) ? fwd[0] : fwd).split(",")[0].trim();
  return req.ip ?? "unknown";
}
var fastifyMiddleware = (fastify, opts, done) => {
  fastify.addHook("onRequest", (req, reply, next) => {
    const route = `${req.method} ${req.routeOptions?.url ?? req.url}`;
    const ruleName = opts.limits[route] ? route : "default";
    const by = opts.limits[ruleName]?.by ?? opts.limits["default"]?.by ?? "ip";
    const ip = extractIp2(req);
    const user = req.user?.id ?? req.user?.sub ?? "anon";
    const identifier = typeof by === "function" ? by(req) : by === "user" ? user : by === "ip+user" ? `${ip}:${user}` : ip;
    const riskCtx = opts.risk ? {
      ip,
      requestVelocity: 0,
      failedAuthStreak: 0,
      userAgent: req.headers["user-agent"]
    } : void 0;
    const result = opts.guard.check(identifier, route, 1, riskCtx);
    if (!result.allowed) {
      reply.status(429).send({
        error: "Too Many Requests",
        rule: result.matchedRule,
        ...result.risk && { riskScore: result.risk.score }
      });
      return;
    }
    next();
  });
  done();
};

// src/middleware/hono.ts
function extractIp3(c) {
  const fwd = c.req.header("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return c.req.header("cf-connecting-ip") ?? "unknown";
}
function honoMiddleware(opts) {
  return async (c, next) => {
    const route = `${c.req.method} ${new URL(c.req.url).pathname}`;
    const ruleName = opts.limits[route] ? route : "default";
    const by = opts.limits[ruleName]?.by ?? opts.limits["default"]?.by ?? "ip";
    const ip = extractIp3(c);
    const user = c.get?.("user")?.id ?? "anon";
    const identifier = typeof by === "function" ? by(c.req) : by === "user" ? user : by === "ip+user" ? `${ip}:${user}` : ip;
    const riskCtx = opts.risk ? {
      ip,
      requestVelocity: 0,
      failedAuthStreak: 0,
      userAgent: c.req.header("user-agent")
    } : void 0;
    const result = opts.guard.check(identifier, route, 1, riskCtx);
    if (!result.allowed) {
      return c.json(
        {
          error: "Too Many Requests",
          rule: result.matchedRule,
          ...result.risk && { riskScore: result.risk.score }
        },
        429
      );
    }
    await next();
  };
}

// src/risk/signals.ts
function velocitySignal(warnAt, blockAt) {
  return {
    name: "velocity",
    score({ requestVelocity }) {
      if (requestVelocity <= warnAt) return 0;
      return Math.min(1, (requestVelocity - warnAt) / (blockAt - warnAt));
    }
  };
}
function failedAuthSignal(warnAt, blockAt) {
  return {
    name: "failed-auth",
    score({ failedAuthStreak }) {
      if (failedAuthStreak <= warnAt) return 0;
      return Math.min(1, (failedAuthStreak - warnAt) / (blockAt - warnAt));
    }
  };
}
function ipReputationSignal(lookup) {
  return {
    name: "ip-reputation",
    score({ ip }) {
      return lookup(ip) ? 1 : 0;
    }
  };
}
function geoJumpSignal() {
  return {
    name: "geo-jump",
    score({ country, previousCountry }) {
      if (!country || !previousCountry) return 0;
      return country !== previousCountry ? 1 : 0;
    }
  };
}
var DEFAULT_BAD_UA = [
  /python-requests/i,
  /go-http-client/i,
  /curl\//i,
  /wget\//i,
  /scrapy/i,
  /headlesschrome/i,
  /phantomjs/i
];
function suspiciousUaSignal(patterns = DEFAULT_BAD_UA) {
  return {
    name: "suspicious-ua",
    score({ userAgent }) {
      if (!userAgent) return 0;
      return patterns.some((p) => p.test(userAgent)) ? 1 : 0;
    }
  };
}

// src/risk/reputation.ts
var ReputationList = class {
  constructor() {
    this.exact = /* @__PURE__ */ new Set();
    /** [networkInt, maskInt][] */
    this.cidrs = [];
  }
  add(entry) {
    entry = entry.trim();
    if (!entry || entry.startsWith("#")) return;
    if (entry.includes("/")) {
      const parsed = parseCidr(entry);
      if (parsed) this.cidrs.push(parsed);
    } else {
      this.exact.add(entry);
    }
  }
  /** Load from a newline-delimited string (e.g. file contents) */
  loadText(text) {
    for (const line of text.split("\n")) this.add(line);
  }
  contains(ip) {
    if (this.exact.has(ip)) return true;
    const n = ipToInt(ip);
    if (n === null) return false;
    for (const [network, mask] of this.cidrs) {
      if ((n & mask) >>> 0 === network) return true;
    }
    return false;
  }
  size() {
    return this.exact.size + this.cidrs.length;
  }
  clear() {
    this.exact.clear();
    this.cidrs = [];
  }
};
function ipToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const byte = parseInt(p, 10);
    if (isNaN(byte) || byte < 0 || byte > 255) return null;
    n = n << 8 | byte;
  }
  return n >>> 0;
}
function parseCidr(cidr) {
  const [ipPart, prefixPart] = cidr.split("/");
  const prefix = parseInt(prefixPart, 10);
  if (isNaN(prefix) || prefix < 0 || prefix > 32) return null;
  const n = ipToInt(ipPart);
  if (n === null) return null;
  const mask = prefix === 0 ? 0 : ~0 << 32 - prefix >>> 0;
  return [(n & mask) >>> 0, mask];
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Denylist,
  Guard,
  LeaseManager,
  ReputationList,
  RiskScorer,
  createGuard,
  expressMiddleware,
  failedAuthSignal,
  fastifyMiddleware,
  geoJumpSignal,
  honoMiddleware,
  ipReputationSignal,
  suspiciousUaSignal,
  velocitySignal
});
//# sourceMappingURL=index.cjs.map