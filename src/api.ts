import express, { Express } from 'express';
import cors from 'cors';
import ipaddr from 'ipaddr.js';
import { fileURLToPath } from 'node:url';
import { loadStateStrict, isRestorablePosition } from './persistence.js';
import { logger } from './logger.js';

const PORT = process.env.PORT || 3000;
// Loopback-only by default — this is an unauthenticated read-only API that
// exposes real position data, and app.listen() defaults to ALL interfaces
// (0.0.0.0), not just localhost. Only set API_HOST to something else if you
// specifically intend to expose it beyond this machine, and put your own
// auth/network controls (reverse proxy, firewall) in front of it first.
const HOST = process.env.API_HOST || '127.0.0.1';
// Same reasoning for CORS: cors() with no options reflects Access-Control-
// Allow-Origin: * (any website's JS can read the response). Default to
// same-origin only; opt into specific browser origins via a comma-separated
// API_CORS_ORIGIN, same convention as DASHBOARD_CORS_ORIGIN in the
// Live-dashboard- repo's server.
const allowedOrigins = (process.env.API_CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// Whether a hostname is loopback-only address space: "localhost", or an IP
// address ipaddr.js classifies as loopback — the full 127.0.0.0/8 range
// (not just 127.0.0.1), IPv6 ::1 in any valid spelling (including the fully
// expanded 0:0:0:0:0:0:0:1), and IPv4-mapped IPv6 loopback forms like
// ::ffff:127.0.0.1 or ::ffff:7f00:1. An earlier hand-rolled version of this
// only matched the exact strings "127.0.0.1"/"::1"/"[::1]", then only the
// 127.0.0.0/8 range — both missed real loopback spellings a user could put
// in API_HOST and have it bind successfully, which would silently disable
// the DNS-rebinding guard below entirely (the guard is only installed when
// this returns true for HOST). Parsing IP addresses correctly, including
// IPv4-mapped IPv6, needs a real parser rather than more regex.
//
// Called both on the raw API_HOST env value (Node's net.Server.listen()
// wants the unbracketed "::1" form, case as typed, no trailing dot) and on
// Host headers parsed via URL (whose .hostname lowercases automatically and
// brackets IPv6 as "[::1]", but doesn't strip a trailing "." FQDN root) —
// normalize case, a trailing dot, and IPv6 brackets up front so both call
// sites, and DNS's own case/FQDN insensitivity (API_HOST=LOCALHOST or
// "localhost." still binds to loopback), are handled the same way.
// Accepting the whole loopback space doesn't weaken the check against DNS
// rebinding: rebinding only changes what a domain NAME resolves to, it
// can't rewrite the browser's address bar to show a raw loopback literal —
// it just stops a merely-different-looking loopback address from falling
// through it. Exported so its edge cases can be unit-tested directly.
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (normalized === "localhost") return true;
  const candidate = normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;
  if (!ipaddr.isValid(candidate)) return false;
  let addr: ipaddr.IPv4 | ipaddr.IPv6 = ipaddr.parse(candidate);
  if (addr instanceof ipaddr.IPv6 && addr.isIPv4MappedAddress()) {
    addr = addr.toIPv4Address();
  }
  return addr.range() === "loopback";
}

/**
 * Builds the Express app without binding it to a port — split out from the
 * app.listen() call below so tests can drive it directly (supertest-style,
 * or a real ephemeral-port listener) instead of only being able to exercise
 * this over the real configured PORT/HOST as a side effect of importing the
 * module.
 *
 * `overrides` lets tests exercise multiple HOST/API_CORS_ORIGIN
 * configurations against one imported module instance — env vars are only
 * read once, at module load, so re-importing with a different process.env
 * doesn't work the way it does in test files with no top-level config state.
 * The real entrypoint below always calls this with no arguments, so
 * production behavior is exactly the env-derived HOST/allowedOrigins above.
 */
export function createApp(overrides?: { host?: string; allowedOrigins?: string[] }): Express {
  const host = overrides?.host ?? HOST;
  const origins = overrides?.allowedOrigins ?? allowedOrigins;
  const app = express();

  // DNS-rebinding protection. A page loaded from evil.com can have evil.com's
  // DNS rebound mid-session to a loopback address; a subsequent fetch() from
  // that page still looks same-origin to the browser (no CORS check even
  // triggers, since CORS only governs cross-origin requests) but actually
  // lands on this loopback-bound server with a Host header naming evil.com.
  // The origin allowlist below can't stop this — it never sees the request.
  // Reject anything whose Host header's hostname isn't loopback. Only the
  // hostname is checked, not the port: the listening socket already
  // determines which port a request had to reach, and a mismatch there (e.g.
  // PORT=0 for an OS-assigned ephemeral port, or a request to the default
  // HTTP port 80 where browsers omit the port from Host entirely) would
  // otherwise reject legitimate requests. Only enforced when bound to
  // loopback; HOST=0.0.0.0 or similar is an explicit opt-in to expose this
  // beyond the machine, and the docs already say to put your own auth/network
  // controls in front of it first if you do.
  if (isLoopbackHostname(host)) {
    app.use((req, res, next) => {
      const hostHeader = req.headers.host;
      let hostname: string | undefined;
      try {
        hostname = hostHeader ? new URL(`http://${hostHeader}`).hostname : undefined;
      } catch {
        hostname = undefined;
      }
      if (!hostname || !isLoopbackHostname(hostname)) {
        res.status(403).json({ error: "Forbidden: invalid Host header" });
        return;
      }
      next();
    });
  }

  // Only attach CORS at all when origins are explicitly configured. cors()
  // with no options sets Access-Control-Allow-Origin: * — omitting the
  // middleware entirely (not calling it with a permissive default) is what
  // actually restricts browsers to same-origin requests; CORS headers are
  // what grant cross-origin access, so absent headers means the browser's
  // own same-origin policy applies. Non-browser tools (curl, the bot itself)
  // are unaffected either way — CORS only constrains browser JS.
  if (origins.length > 0) {
    app.use(cors({ origin: origins }));
  }
  app.use(express.json());

  app.get('/api/positions', async (req, res) => {
    try {
      // loadStateStrict() (unlike loadState()) only treats a missing file as
      // "no positions yet" — a genuine read/parse failure is rethrown here
      // and reported as a 500, rather than silently looking identical to an
      // empty portfolio.
      const state = await loadStateStrict();
      // parseStateFile() deliberately preserves a null/non-object entry
      // (rather than crashing or dropping the whole array) so
      // isRestorablePosition can reject it individually — this route reuses
      // that same shape check (without its DRYRUN- exclusion; see
      // persistence.ts) rather than a shallow non-null-object check, which
      // would still let a malformed-but-object-shaped entry (e.g. `{}`)
      // through as a response record full of undefined fields instead of
      // being skipped.
      const uiPositions = state.activePositions
        .filter(isRestorablePosition)
        .map(p => ({
          symbol: p.tokenSymbol,
          name: p.tokenSymbol,
          mint: p.tokenAddress,
          amount: p.amountSol,
          entryUsd: p.entryPrice,
          currentUsd: p.currentPrice
        }));
      res.json(uiPositions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to load positions for API request: ${message}`);
      res.status(500).json({ error: "Failed to load positions" });
    }
  });

  return app;
}

// Only bind a port when this file is run directly (`npm run api`), not when
// it's imported — e.g. by tests, which build the app via createApp() and
// drive it against their own ephemeral listener instead.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
const server = createApp().listen(Number(PORT), HOST, () => {
  // A bare IPv6 literal (e.g. "::1") must be bracketed to form a valid
  // URL ("http://[::1]:3000") — but net.Server.listen() above wants the
  // unbracketed form, so this display-only formatting is kept separate
  // from the HOST value actually passed to listen().
  const displayHost = HOST.includes(":") && !HOST.startsWith("[") ? `[${HOST}]` : HOST;
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : PORT;
  console.log(
    `🚀 Bot API Server running on http://${displayHost}:${actualPort} (loopback-only unless API_HOST is set)`
  );
});
}
