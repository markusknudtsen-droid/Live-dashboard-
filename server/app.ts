import express, { Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import authRoutes from "./routes/auth.js";
import portfolioRoutes from "./routes/portfolio.js";
import tradesRoutes from "./routes/trades.js";
import tradeIngestRoutes from "./routes/tradeIngest.js";
import settingsRoutes from "./routes/settings.js";
import vaultRoutes from "./routes/vault.js";
import securityRoutes from "./routes/security.js";
import marketRoutes from "./routes/market.js";
import { requireAuth } from "./middleware/auth.js";
import { requireIngestKey } from "./middleware/apiKey.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST_DIR = path.resolve(__dirname, "../web/dist");

export function createApp(): Express {
  const app = express();

  // This is a private, single-user dashboard. Only allow explicitly configured
  // origins (e.g. the Vite dev server); same-origin requests to the bundled
  // frontend always work regardless of this setting.
  const configuredOrigins = process.env.DASHBOARD_CORS_ORIGIN?.split(",").map((o) => o.trim()).filter(Boolean);
  app.use(
    cors({
      origin: configuredOrigins && configuredOrigins.length > 0 ? configuredOrigins : false,
      credentials: true,
    })
  );
  app.use(express.json({ limit: "256kb" }));
  app.use(cookieParser());

  // Coarse-grained rate limit applied directly to each mounted route (in
  // addition to the stricter, endpoint-specific limiters on login/withdraw/
  // wallet actions) so every authorized handler is covered by a limiter.
  const apiLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });

  app.get("/api/health", apiLimiter, (_req, res) => {
    res.json({ status: "ok", timestamp: Date.now() });
  });

  app.use("/api/auth", apiLimiter, authRoutes);

  // Machine-to-machine trade ingestion from the bot, authenticated by the
  // shared ingest API key (NOT the browser session). Mounted before the
  // session-protected /api/trades route so this more specific path wins.
  app.use("/api/trades/ingest", apiLimiter, requireIngestKey, tradeIngestRoutes);

  // Everything below requires an authenticated session.
  app.use("/api/portfolio", apiLimiter, requireAuth, portfolioRoutes);
  app.use("/api/trades", apiLimiter, requireAuth, tradesRoutes);
  app.use("/api/settings", apiLimiter, requireAuth, settingsRoutes);
  app.use("/api/vault", apiLimiter, requireAuth, vaultRoutes);
  app.use("/api/security", apiLimiter, requireAuth, securityRoutes);
  app.use("/api/market", apiLimiter, requireAuth, marketRoutes);

  // Serve the built frontend, if present (production mode).
  app.use(express.static(WEB_DIST_DIR));
  // Express 5 (path-to-regexp v6) requires a named wildcard segment for
  // catch-all routes; a bare "*" throws at startup. This app targets
  // Express 5+ specifically — this syntax is not valid on Express 4.
  app.get("/{*splat}", apiLimiter, (req, res, next) => {
    if (req.path.startsWith("/api/")) {
      next();
      return;
    }
    res.sendFile(path.join(WEB_DIST_DIR, "index.html"), (err) => {
      if (err) next();
    });
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  });

  return app;
}
