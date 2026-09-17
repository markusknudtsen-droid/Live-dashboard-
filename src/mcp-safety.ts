/**
 * MCP paper-mode enforcement — MUST be the FIRST import of mcp-server.ts.
 *
 * In ESM, static imports are hoisted and evaluated before any module body
 * code, so assigning process.env inside mcp-server.ts itself would run AFTER
 * config.js has already built CONFIG from the environment. This side-effect
 * module has no imports of its own, so ESM evaluation order guarantees it
 * runs to completion before config.js (imported later in mcp-server.ts)
 * starts evaluating.
 *
 * createMemebotServer() additionally refuses to construct the server if
 * CONFIG.dryRun is somehow false, so a future import reordering fails loudly
 * instead of silently loading real-trading config.
 */
process.env.DRY_RUN = "true";
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "mcp-paper-mode";
