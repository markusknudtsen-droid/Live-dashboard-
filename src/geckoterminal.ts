/**
 * GeckoTerminal (CoinGecko's on-chain product) as a second discovery source,
 * alongside DexScreener.
 *
 * The gap this closes: RESERVED_NEW_COIN_SLOTS holds a position slot for a
 * coin under a market-cap bar, but DexScreener's own feeds
 * (token-boosts/top, token-boosts/latest, search?q=meme) are all biased
 * toward coins that have ALREADY gained volume, boost spend, or search
 * relevance — none of them is sorted by creation time. A real incident,
 * 2026-09-09: the reservation correctly blocked five established-coin buys
 * from taking that slot, but zero candidates under $60k ever reached a signal
 * at all, because none of the scan sources could surface one.
 *
 * GeckoTerminal's /new_pools endpoint IS sorted by actual pool-creation time
 * (pool_created_at, a real ISO timestamp — verified live against a pool 47
 * seconds old). Free, no API key.
 *
 * This module deliberately does ONLY discovery — it returns mint addresses,
 * not TokenCandidate objects. GeckoTerminal carries no boost, social-link, or
 * paid-info data, so a candidate built directly from it would look identical
 * to a rug with zero social presence and would fail checkSmallCapGate's
 * "at least one social" bar even for a legitimate coin — the data was simply
 * never fetched, not absent. The caller resolves these mints through
 * resolveMintsToCandidates() instead, the same DexScreener-backed path
 * already used for Telegram-mentioned mints, so every field is real and
 * every existing check (isWorthAnalysing, the small-cap gate, the bearish
 * guard, the reserved slot) applies exactly as it does to every other source.
 *
 * Fail-safe like every other optional source in this codebase: any failure —
 * network error, timeout, non-200, unexpected shape — resolves to an empty
 * array, never throws.
 */

const GECKOTERMINAL_API = "https://api.geckoterminal.com/api/v2";

interface GtToken {
  id: string;
  type: string;
  attributes?: { address?: string };
}

interface GtPool {
  id: string;
  type: string;
  relationships?: { base_token?: { data?: { id?: string } } };
}

interface GtResponse {
  data?: GtPool[];
  included?: GtToken[];
}

/**
 * Mint addresses of pools recently created on `chain`, newest first (the
 * order the API itself returns), deduped, capped at `limit`.
 */
export async function fetchNewPoolMints(chain = "solana", limit = 20, timeoutMs = 8000): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(
      `${GECKOTERMINAL_API}/networks/${encodeURIComponent(chain)}/new_pools?page=1&include=base_token`,
      { signal: controller.signal, headers: { accept: "application/json" } }
    );
    if (!res.ok) return [];
    const j = (await res.json()) as GtResponse;
    return extractMints(j, limit);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pure extraction, split out from the fetch above so it is testable against a
 * captured real response with no network involved.
 *
 * `included` is a JSON:API side-table: each pool's `relationships.base_token`
 * points at an entry there by id, rather than embedding the token inline —
 * that indirection is what gives a clean mint address without parsing the
 * pool's "SYMBOL / SOL" display name.
 */
export function extractMints(response: GtResponse, limit: number): string[] {
  const pools = Array.isArray(response.data) ? response.data : [];
  const tokensById = new Map<string, string>();
  for (const t of Array.isArray(response.included) ? response.included : []) {
    if (t?.type === "token" && typeof t.id === "string" && typeof t.attributes?.address === "string") {
      tokensById.set(t.id, t.attributes.address);
    }
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const pool of pools) {
    const tokenId = pool?.relationships?.base_token?.data?.id;
    if (!tokenId) continue;
    const address = tokensById.get(tokenId);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    out.push(address);
    if (out.length >= limit) break;
  }
  return out;
}
