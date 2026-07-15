import { Request, Response, NextFunction } from "express";

interface RateLimitOptions {
  windowMs: number;
  max: number;
}

/**
 * Minimal in-memory fixed-window rate limiter keyed by client IP.
 * Intended for a single-instance, single-user dashboard deployment.
 */
export default function rateLimit(options: RateLimitOptions) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    const key = req.ip || "unknown";
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    if (entry.count >= options.max) {
      res.status(429).json({ error: "Too many requests. Please try again shortly." });
      return;
    }

    entry.count += 1;
    next();
  };
}
