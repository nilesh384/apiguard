import type { Request, Response, NextFunction } from "express";
import type { Guard } from "../guard";
import type { LimitConfig } from "../config";
import type { SignalContext } from "../risk/signals";

function extractIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"] as string | undefined;
  if (fwd) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress ?? "unknown";
}

function extractIdentifier(req: Request, by: LimitConfig["by"] = "ip"): string {
  if (typeof by === "function") return by(req);
  const ip = extractIp(req);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const user: string = (req as any).user?.id ?? (req as any).user?.sub ?? "anon";
  if (by === "user") return user;
  if (by === "ip+user") return `${ip}:${user}`;
  return ip;
}

export interface ExpressGuardOptions {
  limits: Record<string, { by?: LimitConfig["by"] }>;
  /** If true, populate riskCtx from the request for risk scoring */
  risk?: boolean;
}

export function expressMiddleware(guard: Guard, opts: ExpressGuardOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    const route = `${req.method} ${req.path}`;
    const ruleName = opts.limits[route] ? route : "default";
    const by = opts.limits[ruleName]?.by ?? opts.limits["default"]?.by ?? "ip";
    const identifier = extractIdentifier(req, by);

    const riskCtx: Partial<SignalContext> | undefined = opts.risk
      ? {
          ip: extractIp(req),
          requestVelocity: 0,
          failedAuthStreak: 0,
          userAgent: req.headers["user-agent"],
        }
      : undefined;

    const result = guard.check(identifier, route, 1, riskCtx);

    if (!result.allowed) {
      res.status(429).json({
        error: "Too Many Requests",
        rule: result.matchedRule,
        ...(result.risk && { riskScore: result.risk.score }),
      });
      return;
    }
    next();
  };
}
