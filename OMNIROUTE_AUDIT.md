# OmniRoute Multi-Model Audit Findings (Astra 6 + DeepSeek R1)

This audit was generated via OmniRoute using **Astra (OpenAI GPT-6 Astra)** for deep code review/debugging and **DeepSeek R1** for architecture, high-alpha APIs, and autonomous skills expansion.

---

## 1. Critical Bugs & Edge Cases (Astra 6 Audit)

### P0: Position Sizing Fallback Can Dump Manually Held Wallet Tokens
- **Location:** `src/trader.ts` (and position accounting logic)
- **Vulnerability:**
  ```typescript
  if (positionRaw === undefined) return walletRaw;
  ```
  If a legacy position is restored without raw tracking or if state desyncs, the bot falls back to treating the entire wallet balance as the position size. If the operator holds personal tokens in the same wallet, the bot may liquidate them during an automated exit.
- **Fix:**
  - Fail closed: quarantine the position or throw an error rather than defaulting to `walletRaw`.
  - Track `remainingRaw` explicitly across partial sales and add-ons.
  - Strongly recommend using a dedicated trading bot wallet isolated from personal holdings.

### P0: RPC Submission Timeouts Cause Duplicate Swaps
- **Location:** `executeJupiterSwap()` / swap execution loop
- **Vulnerability:**
  When an RPC or Jupiter call times out, a timeout is **not** confirmation of failure. Re-signing or rebuilding with a fresh blockhash without verifying the previous transaction on-chain can cause double-buys or double-sells.
- **Fix:**
  - Implement a persistent execution state machine: `INTENT -> SIGNED -> SUBMITTED -> CONFIRMED / UNKNOWN -> RECONCILE`.
  - Query transaction signature before resubmitting.

### P1: DexScreener Polling Latency Defeats Rug-Exit
- **Location:** `src/rug-exit.ts`
- **Vulnerability:**
  DexScreener REST API updates lag by 15–60 seconds. Solana liquidity pulls happen in 1–2 blocks (~800ms). By the time DexScreener reports a 30% drop, pool liquidity is already 0.
- **Fix:**
  - Shift from polling REST endpoints to real-time WebSocket / Geyser account updates.

---

## 2. High-Alpha APIs & Edge Add-Ons (DeepSeek R1 Reasoning)

### High-Priority Data Feeds
1. **Helius Webhooks / Geyser Streams (Immediate #1 Priority):**
   - Direct `AccountUpdate` events from validators for sub-200ms detection of LP burns, mint freezes, and liquidity drains.
2. **Jito Block Engine (MEV Protection & Guaranteed Inclusions):**
   - Route swaps via private Jito Bundles to eliminate sandwich attacks and improve fill rates during launch volatility.
3. **Birdeye Data Services:**
   - Real-time order book depth and whale concentration heatmaps for dynamic position sizing.

### High-ROI Strategy & Autonomous Skills
1. **Dynamic Take-Profit Ladder (Fixes Early-Exit Regret):**
   - Instead of 100% exit at fixed take-profit, scale out (e.g. 50% at 2x to lock principal, trail remainder with trailing stop).
2. **Bonding-Curve Migration Sniper (Pump.fun -> Raydium):**
   - Detect curve completion events and enter within 3 blocks of migration seeding.
3. **Dev Wallet Profiler:**
   - Cluster creator addresses on-chain to detect serial ruggers before spending compute/capital.

---

## 3. Recommended Action Plan for Claude Code

1. **Step 1:** In `src/trader.ts`, patch `capSellAmount` / position sizing so `positionRaw === undefined` fails closed instead of returning `walletRaw`.
2. **Step 2:** Refactor take-profit in `src/trader.ts` to support multi-stage scale-out laddering.
3. **Step 3:** Add transaction signature check before any retry in `executeJupiterSwap`.
4. **Step 4:** Integrate Helius WebSocket feed into `src/rug-exit.ts` for real-time pool monitoring.
