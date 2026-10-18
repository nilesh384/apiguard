import type { Context, MiddlewareHandler } from "hono";
import type { Guard } from "../guard";
import type { LimitConfig } from "../config";
import type { SignalContext } from "../risk/signals";

function extractIp(c: Context): string {
  const fwd = c.req.header("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  // Hono exposes CF-Connecting-IP on Cloudflare Workers
  return c.req.header("cf-connecting-ip") ?? "unknown";
}

export interface HonoGuardOptions {
  guard: Guard;
  limits: Record<string, { by?: LimitConfig["by"] }>;
  risk?: boolean;
}

export function honoMiddleware(opts: HonoGuardOptions): MiddlewareHandler {
  return async (c, next) => {
    const route = `${c.req.method} ${new URL(c.req.url).pathname}`;
    const ruleName = opts.limits[route] ? route : "default";
    const by = opts.limits[ruleName]?.by ?? opts.limits["default"]?.by ?? "ip";

    const ip = extractIp(c);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const user: string = (c as any).get?.("user")?.id ?? "anon";
    const identifier =
      typeof by === "function"
        ? by(c.req)
        : by === "user"
        ? user
        : by === "ip+user"
        ? `${ip}:${user}`
        : ip;

    const riskCtx: Partial<SignalContext> | undefined = opts.risk
      ? {
          ip,
          requestVelocity: 0,
          failedAuthStreak: 0,
          userAgent: c.req.header("user-agent"),
        }
      : undefined;

    const result = opts.guard.check(identifier, route, 1, riskCtx);

    if (!result.allowed) {
      return c.json(
        {
          error: "Too Many Requests",
          rule: result.matchedRule,
          ...(result.risk && { riskScore: result.risk.score }),
        },
        429
      );
    }
    await next();
  };
}
