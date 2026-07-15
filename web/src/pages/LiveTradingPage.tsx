import { usePolling } from "../hooks/usePolling";
import { api } from "../api/client";
import type { PortfolioResponse, TrendingToken } from "../api/types";

/**
 * Memecoin prices are often sub-cent, so a fixed decimal count avoids
 * scientific notation while still showing meaningful precision.
 */
function formatUsdPrice(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const decimals = value < 0.01 ? 8 : value < 1 ? 6 : 4;
  return value.toFixed(decimals);
}

export function LiveTradingPage() {
  const portfolio = usePolling<PortfolioResponse>(() => api.get("/portfolio"), 6000);
  const trending = usePolling<TrendingToken[]>(() => api.get("/market/trending"), 20000);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Live Trading View</h1>
          <p>Real-time positions and trending memecoins by market volume.</p>
        </div>
      </div>

      {portfolio.error && <div className="alert alert--error">{portfolio.error}</div>}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Current Positions</h2>
        <table>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Entry Price</th>
              <th>Current Price</th>
              <th>PnL %</th>
              <th>Size (SOL)</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {portfolio.data?.positions.length ? (
              portfolio.data.positions.map((position) => (
                <tr key={position.token_address}>
                  <td>{position.symbol}</td>
                  <td>${formatUsdPrice(position.entry_price)}</td>
                  <td>${formatUsdPrice(position.current_price)}</td>
                  <td className={position.pnl_percent >= 0 ? "stat-card__value--positive" : "stat-card__value--negative"}>
                    {position.pnl_percent >= 0 ? "+" : ""}
                    {position.pnl_percent.toFixed(2)}%
                  </td>
                  <td>{position.balance.toFixed(4)}</td>
                  <td>
                    <span className={`badge ${position.status === "in_profit" ? "badge--success" : "badge--danger"}`}>
                      {position.status === "in_profit" ? "In Profit" : "At Loss"}
                    </span>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="text-muted">
                  No active positions.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Trending Memecoins (by volume)</h2>
        {trending.error && <div className="alert alert--error">{trending.error}</div>}
        <table>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Price</th>
              <th>24h Change</th>
              <th>Volume 24h</th>
              <th>Liquidity</th>
              <th>Buy/Sell</th>
              <th>Age</th>
            </tr>
          </thead>
          <tbody>
            {trending.data?.length ? (
              trending.data.map((token) => (
                <tr key={token.address}>
                  <td>
                    <a href={token.url} target="_blank" rel="noreferrer">
                      {token.symbol}
                    </a>
                  </td>
                  <td>${formatUsdPrice(token.price_usd)}</td>
                  <td className={token.price_change_24h >= 0 ? "stat-card__value--positive" : "stat-card__value--negative"}>
                    {token.price_change_24h >= 0 ? "+" : ""}
                    {token.price_change_24h.toFixed(2)}%
                  </td>
                  <td>${Math.round(token.volume_24h).toLocaleString()}</td>
                  <td>${Math.round(token.liquidity_usd).toLocaleString()}</td>
                  <td>{token.buy_to_sell_ratio.toFixed(2)}</td>
                  <td>{token.age_hours.toFixed(1)}h</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={7} className="text-muted">
                  {trending.loading ? "Scanning market…" : "No trending tokens found this cycle."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
