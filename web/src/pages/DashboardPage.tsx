import { useMemo } from "react";
import { usePolling } from "../hooks/usePolling";
import { api } from "../api/client";
import type { PortfolioResponse, TradeLogResponse, BotSettings } from "../api/types";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

export function DashboardPage() {
  const portfolio = usePolling<PortfolioResponse>(() => api.get("/portfolio"), 8000);
  const trades = usePolling<TradeLogResponse>(() => api.get("/trades?page=1&pageSize=10"), 15000);
  const settings = usePolling<BotSettings>(() => api.get("/settings"), 15000);

  const summary = portfolio.data?.summary;
  const pnlPositive = (summary?.pnl_percent ?? 0) >= 0;
  const winRate = useMemo(() => {
    const items = trades.data?.items ?? [];
    if (items.length === 0) return 0;
    const wins = items.filter((item) => (item.pnl_percent ?? 0) > 0 || item.outcome === "SUCCESS" || item.outcome.includes("TAKE_PROFIT"))
      .length;
    return (wins / items.length) * 100;
  }, [trades.data]);

  const chartData = useMemo(() => buildPnlSeries(trades.data), [trades.data]);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p>High-level overview of portfolio value, PnL, and bot status.</p>
        </div>
        <StatusPill active={Boolean(settings.data?.active_status) && !settings.data?.override_enabled} />
      </div>

      {portfolio.error && <div className="alert alert--error">{portfolio.error}</div>}

      <div className="grid grid--stats">
        <div className="card stat-card">
          <span className="stat-card__label">Portfolio Value</span>
          <span className="stat-card__value">{(summary?.total_value_sol ?? 0).toFixed(4)} SOL</span>
        </div>
        <div className="card stat-card">
          <span className="stat-card__label">Active Positions</span>
          <span className="stat-card__value">{summary?.total_positions ?? 0}</span>
        </div>
        <div className="card stat-card">
          <span className="stat-card__label">PnL</span>
          <span className={`stat-card__value ${pnlPositive ? "stat-card__value--positive" : "stat-card__value--negative"}`}>
            {pnlPositive ? "+" : ""}
            {(summary?.pnl_percent ?? 0).toFixed(2)}%
          </span>
        </div>
        <div className="card stat-card">
          <span className="stat-card__label">Win Rate</span>
          <span className="stat-card__value">{winRate.toFixed(1)}%</span>
        </div>
        <div className="card stat-card">
          <span className="stat-card__label">Base Buy Amount</span>
          <span className="stat-card__value">{(settings.data?.buy_amount_sol ?? 0).toFixed(3)} SOL</span>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Trade Outcomes (recent)</h2>
        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#dfe7f2" />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip />
              <Line type="monotone" dataKey="successRate" stroke="#2b7fe0" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-muted">No trade history yet.</p>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Recent Activity</h2>
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Type</th>
              <th>Pair</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {trades.data?.items.length ? (
              trades.data.items.slice(0, 6).map((item) => (
                <tr key={item.id}>
                  <td>{new Date(item.timestamp).toLocaleString()}</td>
                  <td>{item.type}</td>
                  <td>{item.pair}</td>
                  <td>
                    <OutcomeBadge outcome={item.outcome} />
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4} className="text-muted">
                  No trades recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function buildPnlSeries(trades: TradeLogResponse | null): { label: string; successRate: number }[] {
  if (!trades || trades.items.length === 0) return [];
  const sorted = [...trades.items].sort((a, b) => a.timestamp - b.timestamp);
  let successes = 0;
  return sorted.map((item, index) => {
    if (item.outcome === "SUCCESS") successes += 1;
    return {
      label: new Date(item.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      successRate: Math.round((successes / (index + 1)) * 100),
    };
  });
}

function StatusPill({ active }: { active: boolean }) {
  return (
    <span className={`badge ${active ? "badge--success" : "badge--warning"}`}>
      <span className={`status-dot ${active ? "status-dot--ok" : "status-dot--fail"}`} />
      {active ? "Bot Active" : "Bot Paused"}
    </span>
  );
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const isSuccess = outcome === "SUCCESS";
  return <span className={`badge ${isSuccess ? "badge--success" : "badge--danger"}`}>{outcome}</span>;
}
