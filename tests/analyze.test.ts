import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// Stand in for OpenRouter so analyzeToken()'s actual network path — URL,
// headers, response parsing, and the error/empty-response fallback — is
// covered by a real HTTP round-trip instead of only the pure helpers
// (buildAnalysisRequestBody, parseAnalysisJson) tested elsewhere in this
// file. Same convention as tests/jupiter-client.test.ts.
let mockResponse: { status: number; body: unknown } = { status: 200, body: {} };
let lastRequest: { path: string; authorization: string | undefined } | null = null;

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    lastRequest = { path: req.url || "", authorization: req.headers.authorization };
    res.statusCode = mockResponse.status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(mockResponse.body));
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
const { port } = server.address() as AddressInfo;

const previousEnv = {
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENROUTER_API_URL: process.env.OPENROUTER_API_URL,
  HTTP_MAX_RETRIES: process.env.HTTP_MAX_RETRIES,
};
process.env.OPENROUTER_API_KEY = "test";
process.env.OPENROUTER_API_URL = `http://127.0.0.1:${port}`;
process.env.HTTP_MAX_RETRIES = "0";

const {
  parseAnalysisJson,
  looksLikeAnalysis,
  noteAnalysisOutcome,
  resetAnalysisFailureTracking,
  buildAnalysisRequestBody,
  analyzeToken,
} = await import("../src/analyze.js");
const { logger } = await import("../src/logger.js");
const { CONFIG } = await import("../src/config.js");
type TokenCandidateT = import("../src/scanner.js").TokenCandidate;

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const CANDIDATE: TokenCandidateT = {
  address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  symbol: "BONK",
  name: "Bonk",
  chainId: "solana",
  pairAddress: "pair1",
  priceUsd: 0.00002,
  priceChange5m: 1,
  priceChange1h: 5,
  priceChange6h: 10,
  priceChange24h: 20,
  volume24h: 1_000_000,
  volumeChange: 0,
  liquidityUsd: 500_000,
  marketCap: 100_000_000,
  txns24hBuys: 800,
  txns24hSells: 200,
  buyToSellRatio: 0.8,
  pairCreatedAt: Date.now() - 3_600_000,
  ageHours: 1,
  url: "https://dexscreener.com/solana/pair1",
};

// Regression coverage for the exact outgoing request shape. Nothing else in
// this file exercises analyzeToken()'s network call, so without this, a
// hardcoded model creeping back in, or reasoning/provider.require_parameters
// getting dropped in some future refactor, would leave the suite green
// while silently reintroducing the failures earlier PR rounds fixed.
test("buildAnalysisRequestBody uses the configured model, not a hardcoded one", () => {
  const body = buildAnalysisRequestBody(CANDIDATE);
  assert.equal(body.model, CONFIG.openRouterModel);
});

test("buildAnalysisRequestBody sends strict json_schema structured output", () => {
  const body = buildAnalysisRequestBody(CANDIDATE) as { response_format: { type: string; json_schema: { strict: boolean } } };
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.strict, true);
});

test("buildAnalysisRequestBody forces reasoning off", () => {
  const body = buildAnalysisRequestBody(CANDIDATE);
  assert.deepEqual(body.reasoning, { effort: "none" });
});

test("buildAnalysisRequestBody requires provider parameter compatibility", () => {
  const body = buildAnalysisRequestBody(CANDIDATE);
  assert.deepEqual(body.provider, { require_parameters: true });
});

test("buildAnalysisRequestBody includes the candidate's data in the prompt", () => {
  const body = buildAnalysisRequestBody(CANDIDATE) as { messages: Array<{ role: string; content: string }> };
  const userMessage = body.messages.find((m) => m.role === "user");
  assert.ok(userMessage, "a user message with the analysis prompt must be present");
  assert.match(userMessage!.content, /BONK/);
});

// Token symbol/name are attacker-controlled (Solana token creation is
// permissionless) and are now sanitized once at the source — text-sanitize.ts's
// sanitizeDisplayText, applied in scanner.ts's parsePairToCandidate — rather than
// here, so every consumer of a TokenCandidate (this prompt, several logger
// calls across analyze.ts/index.ts/trader.ts/dashboard-reporter.ts) gets a
// safe value without needing its own sanitization. See
// tests/scanner.test.ts for that sanitization's coverage; this just
// confirms the prompt-building step passes the (already-clean) fields
// through as-is.
test("buildAnalysisRequestBody includes the candidate's symbol/name verbatim in the prompt", () => {
  const candidate: TokenCandidateT = { ...CANDIDATE, symbol: "WEIRD but clean-ish text", name: "Also Clean" };
  const body = buildAnalysisRequestBody(candidate) as { messages: Array<{ role: string; content: string }> };
  const userMessage = body.messages.find((m) => m.role === "user")!;
  assert.match(userMessage.content, /WEIRD but clean-ish text \(Also Clean\)/);
});

test("buildAnalysisRequestBody's system prompt warns the model that token symbol/name are untrusted", () => {
  const body = buildAnalysisRequestBody(CANDIDATE) as { messages: Array<{ role: string; content: string }> };
  const systemMessage = body.messages.find((m) => m.role === "system")!;
  assert.match(systemMessage.content, /unauthenticated/i);
});

// analyzeToken() itself — the actual network round-trip, not just the pure
// request-building/parsing helpers above. Without this, a wrong response
// envelope, URL, or auth header would make every candidate fall back to
// SKIP while the rest of the suite stayed green: exactly the systemic
// failure mode this whole preflight/parsing effort exists to catch.

test("analyzeToken: a successful completion produces a real BUY signal, hits the configured URL with the auth header", async () => {
  const rawAnalysis = {
    action: "BUY",
    confidence: 92,
    reasoning: "Strong momentum.",
    // Deliberately different from CONFIG.stopLossPercent/takeProfitPercent
    // (33/50 by default) — proves the executed exit thresholds come from
    // the user's config, not whatever the model suggests. See analyze.ts.
    stopLossPercent: 15,
    takeProfitPercent: 200,
    positionSizePercent: 50,
    riskRewardRatio: 1.5,
    trendStrength: "moderate_up",
    momentum: "accelerating",
    riskLevel: "medium",
    narrative: "ai",
  };
  mockResponse = {
    status: 200,
    body: { choices: [{ message: { content: JSON.stringify(rawAnalysis) } }] },
  };

  const signal = await analyzeToken(CANDIDATE);

  assert.equal(signal.action, "BUY");
  assert.equal(signal.confidence, 92);
  assert.equal(signal.entryPrice, CANDIDATE.priceUsd);
  assert.equal(signal.stopLoss, CANDIDATE.priceUsd * (1 - CONFIG.stopLossPercent / 100));
  assert.equal(signal.takeProfit, CANDIDATE.priceUsd * (1 + CONFIG.takeProfitPercent / 100));
  assert.equal(signal.positionSizeSol, Math.min(CONFIG.maxPositionSol * 0.5, CONFIG.maxPositionSol));

  assert.ok(lastRequest, "the mock server must have received a request");
  assert.match(lastRequest!.path, /\/chat\/completions$/);
  assert.equal(lastRequest!.authorization, `Bearer ${CONFIG.openRouterApiKey}`);
});

test("analyzeToken: an empty/malformed response falls back to a safe zero-confidence SKIP, not a throw", async () => {
  mockResponse = { status: 200, body: {} }; // no choices at all -> "Empty AI response"

  const signal = await analyzeToken(CANDIDATE);

  assert.equal(signal.action, "SKIP");
  assert.equal(signal.confidence, 0);
  assert.equal(signal.riskLevel, "extreme");
  assert.equal(signal.positionSizeSol, 0);
});

test("analyzeToken: an HTTP error response also falls back to a safe SKIP", async () => {
  mockResponse = { status: 500, body: { error: "server exploded" } };

  const signal = await analyzeToken(CANDIDATE);

  assert.equal(signal.action, "SKIP");
  assert.equal(signal.confidence, 0);
});

// A schema-valid response can still be useless: positionSizePercent only has
// to be a finite number, so a BUY with 0 sails past looksLikeAnalysis. Before
// this fix, that meant noteAnalysisOutcome(true) — a model stuck returning
// zero-size BUYs forever would look "healthy" to the failure tracker while
// producing nothing tradeable, exactly the systemic-but-well-formed
// breakage that tracker exists to catch (see the comment in analyze.ts).
test("analyzeToken: a schema-valid BUY with zero position size is treated as a failure, not a success", async (t) => {
  const zeroSizeBuy = {
    action: "BUY",
    confidence: 95,
    reasoning: "Looks great.",
    stopLossPercent: 15,
    takeProfitPercent: 50,
    positionSizePercent: 0,
    riskRewardRatio: 1.5,
    trendStrength: "moderate_up",
    momentum: "accelerating",
    riskLevel: "medium",
    narrative: "ai",
  };
  mockResponse = {
    status: 200,
    body: { choices: [{ message: { content: JSON.stringify(zeroSizeBuy) } }] },
  };

  const signal = await analyzeToken(CANDIDATE);
  assert.equal(signal.action, "SKIP", "a zero-size BUY must not be handed to executeBuy() as a real BUY");
  assert.equal(signal.positionSizeSol, 0);

  resetAnalysisFailureTracking();
  const errorSpy = t.mock.method(logger, "error");
  await analyzeToken(CANDIDATE);
  await analyzeToken(CANDIDATE);
  assert.equal(errorSpy.mock.calls.length, 0, "below the 3-failure threshold — must not escalate yet");
  await analyzeToken(CANDIDATE);
  assert.equal(
    errorSpy.mock.calls.length,
    1,
    "three straight zero-size BUYs must escalate exactly like three straight parse failures"
  );
});

// A tiny but strictly positive positionSizePercent doesn't trip a "<= 0"
// check, but can still floor to 0 lamports once multiplied out (the same
// Math.floor(positionSizeSol * LAMPORTS_PER_SOL) executeBuy() uses in
// trader.ts) — a guaranteed-broken Jupiter request, same as the exact-zero
// case above.
test("analyzeToken: a BUY with a positive but sub-lamport position size is also treated as unusable", async () => {
  const tinyBuy = {
    action: "BUY",
    confidence: 95,
    reasoning: "Looks great.",
    stopLossPercent: 15,
    takeProfitPercent: 50,
    // Well below the threshold where CONFIG.maxPositionSol * (p / 100) * 1e9
    // rounds down to 0, for any sane CONFIG.maxPositionSol (0.001-10 SOL).
    positionSizePercent: 1e-8,
    riskRewardRatio: 1.5,
    trendStrength: "moderate_up",
    momentum: "accelerating",
    riskLevel: "medium",
    narrative: "ai",
  };
  mockResponse = {
    status: 200,
    body: { choices: [{ message: { content: JSON.stringify(tinyBuy) } }] },
  };

  const signal = await analyzeToken(CANDIDATE);
  assert.equal(signal.action, "SKIP");
  assert.equal(signal.positionSizeSol, 0);
});

test("parseAnalysisJson accepts bare JSON (the compliant, expected case)", () => {
  const parsed = parseAnalysisJson('{"action":"BUY","confidence":85}');
  assert.deepEqual(parsed, { action: "BUY", confidence: 85 });
});

test("parseAnalysisJson tolerates a ```json fenced response", () => {
  const parsed = parseAnalysisJson('```json\n{"action":"BUY","confidence":85}\n```');
  assert.deepEqual(parsed, { action: "BUY", confidence: 85 });
});

test("parseAnalysisJson tolerates prose wrapped around the JSON object", () => {
  const parsed = parseAnalysisJson(
    'Here is my analysis:\n{"action":"SKIP","confidence":10}\nLet me know if you need more.'
  );
  assert.deepEqual(parsed, { action: "SKIP", confidence: 10 });
});

test("parseAnalysisJson ignores braces in trailing prose after a closing fence", () => {
  // The exact case a naive first-"{"-to-last-"}" slice breaks on: valid JSON
  // inside the fence, then more text afterward that itself contains braces.
  const parsed = parseAnalysisJson(
    '```json\n{"action":"BUY","confidence":90}\n```\nNote: confidence bucket is {high}, not {medium}.'
  );
  assert.deepEqual(parsed, { action: "BUY", confidence: 90 });
});

test("parseAnalysisJson extracts the first complete object even when a stray brace follows, unfenced", () => {
  const parsed = parseAnalysisJson(
    'Sure, here you go: {"action":"WATCH","confidence":50} — by the way, {this is not json}'
  );
  assert.deepEqual(parsed, { action: "WATCH", confidence: 50 });
});

test("parseAnalysisJson skips a non-JSON fence to find the real ```json fence after it", () => {
  const parsed = parseAnalysisJson(
    '```text\nThinking about liquidity and momentum first...\n```\n```json\n{"action":"BUY","confidence":88}\n```'
  );
  assert.deepEqual(parsed, { action: "BUY", confidence: 88 });
});

test("parseAnalysisJson skips a non-JSON fence to find unfenced JSON after it", () => {
  const parsed = parseAnalysisJson(
    '```text\nnotes here\n```\n{"action":"SKIP","confidence":0}'
  );
  assert.deepEqual(parsed, { action: "SKIP", confidence: 0 });
});

test("parseAnalysisJson does not miscount braces that appear inside string values", () => {
  const parsed = parseAnalysisJson(
    '{"action":"SKIP","confidence":5,"reasoning":"risk looks like {trouble} here"}'
  );
  assert.deepEqual(parsed, { action: "SKIP", confidence: 5, reasoning: "risk looks like {trouble} here" });
});

test("parseAnalysisJson keeps looking past an earlier balanced-but-invalid brace pair", () => {
  // "{high}" is balanced but not valid JSON — a naive implementation stops
  // there and never reaches the real object that follows.
  const parsed = parseAnalysisJson('Bucket {high}. Result: {"action":"BUY","confidence":92}');
  assert.deepEqual(parsed, { action: "BUY", confidence: 92 });
});

test("parseAnalysisJson, given an isAcceptable predicate, keeps looking past valid-but-unacceptable JSON", () => {
  // "{}" is valid JSON but empty — with no predicate this would win outright
  // (it's the first thing that parses) and hide the real analysis after it.
  const fullAnalysis = {
    action: "BUY",
    confidence: 90,
    reasoning: "ok",
    stopLossPercent: 33,
    takeProfitPercent: 50,
    positionSizePercent: 60,
    riskRewardRatio: 1.5,
    trendStrength: "moderate_up",
    momentum: "accelerating",
    riskLevel: "medium",
    narrative: "ai",
  };
  const content = `Example: {}. Result: ${JSON.stringify(fullAnalysis)}`;
  const parsed = parseAnalysisJson(content, looksLikeAnalysis);
  assert.deepEqual(parsed, fullAnalysis);
});

test("parseAnalysisJson throws when nothing in the text satisfies isAcceptable, even if something parses", () => {
  assert.throws(() => parseAnalysisJson("Example: {}. Nothing else here.", looksLikeAnalysis));
});

test("looksLikeAnalysis rejects schema-invalid-but-parseable JSON ({}, null, arrays)", () => {
  assert.equal(looksLikeAnalysis({}), false);
  assert.equal(looksLikeAnalysis(null), false);
  assert.equal(looksLikeAnalysis([]), false);
  assert.equal(looksLikeAnalysis("just a string"), false);
  assert.equal(looksLikeAnalysis(42), false);
});

test("looksLikeAnalysis rejects an invalid action even with a valid confidence", () => {
  assert.equal(looksLikeAnalysis({ action: "MAYBE", confidence: 50 }), false);
});

const FULL_ANALYSIS = {
  action: "BUY",
  confidence: 90,
  reasoning: "Strong momentum and healthy liquidity.",
  stopLossPercent: 33,
  takeProfitPercent: 50,
  positionSizePercent: 60,
  riskRewardRatio: 1.5,
  trendStrength: "moderate_up",
  momentum: "accelerating",
  riskLevel: "medium",
  narrative: "ai",
};

test("looksLikeAnalysis accepts a fully-shaped analysis", () => {
  assert.equal(looksLikeAnalysis(FULL_ANALYSIS), true);
  assert.equal(looksLikeAnalysis({ ...FULL_ANALYSIS, action: "skip" }), true); // case-insensitive
});

test("looksLikeAnalysis rejects a partial response — only action + confidence is not enough", () => {
  // The exact case that slipped through the earlier, shallower check: a
  // model returning only {action, confidence} would normalize into a
  // zero-size, unactionable BUY (positionSizePercent defaults to 0) while
  // still being recorded as a "successful" analysis, hiding systemic
  // breakage from the failure-streak tracker.
  assert.equal(looksLikeAnalysis({ action: "BUY", confidence: 90 }), false);
});

test("looksLikeAnalysis rejects a response missing any single required field", () => {
  for (const field of Object.keys(FULL_ANALYSIS)) {
    const { [field]: _omitted, ...rest } = FULL_ANALYSIS;
    assert.equal(looksLikeAnalysis(rest), false, `missing "${field}" should be rejected`);
  }
});

test("parseAnalysisJson still throws on genuinely non-JSON content", () => {
  assert.throws(() => parseAnalysisJson("I cannot analyze this token."));
});

test("parseAnalysisJson throws (not silently returns garbage) on truncated JSON", () => {
  assert.throws(() => parseAnalysisJson('{"action":"BUY","confidence":8'));
});

test("noteAnalysisOutcome: a single failure does not escalate", (t) => {
  resetAnalysisFailureTracking();
  const errorSpy = t.mock.method(logger, "error");
  noteAnalysisOutcome(false, "network blip");
  assert.equal(errorSpy.mock.calls.length, 0);
});

test("noteAnalysisOutcome: the third consecutive failure escalates exactly once", (t) => {
  resetAnalysisFailureTracking();
  const errorSpy = t.mock.method(logger, "error");
  noteAnalysisOutcome(false, "err1");
  noteAnalysisOutcome(false, "err2");
  assert.equal(errorSpy.mock.calls.length, 0, "below threshold — must not escalate yet");
  noteAnalysisOutcome(false, "err3");
  assert.equal(errorSpy.mock.calls.length, 1, "hits the 3-failure threshold — must escalate");
  assert.match(String(errorSpy.mock.calls[0].arguments[0]), /3 consecutive/);
  noteAnalysisOutcome(false, "err4");
  assert.equal(errorSpy.mock.calls.length, 1, "same streak — must not escalate again on every failure");
});

test("noteAnalysisOutcome: a success after failures resets the streak", (t) => {
  resetAnalysisFailureTracking();
  const errorSpy = t.mock.method(logger, "error");
  noteAnalysisOutcome(false, "err1");
  noteAnalysisOutcome(false, "err2");
  noteAnalysisOutcome(true);
  // If the streak had NOT been reset, these two failures would bring the
  // cumulative count to 4 (>= the 3-failure threshold) and incorrectly
  // escalate. Asserting zero calls here is what actually proves the reset
  // happened, rather than just documenting the intent without checking it.
  noteAnalysisOutcome(false, "err3");
  noteAnalysisOutcome(false, "err4");
  assert.equal(errorSpy.mock.calls.length, 0, "streak must have been reset by the success");
});
