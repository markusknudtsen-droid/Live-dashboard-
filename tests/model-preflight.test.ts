import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

process.env.OPENROUTER_API_KEY = "test";
// Pin explicitly rather than relying on config.ts's default: an inherited
// OPENROUTER_MODEL from the runner's shell environment or a loaded .env
// would otherwise make CONFIG.openRouterModel diverge from what the
// checkAnalysisModel tests below assume (the WORKING fixture's id).
process.env.OPENROUTER_MODEL = "deepseek/deepseek-v3.2";

// Stand in for OpenRouter's /models catalogue endpoint, so the "real fetch"
// test below (checkAnalysisModel() called with no injected fetchModels) can
// prove the request actually goes to `${OPENROUTER_API_URL}/models` — a
// hardcoded openrouter.ai URL here would validate a different service than
// the one analyze.ts's completions actually use. Same convention as
// tests/analyze.test.ts and tests/jupiter-client.test.ts.
let lastModelsRequestPath: string | null = null;
const modelsServer = http.createServer((req, res) => {
  lastModelsRequestPath = req.url || "";
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ data: [{ id: "deepseek/deepseek-v3.2", supported_parameters: ["structured_outputs", "reasoning", "temperature", "max_tokens"] }] }));
});
await new Promise<void>((resolve) => modelsServer.listen(0, "127.0.0.1", resolve));
modelsServer.unref();
const { port: modelsServerPort } = modelsServer.address() as AddressInfo;
process.env.OPENROUTER_API_URL = `http://127.0.0.1:${modelsServerPort}`;

const { evaluateModelCatalogue, formatModelCheck, checkAnalysisModel, REQUIRED_REQUEST_PARAMETERS } =
  await import("../src/model-preflight.js");
const { buildAnalysisRequestBody } = await import("../src/analyze.js");
const { CONFIG } = await import("../src/config.js");

after(async () => {
  await new Promise<void>((resolve) => modelsServer.close(() => resolve()));
});

const WORKING = {
  id: "deepseek/deepseek-v3.2",
  supported_parameters: ["response_format", "structured_outputs", "reasoning", "temperature", "max_tokens"],
};
const NO_STRUCTURED_OUTPUT = {
  id: "some/legacy-model",
  supported_parameters: ["temperature", "max_tokens"],
};
const UNKNOWN_CAPABILITIES = { id: "some/opaque-model" };
// A real shape seen on OpenRouter's live catalogue (e.g.
// deepseek/deepseek-v4-flash-vision-exp): response_format listed without
// structured_outputs. response_format alone can just mean basic json_object
// mode — OpenRouter's docs specifically call out "structured_outputs" as the
// parameter to check for the strict json_schema mode analyze.ts sends, so
// this must still be rejected.
const RESPONSE_FORMAT_ONLY = {
  id: "some/response-format-only-model",
  supported_parameters: ["response_format", "reasoning", "temperature"],
};
// structured_outputs is present, but reasoning is not — analyze.ts always
// sends reasoning: { effort: "none" } too, under require_parameters: true,
// so this must still be rejected even though structured_outputs alone would
// have passed the old, narrower check.
const MISSING_REASONING_ONLY = {
  id: "some/no-reasoning-control-model",
  supported_parameters: ["response_format", "structured_outputs", "temperature"],
};
// Mirrors deepseek/deepseek-r1 on the live catalogue: lists "reasoning" in
// supported_parameters, but reasoning.mandatory = true means it can never
// accept effort: "none".
const MANDATORY_REASONING = {
  id: "some/mandatory-reasoning-model",
  supported_parameters: ["response_format", "structured_outputs", "reasoning", "temperature", "max_tokens"],
  reasoning: { mandatory: true },
};
// Mirrors deepseek/deepseek-v4-flash-0731: reasoning is optional, but the
// accepted effort values don't include "none".
const RESTRICTED_EFFORTS = {
  id: "some/no-none-effort-model",
  supported_parameters: ["response_format", "structured_outputs", "reasoning", "temperature", "max_tokens"],
  reasoning: { mandatory: false, supported_efforts: ["max", "high", "low"] },
};

test("REQUIRED_REQUEST_PARAMETERS covers every tunable the analysis request actually sends", () => {
  // Guards the coupling between analyze.ts's request body and the preflight's
  // capability list. Under provider.require_parameters: true, ANY parameter
  // the request sends that a provider doesn't support gets the whole request
  // rejected — so a parameter added to the body without being added here
  // would silently reintroduce "preflight says OK, every call then fails".
  const body = buildAnalysisRequestBody({
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
  });

  // Routing/payload keys, not capability flags OpenRouter reports.
  const NOT_CAPABILITIES = new Set(["model", "messages", "provider"]);
  // response_format is reported under the "structured_outputs" tag.
  const TAG_ALIASES: Record<string, string> = { response_format: "structured_outputs" };

  const sentTunables = Object.keys(body)
    .filter((k) => !NOT_CAPABILITIES.has(k))
    .map((k) => TAG_ALIASES[k] ?? k);

  for (const param of sentTunables) {
    assert.ok(
      REQUIRED_REQUEST_PARAMETERS.includes(param),
      `request sends "${param}" but the preflight doesn't require it — add it to REQUIRED_REQUEST_PARAMETERS`
    );
  }
});

test("a model that exists and supports structured outputs passes", () => {
  const result = evaluateModelCatalogue([WORKING], "deepseek/deepseek-v3.2");
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test("a retired/nonexistent model is a fatal error, not a warning", () => {
  const result = evaluateModelCatalogue([WORKING], "google/gemini-2.0-flash-001");
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /not available on OpenRouter/);
});

test("a retired model suggests only alternatives that actually exist in the catalogue", () => {
  const result = evaluateModelCatalogue([WORKING], "google/gemini-2.0-flash-001");
  assert.deepEqual(result.suggestions, ["deepseek/deepseek-v3.2"]);
});

test("a suggestion that exists in the catalogue but itself lacks capability is never recommended", () => {
  // deepseek/deepseek-v3.2 is present in the catalogue (so the old id-only
  // filter would have suggested it) but doesn't advertise structured output
  // support here — recommending it would just fail the very next preflight.
  const catalogue = [
    { id: "deepseek/deepseek-v3.2", supported_parameters: ["temperature"] },
    {
      id: "google/gemini-2.5-flash-lite",
      supported_parameters: ["response_format", "structured_outputs", "reasoning", "temperature", "max_tokens"],
    },
  ];
  const result = evaluateModelCatalogue(catalogue, "retired/model");
  assert.deepEqual(result.suggestions, ["google/gemini-2.5-flash-lite"]);
});

test("a model advertising only response_format (without structured_outputs) is still rejected — that tag alone doesn't guarantee strict json_schema support", () => {
  const result = evaluateModelCatalogue([RESPONSE_FORMAT_ONLY], "some/response-format-only-model");
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /does not advertise support for: structured_outputs/);
});

test("a model lacking structured-output support is fatal (every analysis would SKIP)", () => {
  const result = evaluateModelCatalogue([NO_STRUCTURED_OUTPUT], "some/legacy-model");
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /does not advertise support for: structured_outputs, reasoning/);
});

test("a model advertising structured_outputs but not reasoning is still rejected — the request always sends reasoning too", () => {
  const result = evaluateModelCatalogue([MISSING_REASONING_ONLY], "some/no-reasoning-control-model");
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /does not advertise support for: reasoning/);
});

test("a mandatory-reasoning model is rejected even though it advertises the reasoning parameter", () => {
  const result = evaluateModelCatalogue([MANDATORY_REASONING], "some/mandatory-reasoning-model");
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /reasoning\.mandatory = true/);
});

test("a model whose supported_efforts omit \"none\" is rejected", () => {
  const result = evaluateModelCatalogue([RESTRICTED_EFFORTS], "some/no-none-effort-model");
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /does not include "none"/);
});

test("reasoning-incompatible models are never offered as suggestions", () => {
  // Both incompatible models carry ids from SUGGESTED_MODELS' preference
  // order, so an id-only filter would happily recommend them.
  const catalogue = [
    { ...MANDATORY_REASONING, id: "deepseek/deepseek-v3.2" },
    { ...RESTRICTED_EFFORTS, id: "deepseek/deepseek-chat-v3.1" },
    {
      id: "google/gemini-2.5-flash-lite",
      supported_parameters: ["structured_outputs", "reasoning", "temperature", "max_tokens"],
      reasoning: { mandatory: false },
    },
  ];
  const result = evaluateModelCatalogue(catalogue, "retired/model");
  assert.deepEqual(result.suggestions, ["google/gemini-2.5-flash-lite"]);
});

test("absent reasoning metadata is treated as compatible (not published != incompatible)", () => {
  const noMetadata = {
    id: "some/no-reasoning-metadata",
    supported_parameters: ["structured_outputs", "reasoning", "temperature", "max_tokens"],
  };
  const result = evaluateModelCatalogue([noMetadata], "some/no-reasoning-metadata");
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("unreported capabilities warn but do not block startup", () => {
  const result = evaluateModelCatalogue([UNKNOWN_CAPABILITIES], "some/opaque-model");
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.match(result.warnings[0], /did not report capabilities/);
});

// supported_parameters and reasoning are two independent optional fields on
// the same catalogue entry — OpenRouter can publish one without the other.
// A model with unreported supported_parameters but EXPLICIT incompatible
// reasoning metadata (mandatory reasoning, here) must still fail: that
// metadata alone is definitive proof every request would be rejected,
// regardless of whether the general capability list was ever reported.
test("explicit mandatory-reasoning metadata is fatal even when supported_parameters itself is unreported", () => {
  const unreportedParamsButMandatoryReasoning = {
    id: "some/opaque-mandatory-reasoning-model",
    reasoning: { mandatory: true },
  };
  const result = evaluateModelCatalogue(
    [unreportedParamsButMandatoryReasoning],
    "some/opaque-mandatory-reasoning-model"
  );
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /reasoning\.mandatory = true/);
});

test("an explicit empty supported_parameters array is a fatal error, not just a warning", () => {
  // Mirrors meta-routing models on the live catalogue (e.g. openrouter/fusion)
  // that publish supported_parameters: [] deliberately — a real "supports
  // nothing" signal, not "OpenRouter didn't report capabilities".
  const noCapabilities = { id: "some/no-capabilities-model", supported_parameters: [] };
  const result = evaluateModelCatalogue([noCapabilities], "some/no-capabilities-model");
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /does not advertise support for/);
});

test("an explicit empty supported_efforts array rejects \"none\" too — it means no effort is accepted", () => {
  const noEfforts = {
    id: "some/no-accepted-efforts-model",
    supported_parameters: ["response_format", "structured_outputs", "reasoning", "temperature", "max_tokens"],
    reasoning: { mandatory: false, supported_efforts: [] },
  };
  const result = evaluateModelCatalogue([noEfforts], "some/no-accepted-efforts-model");
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /does not include "none"/);
});

test("the suggested alternative never repeats the model that just failed", () => {
  const catalogue = [
    { id: "deepseek/deepseek-v3.2", supported_parameters: ["temperature"] },
    WORKING,
  ];
  const result = evaluateModelCatalogue(catalogue, "deepseek/deepseek-v3.2");
  assert.equal(result.suggestions.includes("deepseek/deepseek-v3.2"), false);
});

test("a model missing structured-output support never suggests a model absent from the live catalogue", () => {
  // Only google/gemini-2.5-flash-lite is actually present; the rest of
  // SUGGESTED_MODELS (v3.2, chat-v3.1) are not in this catalogue and must
  // never appear in the suggestions.
  const lite = {
    id: "google/gemini-2.5-flash-lite",
    supported_parameters: ["structured_outputs", "reasoning", "temperature", "max_tokens"],
  };
  const catalogue = [NO_STRUCTURED_OUTPUT, lite];
  const result = evaluateModelCatalogue(catalogue, "some/legacy-model");
  assert.deepEqual(result.suggestions, ["google/gemini-2.5-flash-lite"]);
});

test("formatModelCheck surfaces the fix instruction when a model is unusable", () => {
  const result = evaluateModelCatalogue([WORKING], "google/gemini-2.0-flash-001");
  const text = formatModelCheck(result, "google/gemini-2.0-flash-001");
  assert.match(text, /❌/);
  assert.match(text, /OPENROUTER_MODEL=deepseek\/deepseek-v3\.2/);
});

test("formatModelCheck confirms success plainly when all is well", () => {
  const result = evaluateModelCatalogue([WORKING], "deepseek/deepseek-v3.2");
  const text = formatModelCheck(result, "deepseek/deepseek-v3.2");
  assert.match(text, /✅ Analysis model OK/);
});

// checkAnalysisModel() itself (as opposed to evaluateModelCatalogue, which
// only covers the pure decision logic) exercises the network-facing branches
// — a successful fetch, a rejected fetch, and a malformed/empty response.
// The fail-open behavior (never block startup over a fetch problem) is the
// specific thing at risk of silently regressing without these.

test("checkAnalysisModel: a successful fetch evaluates the catalogue normally", async () => {
  // Relies on the module-level OPENROUTER_MODEL pin at the top of this file,
  // which matches WORKING.id — not on config.ts's default.
  const result = await checkAnalysisModel(async () => ({ data: [WORKING] }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("checkAnalysisModel: called with no injected fetchModels, it hits ${OPENROUTER_API_URL}/models, not a hardcoded openrouter.ai URL", async () => {
  lastModelsRequestPath = null;
  const result = await checkAnalysisModel();
  assert.equal(lastModelsRequestPath, "/models", "must build the request from CONFIG.openRouterApiUrl");
  assert.equal(result.ok, true);
});

// validateConfig() deliberately does NOT throw on a missing OPENROUTER_API_KEY
// (see config.ts) — throwing there would exit the whole process before
// positions are restored, leaving them unmonitored. checkAnalysisModel() is
// what's supposed to catch this instead, the same "broken" path as a
// retired/incompatible model.
test("checkAnalysisModel: a missing OPENROUTER_API_KEY is reported as broken without a network call", async () => {
  const previousKey = CONFIG.openRouterApiKey;
  CONFIG.openRouterApiKey = "";
  try {
    let fetchCalled = false;
    const result = await checkAnalysisModel(async () => {
      fetchCalled = true;
      return { data: [WORKING] };
    });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /OPENROUTER_API_KEY is not set/);
    assert.equal(fetchCalled, false, "a missing key is knowable without a network call — should short-circuit");
  } finally {
    CONFIG.openRouterApiKey = previousKey;
  }
});

// A malformed OPENROUTER_API_URL is a deterministic configuration error,
// not a transient network condition — Axios either throws a plain error
// for an unparseable URL or an AxiosError with no response status for a
// bad protocol (which http.ts's retry logic even treats as "retryable"),
// so left unguarded this fell into the catch block's fail-open behavior
// and reported ok: true while every real completion request (built from
// the same base URL) would fail identically.
test("checkAnalysisModel: a malformed OPENROUTER_API_URL is a fatal error, not a fail-open warning", async () => {
  const previousUrl = CONFIG.openRouterApiUrl;
  const badUrls = ["not-a-url", "htps://openrouter.ai/api/v1", "ftp://openrouter.ai/api/v1", ""];
  try {
    for (const badUrl of badUrls) {
      CONFIG.openRouterApiUrl = badUrl;
      let fetchCalled = false;
      const result = await checkAnalysisModel(async () => {
        fetchCalled = true;
        return { data: [WORKING] };
      });
      assert.equal(result.ok, false, `"${badUrl}" must be rejected`);
      assert.match(result.errors[0], /OPENROUTER_API_URL/);
      assert.equal(fetchCalled, false, `"${badUrl}" is knowable without a network call — should short-circuit`);
    }
  } finally {
    CONFIG.openRouterApiUrl = previousUrl;
  }
});

test("checkAnalysisModel: a valid OPENROUTER_API_URL with an unusual but real path still proceeds to the network call", async () => {
  const previousUrl = CONFIG.openRouterApiUrl;
  CONFIG.openRouterApiUrl = "https://my-proxy.example.com:8443/openrouter/v1";
  try {
    const result = await checkAnalysisModel(async () => ({ data: [WORKING] }));
    assert.equal(result.ok, true);
  } finally {
    CONFIG.openRouterApiUrl = previousUrl;
  }
});

test("checkAnalysisModel: a rejected fetch fails OPEN (warns, does not block startup)", async () => {
  const result = await checkAnalysisModel(async () => {
    throw new Error("ECONNREFUSED");
  });
  assert.equal(result.ok, true, "a network failure must never block startup");
  assert.equal(result.errors.length, 0);
  assert.match(result.warnings[0], /could not reach OpenRouter/);
  assert.match(result.warnings[0], /ECONNREFUSED/);
});

// A deterministic 4xx (other than 429) from the catalogue endpoint — e.g. a
// 404 from a mistyped OPENROUTER_API_URL path — means every completion
// request built from the same base URL would fail identically. That must
// not be treated like a transient outage (429/5xx/no-response all still
// fail open, matching "never block startup over an outage"). Duck-types
// what axios.isAxiosError() actually checks (payload.isAxiosError === true)
// rather than pulling in axios's own AxiosError class here.
function fakeHttpError(status: number): Error {
  const error = new Error(`Request failed with status code ${status}`);
  return Object.assign(error, { isAxiosError: true, response: { status } });
}

test("checkAnalysisModel: a deterministic 404 from the catalogue endpoint is a fatal error, not a fail-open warning", async () => {
  const result = await checkAnalysisModel(async () => {
    throw fakeHttpError(404);
  });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /HTTP 404/);
  assert.match(result.errors[0], /OPENROUTER_API_URL/);
  assert.doesNotMatch(result.errors[0], /OPENROUTER_API_KEY/, "a 404 is a path/host problem, not a credential one");
});

// The catalogue fetch now sends the same bearer token completions do (see
// fetchOpenRouterModels), so a 401/403 here almost always means a bad or
// insufficiently-permissioned key — a different fix than the wrong-path-
// or-host wording the 404 case above gets. Directing an operator to the
// wrong setting for a credential problem wastes their time.
test("checkAnalysisModel: a 401/403 from the catalogue endpoint blames the API key, not the path/host", async () => {
  for (const status of [401, 403]) {
    const result = await checkAnalysisModel(async () => {
      throw fakeHttpError(status);
    });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], new RegExp(`HTTP ${status}`));
    assert.match(result.errors[0], /OPENROUTER_API_KEY/);
    assert.doesNotMatch(result.errors[0], /wrong path or host/);
  }
});

test("checkAnalysisModel: 408/425/429/5xx from the catalogue endpoint still fail OPEN — those are genuinely transient", async () => {
  // 408 (Request Timeout) and 425 (Too Early) are < 500 and not 429, but
  // neither means "this request is fundamentally wrong" — both are
  // explicitly about timing, not a broken URL/config, unlike a genuine 4xx
  // (404, 401, ...).
  for (const status of [408, 425, 429, 503]) {
    const result = await checkAnalysisModel(async () => {
      throw fakeHttpError(status);
    });
    assert.equal(result.ok, true, `HTTP ${status} must still fail open`);
  }
});

test("checkAnalysisModel: an empty/malformed catalogue response fails OPEN", async () => {
  const emptyResult = await checkAnalysisModel(async () => ({ data: [] }));
  assert.equal(emptyResult.ok, true);
  assert.match(emptyResult.warnings[0], /Could not read OpenRouter's model list/);

  const malformedResult = await checkAnalysisModel(async () => ({}) as { data?: unknown[] });
  assert.equal(malformedResult.ok, true);
  assert.match(malformedResult.warnings[0], /Could not read OpenRouter's model list/);
});
