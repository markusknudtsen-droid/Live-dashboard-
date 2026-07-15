import { Router } from "express";
import rateLimitFactory from "./rateLimit.js";
import { SERVER_CONFIG } from "../env.js";
import { verifyPassword } from "../password.js";
import { issueSessionToken, SESSION_COOKIE_NAME } from "../middleware/auth.js";

const router = Router();
const loginLimiter = rateLimitFactory({ windowMs: 60_000, max: 5 });

router.post("/login", loginLimiter, (req, res) => {
  const { password } = req.body ?? {};
  if (typeof password !== "string" || password.length === 0) {
    res.status(400).json({ error: "Password is required." });
    return;
  }

  if (!verifyPassword(password, SERVER_CONFIG.dashboardPasswordHash)) {
    res.status(401).json({ error: "Invalid credentials." });
    return;
  }

  const token = issueSessionToken();
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SERVER_CONFIG.sessionTtlSeconds * 1000,
  });
  res.json({ token, expiresIn: SERVER_CONFIG.sessionTtlSeconds });
});

router.post("/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE_NAME);
  res.json({ ok: true });
});

export default router;
