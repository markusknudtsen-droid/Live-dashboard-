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

# 4. Run the bot
npm run trade
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run trade` | Start the full bot (scan → analyze → trade loop) |
| `npm run scan` | Scan only - find candidates without trading |
| `npm run analyze` | Scan + analyze - see signals without executing |
| `npm run inspect-web -- <url>` | Inspect a published MemeScope/Manus web page and print details + improvement suggestions |
| `npm run dev` | Development mode with hot reload |
| `npm run check` | Type-check project without emitting files |
| `npm run lint` | Lint alias (currently runs type-check rules) |
| `npm run build` | Compile TypeScript to dist/ |
| `npm run test` | Run automated tests |

## Configuration

All configuration is via `.env` file:

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENROUTER_API_KEY` | required | Your OpenRouter API key |
| `SOLANA_PRIVATE_KEY` | required | Base58 encoded wallet private key |
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
DASHBOARD_API_URL=https://your-dashboard.manus.space/api
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
npm run inspect-web -- https://your-dashboard.manus.space

# Or set a default URL in .env
DASHBOARD_WEB_URL=https://your-dashboard.manus.space
npm run inspect-web

# Get machine-readable output
npm run inspect-web -- https://your-dashboard.manus.space --json
```

The inspection command reports:
- Page metadata (title, description, canonical, Open Graph)
- Basic structure (H1/H2/H3 headings, forms, buttons, links)
- Accessibility hints (missing `lang`, missing image `alt` text)
- Framework hints and high-level improvement suggestions

## Security

- **Never commit your `.env` file** - it contains your private key
- The bot only trades with the configured `MAX_POSITION_SOL` amount
- Stop-loss ensures limited downside per trade
- All trades are executed via Jupiter for best routing and MEV protection
- Runtime state is persisted locally to avoid losing positions/trade history on restart

## Disclaimer

This bot is for educational and experimental purposes. Cryptocurrency trading carries significant risk. Never trade with money you cannot afford to lose. Past performance does not guarantee future results.
