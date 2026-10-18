import type { FastifyRequest, FastifyReply, FastifyPluginCallback } from "fastify";
import type { Guard } from "../guard";
import type { LimitConfig } from "../config";
import type { SignalContext } from "../risk/signals";

function extractIp(req: FastifyRequest): string {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return (Array.isArray(fwd) ? fwd[0] : fwd).split(",")[0].trim();
  return req.ip ?? "unknown";
}

export interface FastifyGuardOptions {
  guard: Guard;
  limits: Record<string, { by?: LimitConfig["by"] }>;
  /** If true, populate riskCtx from the request for risk scoring */
  risk?: boolean;
}

export const fastifyMiddleware: FastifyPluginCallback<FastifyGuardOptions> = (
  fastify,
  opts,
  done
) => {
  fastify.addHook("onRequest", (req, reply, next) => {
    const route = `${req.method} ${req.routeOptions?.url ?? req.url}`;
    const ruleName = opts.limits[route] ? route : "default";
    const by = opts.limits[ruleName]?.by ?? opts.limits["default"]?.by ?? "ip";

    const ip = extractIp(req);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const user: string = (req as any).user?.id ?? (req as any).user?.sub ?? "anon";
    const identifier =
      typeof by === "function"
        ? by(req)
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
          userAgent: req.headers["user-agent"],
        }
      : undefined;

    const result = opts.guard.check(identifier, route, 1, riskCtx);

    if (!result.allowed) {
      reply.status(429).send({
        error: "Too Many Requests",
        rule: result.matchedRule,
        ...(result.risk && { riskScore: result.risk.score }),
      });
      return;
    }
    next();
  });
  done();
};
