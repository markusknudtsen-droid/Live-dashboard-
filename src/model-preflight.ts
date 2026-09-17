import axios from "axios";
import { CONFIG } from "./config.js";
import { httpGet, isRetryableError } from "./http.js";

/**
 * Startup validation for OPENROUTER_MODEL.
 *
 * Motivation: analyzeToken() catches every failure and degrades to a
 * zero-confidence SKIP so one bad response can't halt trading. That's correct
 * per-token, but it means a *systematically* broken model config (retired model
 * ID, typo, a model that rejects the strict json_schema request) is
 * indistinguishable from "the market had no good candidates" — the bot just
 * quietly never trades. This happened for real: the previously hardcoded
 * google/gemini-2.0-flash-001 was withdrawn from OpenRouter.
 *
 * So before trading starts we check the configured model against OpenRouter's
 * public model catalogue: that it exists, and that it advertises structured
 * output support (the strict json_schema response_format analyze.ts depends on).
 */

export interface ModelCheckResult {
  ok: boolean;
  /** Fatal problems: the model can't work as configured. */
  errors: string[];
  /** Non-fatal observations worth surfacing. */
  warnings: string[];
  /** Suggested alternatives when the configured model is unusable. */
  suggestions: string[];
}

interface OpenRouterModel {
  id?: string;
  supported_parameters?: string[];
  /**
   * Reasoning metadata, when OpenRouter publishes it for the model.
   * - mandatory: reasoning can't be turned off at all.
   * - supported_efforts: the exact effort values accepted; when present and
   *   it omits "none", the analyzer's reasoning: { effort: "none" } is not
   *   an accepted value for this model.
   */
  reasoning?: {
    mandatory?: boolean;
    default_enabled?: boolean;
    supported_efforts?: string[];
    default_effort?: string;
  };
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModel[];
}

/**
 * Fallbacks to suggest, cheapest input-price-per-token first. Kept in sync
 * with the options documented in README.md / .env.example. Every entry is
 * still re-verified against the live catalogue at runtime (existence,
 * required parameters, AND ability to accept effort: "none") before being
 * recommended — this list is a preference order, not a trust anchor.
 *
 * Deliberately excluded despite being cheap/plausible:
 * - deepseek/deepseek-r1: publishes reasoning.mandatory = true, so it cannot
 *   accept the analyzer's effort: "none".
 * - deepseek/deepseek-v4-flash-0731: publishes
 *   supported_efforts: ["max","high","low"] — no "none" option.
 * Both would be filtered out at runtime anyway; listing them here would just
 * be misleading.
 */
const SUGGESTED_MODELS = [
  "google/gemini-2.5-flash-lite",
  "deepseek/deepseek-v3.2",
  "deepseek/deepseek-chat-v3.1",
];

// Every capability the analysis request actually depends on. OpenRouter's
// own docs specifically say to check "structured_outputs" for structured-
// output support (docs.openrouter.ai, "Structured Outputs"); "response_format"
// alone is a broader tag that can just mean basic json_object mode, not the
// strict json_schema mode analyze.ts sends. "reasoning" is required too:
// analyze.ts also always sends reasoning: { effort: "none" } together with
// provider.require_parameters: true, and that flag makes OpenRouter exclude
// any provider that doesn't support EVERY parameter in the request — so a
// model missing "reasoning" support can pass a structured_outputs-only check
// here and then have every analysis rejected at request time because no
// eligible provider supports the full parameter set. require_parameters is
// still a second, independent backstop regardless — even if this list is
// ever incomplete, that flag keeps a request from silently routing to a
// provider that would ignore something it was sent.
/**
 * MUST stay in sync with every tunable parameter buildAnalysisRequestBody()
 * sends (see analyze.ts) — tests/model-preflight.test.ts asserts that
 * coupling so this list can't silently drift again. `model`, `messages` and
 * `provider` are excluded deliberately: they're routing/payload, not
 * capability flags OpenRouter reports in supported_parameters.
 * `response_format` maps to the "structured_outputs" capability tag.
 *
 * temperature and max_tokens matter more than they look: verified against
 * the live catalogue, 81 models advertise structured_outputs + reasoning but
 * NOT temperature — including mainstream ones (openai/gpt-5.6-*,
 * anthropic/claude-opus-5-fast). Under require_parameters: true those would
 * pass a structured_outputs+reasoning-only check and then have every
 * completion rejected.
 */
export const REQUIRED_REQUEST_PARAMETERS = ["structured_outputs", "reasoning", "temperature", "max_tokens"];

/** The exact reasoning effort analyze.ts sends. */
const REQUESTED_REASONING_EFFORT = "none";

function supportsRequiredParameters(model: OpenRouterModel): boolean {
  const params = model.supported_parameters;
  return !!params && REQUIRED_REQUEST_PARAMETERS.every((p) => params.includes(p));
}

/**
 * Whether the model can actually accept reasoning: { effort: "none" }.
 *
 * Advertising the generic "reasoning" parameter is NOT enough — verified
 * against the live catalogue, deepseek/deepseek-r1 publishes
 * { mandatory: true } (reasoning can't be turned off at all) and
 * deepseek/deepseek-v4-flash-0731 publishes
 * supported_efforts: ["max","high","low"] (no "none" option), yet both list
 * "reasoning" in supported_parameters. Under require_parameters: true those
 * models would pass a parameter-name-only check and then have every analysis
 * request rejected. Absent metadata (supported_efforts missing or null) is
 * treated as compatible: OpenRouter simply may not publish it, and that's
 * not evidence of incompatibility. An explicit empty array is different — it
 * means no effort value is accepted at all, so "none" isn't either.
 */
function canDisableReasoning(model: OpenRouterModel): boolean {
  const reasoning = model.reasoning;
  if (!reasoning) return true;
  if (reasoning.mandatory === true) return false;
  const efforts = reasoning.supported_efforts;
  if (Array.isArray(efforts) && !efforts.includes(REQUESTED_REASONING_EFFORT)) {
    return false;
  }
  return true;
}

/** Everything the configured model must satisfy to serve the analysis request. */
function isModelCompatible(model: OpenRouterModel): boolean {
  return supportsRequiredParameters(model) && canDisableReasoning(model);
}

export function evaluateModelCatalogue(
  models: OpenRouterModel[],
  configuredModel: string
): ModelCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const suggestions: string[] = [];

  // Suggestions must actually exist in the fetched catalogue AND advertise
  // the same capability the configured model was just rejected for lacking
  // — otherwise "known-good" is a lie and the very next preflight run fails
  // again on the model this one just recommended.
  const byId = new Map(models.map((m) => [m.id, m] as const));
  const liveSuggestions = (excludeId: string) =>
    SUGGESTED_MODELS.filter((id) => {
      if (id === excludeId) return false;
      const m = byId.get(id);
      return !!m && isModelCompatible(m);
    });

  const match = models.find((m) => m.id === configuredModel);

  if (!match) {
    errors.push(
      `OPENROUTER_MODEL "${configuredModel}" is not available on OpenRouter. ` +
        `Model IDs are retired over time, so a previously-working value can stop existing.`
    );
    suggestions.push(...liveSuggestions(configuredModel));
    return { ok: false, errors, warnings, suggestions };
  }

  // supported_parameters being absent is advisory: OpenRouter didn't report
  // capabilities at all, not that the model lacks them. Only warn for that
  // case. An explicit empty array is a real signal, not missing metadata —
  // verified against the live catalogue, meta-routing models like
  // openrouter/fusion publish supported_parameters: [] deliberately, meaning
  // they advertise none of the required capabilities. That must fall through
  // to the same incompatibility check as any other model missing a required
  // parameter, not get treated as "unknown".
  const params = match.supported_parameters;
  if (params === undefined) {
    warnings.push(
      `OpenRouter did not report capabilities for "${configuredModel}"; ` +
        `cannot confirm structured-output/reasoning-control support in advance.`
    );
  } else if (!supportsRequiredParameters(match)) {
    const missing = REQUIRED_REQUEST_PARAMETERS.filter((p) => !params.includes(p));
    errors.push(
      `Model "${configuredModel}" does not advertise support for: ${missing.join(", ")}. The analyzer's ` +
        `request always includes structured_outputs (strict json_schema) and reasoning (forced off) ` +
        `together with provider.require_parameters: true, which excludes any provider endpoint that ` +
        `doesn't honor every parameter sent — the request only succeeds if at least one eligible ` +
        `provider remains, and fails outright if none do. Each rejection degrades to a zero-confidence ` +
        `SKIP — the bot would run without ever finding a trade.`
    );
  }

  // Independent of the supported_parameters branch above: OpenRouter can
  // (and does) publish reasoning.mandatory / reasoning.supported_efforts
  // whether or not it reports supported_parameters at all — they're two
  // separate optional fields on the same model entry. Checking this only
  // inside the "params defined and complete" branch meant a model with
  // EXPLICIT incompatible reasoning metadata (mandatory reasoning, or
  // accepted efforts excluding "none") but unreported supported_parameters
  // passed with only a warning, despite the reasoning metadata alone
  // already being definitive proof every request would be rejected.
  if (errors.length === 0 && !canDisableReasoning(match)) {
    // Advertising the "reasoning" parameter isn't the same as accepting
    // effort: "none" — see canDisableReasoning() for the two real cases.
    const why =
      match.reasoning?.mandatory === true
        ? `it requires reasoning (reasoning.mandatory = true), so reasoning cannot be turned off`
        : `its accepted reasoning efforts are [${(match.reasoning?.supported_efforts ?? []).join(", ")}], which does not include "${REQUESTED_REASONING_EFFORT}"`;
    errors.push(
      `Model "${configuredModel}" publishes reasoning metadata showing ${why}. The analyzer sends ` +
        `reasoning: { effort: "${REQUESTED_REASONING_EFFORT}" } (its ${"500-token"} response budget assumes no hidden ` +
        `reasoning tokens) under provider.require_parameters: true, so every analysis request would be ` +
        `rejected and degrade to a zero-confidence SKIP — the bot would run without ever finding a trade.`
    );
  }

  if (errors.length > 0) {
    suggestions.push(...liveSuggestions(configuredModel));
  }

  return { ok: errors.length === 0, errors, warnings, suggestions };
}

export function formatModelCheck(result: ModelCheckResult, configuredModel: string): string {
  const lines: string[] = [];
  for (const error of result.errors) lines.push(`❌ ${error}`);
  for (const warning of result.warnings) lines.push(`⚠️  ${warning}`);
  if (result.suggestions.length > 0) {
    lines.push(`   Known-good alternatives: ${result.suggestions.join(", ")}`);
    lines.push(`   Set one in .env, e.g. OPENROUTER_MODEL=${result.suggestions[0]}`);
  }
  if (result.ok && result.warnings.length === 0) {
    lines.push(`✅ Analysis model OK: ${configuredModel} (structured outputs + reasoning control supported)`);
  }
  return lines.join("\n");
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// Built from CONFIG.openRouterApiUrl, the same base analyze.ts sends
// completions to — not a hardcoded openrouter.ai URL. Otherwise the
// preflight would validate a different service than the one that will
// actually serve analysis requests (relevant when OPENROUTER_API_URL points
// at a proxy or a local stand-in, e.g. in tests). Sends the same bearer
// token analyze.ts's completions request does: OpenRouter's own public
// catalogue tolerates it, but an authenticated proxy configured via
// OPENROUTER_API_URL may require it — without it, such a proxy can 401 this
// request even though completions (which do send the header) would
// succeed, incorrectly reporting the model as broken. checkAnalysisModel()
// only reaches this after confirming OPENROUTER_API_KEY is set.
function fetchOpenRouterModels(): Promise<OpenRouterModelsResponse> {
  return httpGet<OpenRouterModelsResponse>(`${CONFIG.openRouterApiUrl}/models`, {
    headers: { Authorization: `Bearer ${CONFIG.openRouterApiKey}` },
  });
}

/**
 * Fetch OpenRouter's model catalogue and validate the configured model against it.
 * Network failure is non-fatal — we don't want a transient outage to block startup.
 *
 * `fetchModels` is injectable purely so tests can exercise the success/
 * rejection/malformed-response branches (the fail-open behavior in
 * particular) without a real network call; production code never needs to
 * pass it.
 */
export async function checkAnalysisModel(
  fetchModels: () => Promise<OpenRouterModelsResponse> = fetchOpenRouterModels
): Promise<ModelCheckResult> {
  // Catch a missing key here rather than in validateConfig() at startup —
  // that would throw and exit the whole process before positions are even
  // restored. Reported through the same "broken" path as a retired/
  // incompatible model (blocks new entries, never monitoring), and short-
  // circuits before the network call: every analysis request would get a
  // 401 anyway, no catalogue fetch is needed to know that in advance.
  if (!CONFIG.openRouterApiKey) {
    return {
      ok: false,
      errors: [
        "OPENROUTER_API_KEY is not set. Every analysis request will be rejected, so no new positions can be opened.",
      ],
      warnings: [],
      suggestions: [],
    };
  }
  // Same reasoning for a malformed OPENROUTER_API_URL: it's a deterministic
  // configuration error, not a transient network condition, so it must not
  // fall into the catch block below's fail-open behavior. Axios either
  // throws a plain (non-Axios) error for an unparseable URL, or an
  // AxiosError with no response status for an unsupported protocol — the
  // latter even looks "retryable" to isRetryableError() in http.ts (no
  // status means "assume retryable"), so left unchecked this would silently
  // report ok: true after burning through the retry budget, while every
  // actual completion request (built from the same base URL) would fail
  // the exact same way — the "looks like a quiet market" failure mode this
  // whole preflight exists to catch, just reached through a different
  // misconfiguration.
  if (!isValidHttpUrl(CONFIG.openRouterApiUrl)) {
    return {
      ok: false,
      errors: [
        `OPENROUTER_API_URL ("${CONFIG.openRouterApiUrl}") is not a valid http:// or https:// URL. Every analysis request built from it would fail the same way.`,
      ],
      warnings: [],
      suggestions: [],
    };
  }
  try {
    const response = await fetchModels();
    const models = response?.data;
    if (!Array.isArray(models) || models.length === 0) {
      return {
        ok: true,
        errors: [],
        warnings: ["Could not read OpenRouter's model list; skipping model preflight."],
        suggestions: [],
      };
    }
    return evaluateModelCatalogue(models, CONFIG.openRouterModel);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // A deterministic 4xx (anything but 429) from the catalogue endpoint —
    // e.g. a 404 from a mistyped OPENROUTER_API_URL path — is a
    // configuration problem, not a transient outage: every completion
    // request built from the same base URL would fail the exact same way.
    // isRetryableError() (http.ts) already draws this line for deciding
    // whether to retry in the first place; reuse it here. No response at
    // all, 429, and 5xx all stay fail-open — genuinely transient or
    // uncertain, matching "we don't want an outage to block startup".
    if (axios.isAxiosError(error) && !isRetryableError(error)) {
      const status = error.response?.status;
      // This request now sends the same bearer token completions do (see
      // fetchOpenRouterModels), so a 401/403 here almost always means a bad
      // or insufficiently-permissioned OPENROUTER_API_KEY — a different fix
      // than the wrong-path-or-host wording below, which fits a 404 (and
      // other non-auth 4xx) but would send an operator chasing the wrong
      // setting for a credential problem.
      const diagnosis =
        status === 401 || status === 403
          ? `this looks like a bad or insufficiently-permissioned OPENROUTER_API_KEY`
          : `this looks like a configuration problem (wrong path or host)`;
      return {
        ok: false,
        errors: [
          `Model preflight got HTTP ${status} from OPENROUTER_API_URL ` +
            `("${CONFIG.openRouterApiUrl}") — ${diagnosis}, not a transient outage. ${message}`,
        ],
        warnings: [],
        suggestions: [],
      };
    }
    return {
      ok: true,
      errors: [],
      warnings: [`Model preflight could not reach OpenRouter (${message}); continuing.`],
      suggestions: [],
    };
  }
}
