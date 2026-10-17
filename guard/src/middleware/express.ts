import type { Request, Response, NextFunction } from "express";
import type { Guard } from "../guard";
import type { LimitConfig } from "../config";

/** Extract identifier from request based on the "by" config */
function extractKey(req: Request, by: LimitConfig["by"] = "ip"): string {
  if (typeof by === "function") return by(req);

  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
    ?? req.socket?.remoteAddress
    ?? "unknown";

  // user may be attached by auth middleware
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const user: string = (req as any).user?.id ?? (req as any).user?.sub ?? "anon";

  if (by === "ip") return ip;
  if (by === "user") return user;
  return `${ip}:${user}`;
}

export function expressMiddleware(guard: Guard, limits: Record<string, { by?: LimitConfig["by"] }>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const route = `${req.method} ${req.path}`;
    const ruleName = limits[route] ? route : "default";
    const by = limits[ruleName]?.by ?? limits["default"]?.by ?? "ip";
    const identifier = extractKey(req, by);

    const result = guard.check(identifier, route);

    if (!result.allowed) {
      res.status(429).json({ error: "Too Many Requests", rule: result.matchedRule });
      return;
    }
    next();
  };
}
