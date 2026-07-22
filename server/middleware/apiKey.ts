import { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { SERVER_CONFIG } from "../env.js";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function extractKey(req: Request): string | null {
  const headerKey = req.header("x-api-key");
  if (headerKey) return headerKey;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  return null;
}

/**
 * Authenticates machine-to-machine requests from the trading bot using the
 * shared DASHBOARD_INGEST_KEY. Separate from the session/JWT auth used by the
 * browser so the bot never needs a dashboard login.
 */
export function requireIngestKey(req: Request, res: Response, next: NextFunction): void {
  const configured = SERVER_CONFIG.ingestApiKey;
  if (!configured) {
    res.status(503).json({ error: "Trade ingestion is not configured. Set DASHBOARD_INGEST_KEY." });
    return;
  }
  const provided = extractKey(req);
  if (!provided || !safeEqual(provided, configured)) {
    res.status(401).json({ error: "Invalid or missing ingest API key." });
    return;
  }
  next();
}
