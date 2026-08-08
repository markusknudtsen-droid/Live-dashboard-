import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api/client";
import { usePolling } from "../hooks/usePolling";
import type {
  AlertItem,
  BotSettings,
  EngineConnectionStatus,
  PortfolioResponse,
  ScannerFeedResponse,
  TradeLogResponse,
} from "../api/types";

export function CommandCenterPage() {
  const settingsPoll = usePolling<BotSettings>(() => api.get("/settings"), 15000);
  const portfolioPoll = usePolling<PortfolioResponse>(() => api.get("/portfolio"), 8000);
  const scannerPoll = usePolling<ScannerFeedResponse>(() => api.get("/market/scanner"), 20000);
  const alertsPoll = usePolling<{ items: AlertItem[] }>(() => api.get("/market/alerts"), 20000);
  const connectionPoll = usePolling<EngineConnectionStatus>(() => api.get("/settings/connection"), 12000);

  const [search, setSearch] = useState("");
  const tradesPoll = usePolling<TradeLogResponse>(
    () => api.get(`/trades?page=1&pageSize=30&q=${encodeURIComponent(search.trim())}`),
    12000
  );

  const [connectionForm, setConnectionForm] = useState({ port: "", engineApiKey: "" });
  const [connectionResult, setConnectionResult] = useState<EngineConnectionStatus | null>(null);
  const [savingConnection, setSavingConnection] = useState(false);
  const [killing, setKilling] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    const settingsData = settingsPoll.data;
    if (!settingsData) return;
    setConnectionForm((prev) =>
      prev.port
        ? prev
        : {
            port: String(settingsData.engine_port),
            engineApiKey: "",
          }
    );
  }, [settingsPoll.data]);

  const summary = portfolioPoll.data?.summary;
  const winRate = useMemo(() => {
    const items = tradesPoll.data?.items ?? [];
    if (!items.length) return 0;
    const wins = items.filter((trade) => trade.status === "completed" && !trade.outcome.toUpperCase().includes("LOSS")).length;
    return (wins / items.length) * 100;
  }, [tradesPoll.data?.items]);

  async function handleSaveConnection() {
    const port = Number(connectionForm.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setMessage({ type: "error", text: "Port must be an integer between 1 and 65535." });
      return;
    }

    setSavingConnection(true);
    setMessage(null);
    try {
      const updated = await api.put<BotSettings>("/settings", {
        engine_port: port,
        engine_api_key: connectionForm.engineApiKey,
      });
      const tested = await api.post<EngineConnectionStatus>("/settings/connection/test", {
        port,
        engine_api_key: connectionForm.engineApiKey,
      });
      setConnectionResult(tested);
      setMessage({
        type: "success",
        text: tested.connected
          ? `Connection healthy (${tested.latency_ms}ms). Settings saved.`
          : `Settings saved but engine check failed: ${tested.detail}`,
      });
      setConnectionForm({ port: String(updated.engine_port), engineApiKey: "" });
      settingsPoll.refresh();
      connectionPoll.refresh();
    } catch (err) {
      setMessage({ type: "error", text: err instanceof ApiError ? err.message : "Failed to save connection settings." });
    } finally {
      setSavingConnection(false);
    }
  }

  async function triggerKillSwitch() {
    if (!window.confirm("Engage emergency kill switch now? This pauses all autonomous trading immediately.")) {
      return;
    }
    setKilling(true);
    setMessage(null);
    try {
      await api.post("/settings/kill-switch");
      setMessage({
        type: "success",
        text: "Emergency kill switch engaged. Trading paused and wallet override locked.",
      });
      settingsPoll.refresh();
    } catch (err) {
      setMessage({ type: "error", text: err instanceof ApiError ? err.message : "Failed to engage kill switch." });
    } finally {
      setKilling(false);
    }
  }

  return (
    <div className="command-center">
      <div className="page-header">
        <div>
          <h1>Editorial Command Center</h1>
          <p>Primary operating mode for real-time Solana monitoring, overrides, scanner intelligence, and risk control.</p>
        </div>
      </div>

      {message && <div className={`alert alert--${message.type === "success" ? "success" : "error"}`}>{message.text}</div>}

      <div className="grid grid--stats">
        <div className="card stat-card">
          <span className="stat-card__label">PnL</span>
          <span className={`stat-card__value ${(summary?.pnl_percent ?? 0) >= 0 ? "stat-card__value--positive" : "stat-card__value--negative"}`}>
            {(summary?.pnl_percent ?? 0) >= 0 ? "+" : ""}
            {(summary?.pnl_percent ?? 0).toFixed(2)}%
          </span>
        </div>
        <div className="card stat-card">
          <span className="stat-card__label">Win Rate</span>
          <span className="stat-card__value">{winRate.toFixed(1)}%</span>
        </div>
        <div className="card stat-card">
          <span className="stat-card__label">Active Positions</span>
          <span className="stat-card__value">{summary?.total_positions ?? 0}</span>
        </div>
        <div className="card stat-card">
          <span className="stat-card__label">Portfolio Value</span>
          <span className="stat-card__value">{(summary?.total_value_sol ?? 0).toFixed(4)} SOL</span>
        </div>
      </div>

      <div className="grid grid--two">
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Connection Manager</h2>
          <div className="grid grid--two">
            <div className="field">
              <label htmlFor="enginePort">Engine Port</label>
              <input
                id="enginePort"
                type="number"
                min="1"
                max="65535"
                value={connectionForm.port}
                onChange={(event) => setConnectionForm({ ...connectionForm, port: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="engineApiKey">Engine API Key</label>
              <input
                id="engineApiKey"
                type="password"
                value={connectionForm.engineApiKey}
                onChange={(event) => setConnectionForm({ ...connectionForm, engineApiKey: event.target.value })}
                placeholder={settingsPoll.data?.engine_api_key_masked || "Optional"}
              />
            </div>
          </div>
          <div className="actions-row">
            <button type="button" className="btn btn--primary" disabled={savingConnection} onClick={() => void handleSaveConnection()}>
              {savingConnection ? "Saving…" : "Save + Ping Engine"}
            </button>
            <span className={`badge ${connectionPoll.data?.connected ? "badge--success" : "badge--danger"}`}>
              {connectionPoll.data?.connected ? "Connected" : "Disconnected"}
              <span className="mono">{connectionPoll.data ? `${connectionPoll.data.latency_ms}ms` : "n/a"}</span>
            </span>
          </div>
          {connectionResult && <p className="text-muted">Last check: {connectionResult.detail}</p>}
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>Emergency Kill Switch</h2>
          <p className="text-muted">
            Override all bot instructions immediately. This forces manual override on and prevents autonomous entries.
          </p>
          <button type="button" className="btn btn--danger btn--kill-switch" disabled={killing} onClick={() => void triggerKillSwitch()}>
            {killing ? "Engaging…" : "ENGAGE KILL SWITCH"}
          </button>
        </div>
      </div>

      <div className="grid grid--two">
        <div className="card">
          <h2 style={{ marginTop: 0 }}>CTO & DEXBoost Alerts</h2>
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Token Address</th>
                <th>Boosts</th>
                <th>Triggered</th>
              </tr>
            </thead>
            <tbody>
              {alertsPoll.data?.items.length ? (
                alertsPoll.data.items.slice(0, 8).map((alert) => (
                  <tr key={alert.id}>
                    <td>
                      <span className={`badge ${alert.type === "Boost" ? "badge--warning" : "badge--success"}`}>{alert.type}</span>
                    </td>
                    <td className="mono">{alert.token_address.slice(0, 10)}…</td>
                    <td>{alert.boost_count}</td>
                    <td>{new Date(alert.triggered_at).toLocaleTimeString()}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className="text-muted">
                    {alertsPoll.loading ? "Checking alerts…" : "No active CTO/Boost alerts this cycle."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>Risk Control Panel</h2>
          <div className="field field--inline">
            <span>Trading Status</span>
            <span className={`badge ${settingsPoll.data?.override_enabled ? "badge--danger" : "badge--success"}`}>
              {settingsPoll.data?.override_enabled ? "Paused" : "Active"}
            </span>
          </div>
          <div className="field field--inline">
            <span>Max Exposure / Trade</span>
            <span className="mono">{(settingsPoll.data?.buy_amount_sol ?? 0).toFixed(3)} SOL</span>
          </div>
          <div className="field field--inline">
            <span>Stop-Loss</span>
            <span className="mono">{settingsPoll.data?.stop_loss_percent ?? 0}%</span>
          </div>
          <div className="field field--inline">
            <span>Take-Profit</span>
            <span className="mono">{settingsPoll.data?.take_profit_percent ?? 0}%</span>
          </div>
          <div className="field field--inline">
            <span>Min Confidence</span>
            <span className="mono">{settingsPoll.data?.min_confidence ?? 0}%</span>
          </div>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Live Trade Feed</h2>
        <div className="field" style={{ maxWidth: 360 }}>
          <label htmlFor="tradeSearch">Search Trades</label>
          <input
            id="tradeSearch"
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Symbol, token address, tx signature..."
          />
        </div>
        <table>
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Type</th>
              <th>Token Address</th>
              <th>Entry</th>
              <th>Exit</th>
              <th>Profit (SOL)</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {tradesPoll.data?.items.length ? (
              tradesPoll.data.items.map((trade) => (
                <tr key={trade.id}>
                  <td>{new Date(trade.timestamp).toLocaleString()}</td>
                  <td>{trade.type}</td>
                  <td className="mono">{trade.token_address ? `${trade.token_address.slice(0, 10)}…` : "—"}</td>
                  <td>{trade.entry_price !== undefined ? `$${trade.entry_price.toFixed(8)}` : "—"}</td>
                  <td>{trade.exit_price !== undefined ? `$${trade.exit_price.toFixed(8)}` : "—"}</td>
                  <td className={trade.profit_sol >= 0 ? "stat-card__value--positive" : "stat-card__value--negative"}>
                    {trade.profit_sol >= 0 ? "+" : ""}
                    {trade.profit_sol.toFixed(4)}
                  </td>
                  <td>
                    <span className={`badge ${trade.status === "failed" ? "badge--danger" : trade.status === "pending" ? "badge--warning" : "badge--success"}`}>
                      {trade.status}
                    </span>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={7} className="text-muted">
                  {tradesPoll.loading ? "Loading feed…" : "No trades found."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Scanner Feed (Env-Driven Filters)</h2>
        <p className="text-muted">
          Current filters: volume &gt; {scannerPoll.data?.filters.min_volume_24h ?? 10000}, liquidity &gt;{" "}
          {scannerPoll.data?.filters.min_liquidity_usd ?? 5000}, buy ratio &gt;{" "}
          {scannerPoll.data?.filters.min_buy_ratio ?? 0.45}, age &lt; {scannerPoll.data?.filters.max_age_hours ?? 168}h
        </p>
        <table>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Boosts</th>
              <th>Volume 24h</th>
              <th>Liquidity</th>
              <th>Buy/Sell</th>
              <th>Age</th>
            </tr>
          </thead>
          <tbody>
            {scannerPoll.data?.items.length ? (
              scannerPoll.data.items.slice(0, 12).map((token) => (
                <tr key={token.token_address}>
                  <td>{token.symbol}</td>
                  <td>{token.boost_count}</td>
                  <td>${Math.round(token.volume_24h).toLocaleString()}</td>
                  <td>${Math.round(token.liquidity_usd).toLocaleString()}</td>
                  <td>{token.buy_to_sell_ratio.toFixed(2)}</td>
                  <td>{token.age_hours.toFixed(1)}h</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="text-muted">
                  {scannerPoll.loading ? "Scanning…" : "No scanner items available."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
