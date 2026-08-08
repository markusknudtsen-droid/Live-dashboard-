import { useEffect, useState } from "react";
import { usePolling } from "../hooks/usePolling";
import { api, ApiError } from "../api/client";
import type { BotSettings } from "../api/types";

export function StrategyConfigPage() {
  const settingsPoll = usePolling<BotSettings>(() => api.get("/settings"), 15000);
  const [form, setForm] = useState<BotSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (settingsPoll.data && !form) {
      setForm(settingsPoll.data);
    }
  }, [settingsPoll.data, form]);

  if (!form) {
    return <p className="text-muted">Loading strategy configuration…</p>;
  }

  async function handleSave() {
    if (!form) return;
    setSaving(true);
    setMessage(null);
    try {
      const updated = await api.put<BotSettings>("/settings", form);
      setForm(updated);
      setMessage({ type: "success", text: "Strategy configuration saved." });
    } catch (err) {
      setMessage({ type: "error", text: err instanceof ApiError ? err.message : "Failed to save settings." });
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleOverride() {
    if (!form) return;
    const next = { ...form, override_enabled: !form.override_enabled };
    setForm(next);
    try {
      const updated = await api.put<BotSettings>("/settings", { override_enabled: next.override_enabled });
      setForm(updated);
    } catch (err) {
      setMessage({ type: "error", text: err instanceof ApiError ? err.message : "Failed to toggle override." });
    }
  }

  async function handleKillSwitch() {
    if (!form || form.override_enabled) {
      setMessage({ type: "success", text: "Emergency kill switch is already engaged." });
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      const updated = await api.put<BotSettings>("/settings", { override_enabled: true });
      setForm(updated);
      setMessage({ type: "success", text: "Emergency kill switch engaged. Autonomous trading is now halted." });
    } catch (err) {
      setMessage({ type: "error", text: err instanceof ApiError ? err.message : "Failed to engage kill switch." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Strategy Config</h1>
          <p>Adjust auto-buy amounts, risk thresholds, and manual overrides.</p>
        </div>
      </div>

      {message && <div className={`alert alert--${message.type === "success" ? "success" : "error"}`}>{message.text}</div>}

      <div className="card">
        <div className="emergency-panel">
          <div>
            <span className="kicker">Asset security override</span>
            <h2 style={{ margin: "6px 0" }}>Emergency Kill Switch</h2>
            <p className="text-muted" style={{ margin: 0 }}>
              Immediately freeze autonomous trading. The original pause toggle remains available below as a secondary
              control for resuming later.
            </p>
          </div>
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => void handleKillSwitch()}
            disabled={saving || form.override_enabled}
          >
            {form.override_enabled ? "Kill Switch Engaged" : "Engage Kill Switch"}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="field field--inline">
          <div>
            <label htmlFor="override">Pause Bot (Manual Override)</label>
            <p className="text-muted" style={{ margin: "2px 0 0", fontSize: 13 }}>
              Immediately interrupts the bot's autonomous trading loop.
            </p>
          </div>
          <label className="switch">
            <input id="override" type="checkbox" checked={form.override_enabled} onChange={() => void handleToggleOverride()} />
            <span className="switch__track" />
          </label>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Trade Parameters</h2>
        <div className="grid grid--two">
          <div className="field">
            <label htmlFor="buy_amount_sol">Base Trade Amount (SOL)</label>
            <input
              id="buy_amount_sol"
              type="number"
              step="0.01"
              min="0.001"
              max="10"
              value={form.buy_amount_sol}
              onChange={(event) => setForm({ ...form, buy_amount_sol: Number(event.target.value) })}
            />
          </div>
          <div className="field">
            <label htmlFor="min_confidence">Minimum AI Confidence (%)</label>
            <input
              id="min_confidence"
              type="number"
              min="0"
              max="100"
              value={form.min_confidence}
              onChange={(event) => setForm({ ...form, min_confidence: Number(event.target.value) })}
            />
          </div>
          <div className="field">
            <label htmlFor="stop_loss_percent">Stop Loss (%)</label>
            <input
              id="stop_loss_percent"
              type="number"
              min="1"
              max="95"
              value={form.stop_loss_percent}
              onChange={(event) => setForm({ ...form, stop_loss_percent: Number(event.target.value) })}
            />
          </div>
          <div className="field">
            <label htmlFor="take_profit_percent">Take Profit (%)</label>
            <input
              id="take_profit_percent"
              type="number"
              min="1"
              max="1000"
              value={form.take_profit_percent}
              onChange={(event) => setForm({ ...form, take_profit_percent: Number(event.target.value) })}
            />
          </div>
        </div>
        <div className="divider" />
        <button type="button" className="btn btn--primary" onClick={() => void handleSave()} disabled={saving}>
          {saving ? "Saving…" : "Save Strategy"}
        </button>
      </div>
    </>
  );
}
