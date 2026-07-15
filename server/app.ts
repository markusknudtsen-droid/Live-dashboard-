import express, { Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import authRoutes from "./routes/auth.js";
import portfolioRoutes from "./routes/portfolio.js";
import tradesRoutes from "./routes/trades.js";
import settingsRoutes from "./routes/settings.js";
import vaultRoutes from "./routes/vault.js";
import securityRoutes from "./routes/security.js";
import marketRoutes from "./routes/market.js";
import { requireAuth } from "./middleware/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST_DIR = path.resolve(__dirname, "../web/dist");

export function createApp(): Express {
  const app = express();

  app.use(
    cors({
      origin: process.env.DASHBOARD_CORS_ORIGIN?.split(",") || true,
      credentials: true,
    })
  );
  app.use(express.json({ limit: "256kb" }));
  app.use(cookieParser());

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: Date.now() });
  });

  app.use("/api/auth", authRoutes);

  // Everything below requires an authenticated session.
  app.use("/api/portfolio", requireAuth, portfolioRoutes);
  app.use("/api/trades", requireAuth, tradesRoutes);
  app.use("/api/settings", requireAuth, settingsRoutes);
  app.use("/api/vault", requireAuth, vaultRoutes);
  app.use("/api/security", requireAuth, securityRoutes);
  app.use("/api/market", requireAuth, marketRoutes);

  // Serve the built frontend, if present (production mode).
  app.use(express.static(WEB_DIST_DIR));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) {
      next();
      return;
    }
    res.sendFile(path.join(WEB_DIST_DIR, "index.html"), (err) => {
      if (err) next();
    });
  });

  return app;
}
