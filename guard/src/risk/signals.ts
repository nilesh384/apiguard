/**
 * A signal receives a request context and returns a score from 0 (no risk) to 1 (max risk).
 * Signals are pure functions — they must not mutate state.
 */
export interface SignalContext {
  identifier: string;
  route: string;
  /** Requests seen for this identifier in the current window */
  requestVelocity: number;
  /** Consecutive failed auth attempts (caller increments this) */
  failedAuthStreak: number;
  /** IP address string, e.g. "1.2.3.4" */
  ip: string;
  /** Previous IP seen for this identifier (undefined on first request) */
  previousIp?: string;
  /** User-agent header value */
  userAgent?: string;
  /** ISO country code from geo lookup, e.g. "US" */
  country?: string;
  /** Previous country seen for this identifier */
  previousCountry?: string;
}

export interface Signal {
  name: string;
  /** Weight applied to this signal's score in the final combination (default 1) */
  weight?: number;
  score(ctx: SignalContext): number;
}

// ── Built-in signals ──────────────────────────────────────────────────────────

/**
 * Velocity: score rises linearly once requests exceed `warnAt` and hits 1 at `blockAt`.
 */
export function velocitySignal(warnAt: number, blockAt: number): Signal {
  return {
    name: "velocity",
    score({ requestVelocity }) {
      if (requestVelocity <= warnAt) return 0;
      return Math.min(1, (requestVelocity - warnAt) / (blockAt - warnAt));
    },
  };
}

/**
 * Failed-auth streak: score rises linearly from `warnAt` streaks to 1 at `blockAt`.
 */
export function failedAuthSignal(warnAt: number, blockAt: number): Signal {
  return {
    name: "failed-auth",
    score({ failedAuthStreak }) {
      if (failedAuthStreak <= warnAt) return 0;
      return Math.min(1, (failedAuthStreak - warnAt) / (blockAt - warnAt));
    },
  };
}

/**
 * IP reputation: returns 1 if the IP is in the denylist, 0 otherwise.
 * Pass a `ReputationList` instance (see reputation.ts).
 */
export function ipReputationSignal(lookup: (ip: string) => boolean): Signal {
  return {
    name: "ip-reputation",
    score({ ip }) {
      return lookup(ip) ? 1 : 0;
    },
  };
}

/**
 * Geo/device jump: returns 1 if the country changed since the last request.
 * Caller is responsible for tracking previousCountry in SignalContext.
 */
export function geoJumpSignal(): Signal {
  return {
    name: "geo-jump",
    score({ country, previousCountry }) {
      if (!country || !previousCountry) return 0;
      return country !== previousCountry ? 1 : 0;
    },
  };
}

/**
 * Suspicious user-agent: matches against a list of known bad UA patterns.
 * Score is 1 on match, 0 otherwise.
 */
const DEFAULT_BAD_UA = [
  /python-requests/i,
  /go-http-client/i,
  /curl\//i,
  /wget\//i,
  /scrapy/i,
  /headlesschrome/i,
  /phantomjs/i,
];

export function suspiciousUaSignal(patterns: RegExp[] = DEFAULT_BAD_UA): Signal {
  return {
    name: "suspicious-ua",
    score({ userAgent }) {
      if (!userAgent) return 0;
      return patterns.some((p) => p.test(userAgent)) ? 1 : 0;
    },
  };
}
