# Memecoin AI Trading Bot

An autonomous Solana memecoin trading bot powered by AI analysis via OpenRouter. Designed for high win-rate trading with strict risk management.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    SCAN → ANALYZE → TRADE                │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  1. SCANNER (DexScreener API)                           │
│     • Fetches boosted tokens, trending, new pools       │
│     • Filters: volume > $10k, liquidity > $5k           │
│     • Targets: tokens < 7 days old, buy ratio > 45%     │
│                                                          │
│  2. AI ANALYZER (OpenRouter - Gemini 2.0 Flash)         │
│     • Structured analysis with confidence scoring       │
│     • Evaluates: trend, momentum, risk, narrative       │
│     • Only recommends BUY at 80%+ confidence            │
│                                                          │
│  3. TRADER (Jupiter Aggregator + Solana)                │
│     • Best-price routing across all Solana DEXes        │
│     • Auto stop-loss and take-profit execution          │
│     • Max 3 concurrent positions                        │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/markusknudtsen-droid/memecoin-trading-bot.git
cd memecoin-trading-bot

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your keys

# 4. Test first with a fake SOL balance (no real funds, no real transactions)
# In .env set: DRY_RUN=true
npm run trade

# 5. Once you're happy with the results, disable dry-run to trade with real SOL
# In .env set: DRY_RUN=false (and SOLANA_PRIVATE_KEY=<your real key>)
npm run trade
```

### Paper trading / dry-run mode

Set `DRY_RUN=true` in your `.env` to test the full bot loop (scan → analyze → simulated
trade) against real market data, but with a **simulated wallet and fake SOL balance**
(`PAPER_STARTING_BALANCE_SOL`, default 10 SOL). No `SOLANA_PRIVATE_KEY` is required, and
no real Solana transactions are ever sent - buys/sells only update an in-memory paper
balance and position list. Use this to validate your confidence/stop-loss/take-profit
settings before risking real SOL. Always start here before switching to `DRY_RUN=false`.

## Commands

| Command | Description |
|---------|-------------|
| `npm run trade` | Start the full bot (scan → analyze → trade loop). Set `DRY_RUN=true` in `.env` to simulate trades with fake SOL first |
| `npm run scan` | Scan only - find candidates without trading |
| `npm run analyze` | Scan + analyze - see signals without executing |
| `npm run inspect-web -- <url>` | Inspect a published MemeScope web page and print details + improvement suggestions |
| `npm run dev` | Development mode with hot reload |
| `npm run check` | Type-check project without emitting files |
| `npm run lint` | Lint alias (currently runs type-check rules) |
| `npm run build` | Compile TypeScript to dist/ |
| `npm run test` | Run automated tests |
| `npm run hash-password -- <password>` | Generate a `DASHBOARD_PASSWORD_HASH` value for dashboard login |
| `npm run server:dev` | Run the dashboard API in dev mode with hot reload |
| `npm run server:build` / `npm run server:start` | Compile and run the dashboard API for production |
| `npm run web:install` | Install the dashboard frontend's dependencies |
| `npm run web:dev` | Run the dashboard frontend in dev mode (Vite) |
| `npm run web:build` | Build the dashboard frontend for production |

## Configuration

All configuration is via `.env` file:

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENROUTER_API_KEY` | required | Your OpenRouter API key |
| `SOLANA_PRIVATE_KEY` | required (unless `DRY_RUN=true`) | Base58 encoded wallet private key |
| `DRY_RUN` | false | Simulate trades with a fake wallet and paper balance; no real transactions are sent |
| `PAPER_STARTING_BALANCE_SOL` | 10 | Fake starting SOL balance used when `DRY_RUN=true` |
| `MIN_CONFIDENCE` | 80 | Minimum AI confidence to execute (0-100) |
| `MAX_POSITION_SOL` | 0.5 | Max SOL per trade |
| `STOP_LOSS_PERCENT` | 15 | Stop loss trigger (-15%) |
| `TAKE_PROFIT_PERCENT` | 50 | Take profit trigger (+50%) |
| `SCAN_INTERVAL_SECONDS` | 60 | Time between scan cycles |
| `SCAN_CHAINS` | solana | Chains to scan (comma-separated) |
| `LOG_LEVEL` | info | Structured log level (`debug`, `info`, `warn`, `error`) |
| `HTTP_TIMEOUT_MS` | 10000 | Timeout for external HTTP requests |
| `HTTP_MAX_RETRIES` | 3 | Retry attempts for retryable API errors |
| `ALLOW_SKIP_PREFLIGHT` | false | Skip transaction preflight (unsafe; keep disabled for safety) |
| `BOT_STATE_FILE` | `./data/state.json` | Local JSON file used to persist positions and trade history |

## Risk Management

- **Position sizing**: Max 0.5 SOL per trade (configurable)
- **Stop loss**: Automatic -15% exit (configurable)
- **Take profit**: Automatic +50% exit (configurable)
- **Max positions**: 3 concurrent trades maximum
- **Confidence threshold**: Only trades at 80%+ AI confidence
- **Balance protection**: Won't trade below 0.05 SOL

## AI Analysis Criteria

The AI evaluates each token on:

1. **Trend Strength** - Price action across 5m, 1h, 6h, 24h timeframes
2. **Momentum** - Accelerating, steady, decelerating, or reversing
3. **Volume/Liquidity** - Healthy ratio indicates real interest
4. **Buy/Sell Ratio** - Higher buy pressure = bullish
5. **Token Age** - Fresh tokens with growing metrics preferred
6. **Narrative Fit** - Alignment with trending metas (AI, memes, gaming, etc.)
7. **Risk Level** - Low liquidity, concentrated holders = higher risk

## Future Web Dashboard Plugin

This bot is designed to connect to the MemeScope AI web dashboard in the future:

```bash
# Set these in .env when ready to connect:
DASHBOARD_API_URL=https://memescope-command-center.lovable.app/api
DASHBOARD_API_KEY=your-api-key
```

The plugin will:
- Report trade history to the dashboard
- Show live positions in the Wallet page
- Allow configuration changes from the web UI
- Display performance analytics

You can also inspect a published dashboard page directly from the CLI:

```bash
# Inspect a specific deployment
npm run inspect-web -- https://memescope-command-center.lovable.app

# Or set a default URL in .env
DASHBOARD_WEB_URL=https://memescope-command-center.lovable.app
npm run inspect-web

# Get machine-readable output
npm run inspect-web -- https://memescope-command-center.lovable.app --json
```

The inspection command reports:
- Page metadata (title, description, canonical, Open Graph)
- Basic structure (H1/H2/H3 headings, forms, buttons, links)
- Accessibility hints (missing `lang`, missing image `alt` text)
- Framework hints and high-level improvement suggestions

## Live Dashboard (Command Center)

> 🔗 **Hosted paper-trading cockpit:** https://memescope-command-center.lovable.app
> — the public **MemeScope Command Center** that replaces the old `manus.space`
> site. It pulls live DexScreener boost signals in the browser, mirrors the
> scanner filters, and simulates the bot's buy/sell behaviour (fake wallet, no
> real funds) with every trade settling back to the bot wallet.

This repo now ships a private, self-hosted control center for the bot: an Express API (`server/`) plus a
React + Vite frontend (`web/`), themed "Arctic" (clean, minimalist, `#2B7FE0` / `#3C82DC`).

### Screens

| Screen | Purpose |
|--------|---------|
| Dashboard | Portfolio value, active positions, PnL trend, bot status |
| Live Trading View | Real-time positions table + trending memecoins by volume |
| Strategy Config | Base trade amount, risk thresholds, confidence, **Pause Bot** override |
| Vault Portal | Extractable profit + SOL withdrawal with mandatory secondary confirmation |
| Transaction Logs | Paginated trade/withdrawal history |
| System Security | Connection health, masked API keys, encrypted Solana private key import/export |

### Setup

```bash
# 1. Generate a password hash for dashboard login
npm run hash-password -- "your-strong-password"
# Copy the output into DASHBOARD_PASSWORD_HASH in .env

# 2. Configure the remaining dashboard variables in .env
DASHBOARD_JWT_SECRET=some-long-random-string
WITHDRAWAL_CONFIRMATION_CODE=a-secret-only-you-know

# 3. Install the frontend's dependencies
npm run web:install

# 4. Run the API and frontend in dev mode (two terminals)
npm run server:dev
npm run web:dev   # Vite dev server proxies /api to the backend

# 5. Or build everything for a single-process production deployment
npm run web:build
npm run server:build
npm run server:start   # serves the built frontend + API on DASHBOARD_PORT
```

### Security model

- **Authentication**: a password hash (`DASHBOARD_PASSWORD_HASH`, generated with `npm run hash-password`) gates
  every dashboard screen. Sessions are signed JWTs stored in an `httpOnly` cookie.
- **Manual override**: the Strategy Config "Pause Bot" toggle writes to `data/settings.json`; the trading loop
  in `src/index.ts` checks this before every cycle and skips trading (while still monitoring existing positions)
  when enabled.
- **Withdrawals**: the Vault Portal requires a secondary `WITHDRAWAL_CONFIRMATION_CODE` in addition to the
  authenticated session before any SOL leaves the wallet, and always reserves a small SOL buffer for fees.
- **Private key import/export**: the System Security screen never transmits or displays your plaintext private
  key. Export encrypts it (AES-256-GCM, scrypt-derived key) with a passphrase you choose and downloads a JSON
  file; import accepts either a raw base58 key or a previously exported encrypted file, and immediately
  re-encrypts it at rest under `data/wallet.vault.json`.

## Security

- **Never commit your `.env` file** - it contains your private key
- The bot only trades with the configured `MAX_POSITION_SOL` amount
- Stop-loss ensures limited downside per trade
- All trades are executed via Jupiter for best routing and MEV protection
- Runtime state is persisted locally to avoid losing positions/trade history on restart

## Disclaimer

This bot is for educational and experimental purposes. Cryptocurrency trading carries significant risk. Never trade with money you cannot afford to lose. Past performance does not guarantee future results.
