import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";
import { SERVER_CONFIG } from "../env.js";

const SESSION_COOKIE = "dashboard_session";

export interface SessionPayload {
  sub: "owner";
}

export function issueSessionToken(): string {
  return jwt.sign({ sub: "owner" } satisfies SessionPayload, SERVER_CONFIG.jwtSecret, {
    expiresIn: SERVER_CONFIG.sessionTtlSeconds,
  });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[SESSION_COOKIE] || extractBearerToken(req);
  if (!token) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  try {
    jwt.verify(token, SERVER_CONFIG.jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired session." });
  }
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
