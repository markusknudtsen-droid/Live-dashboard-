import { useState } from "react";
import { usePolling } from "../hooks/usePolling";
import { api, ApiError } from "../api/client";
import type { SecurityStatus, EncryptedWalletBlob } from "../api/types";
import { Modal } from "../components/Modal";

export function SystemSecurityPage() {
  const statusPoll = usePolling<SecurityStatus>(() => api.get("/security"), 15000);
  const status = statusPoll.data;
  const missingRequirements = status?.connection_manager.missing_requirements ?? [];

  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Export flow
  const [showExport, setShowExport] = useState(false);
  const [exportPassphrase, setExportPassphrase] = useState("");
  const [exporting, setExporting] = useState(false);

  // Import flow
  const [showImport, setShowImport] = useState(false);
  const [importPrivateKey, setImportPrivateKey] = useState("");
  const [importPassphrase, setImportPassphrase] = useState("");
  const [importing, setImporting] = useState(false);

  async function handleExport() {
    setExporting(true);
    setMessage(null);
    try {
      const { encrypted_wallet } = await api.post<{ encrypted_wallet: EncryptedWalletBlob }>("/security/wallet/export", {
        passphrase: exportPassphrase,
      });
      downloadJson(encrypted_wallet, "solana-wallet.vault.json");
      setMessage({ type: "success", text: "Encrypted wallet exported. Store the file and passphrase securely." });
      setShowExport(false);
      setExportPassphrase("");
    } catch (err) {
      setMessage({ type: "error", text: err instanceof ApiError ? err.message : "Export failed." });
    } finally {
      setExporting(false);
    }
  }

  async function handleImport() {
    setImporting(true);
    setMessage(null);
    try {
      const result = await api.post<{ active_address: string }>("/security/wallet/import", {
        privateKeyBase58: importPrivateKey,
        passphrase: importPassphrase,
      });
      setMessage({ type: "success", text: `Wallet imported. Active address: ${result.active_address}` });
      setShowImport(false);
      setImportPrivateKey("");
      setImportPassphrase("");
      statusPoll.refresh();
    } catch (err) {
      setMessage({ type: "error", text: err instanceof ApiError ? err.message : "Import failed." });
    } finally {
      setImporting(false);
    }
  }

  async function handleLock() {
    try {
      await api.post("/security/wallet/lock");
      statusPoll.refresh();
    } catch (err) {
      setMessage({ type: "error", text: err instanceof ApiError ? err.message : "Failed to lock wallet." });
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>System Security</h1>
          <p>Connection manager, readiness checks, API key management, and Solana wallet import/export.</p>
        </div>
      </div>

      {message && <div className={`alert alert--${message.type === "success" ? "success" : "error"}`}>{message.text}</div>}

      <div className="grid grid--two">
        <div className="card">
          <span className="kicker">Connection manager</span>
          <h2 style={{ marginTop: 6 }}>Trading Engine Link</h2>
          <div className="field">
            <label>Dashboard Port</label>
            <input type="text" readOnly value={status?.connection_manager.dashboard_port ?? "—"} className="mono" />
          </div>
          <div className="field">
            <label>Dashboard API Target</label>
            <input
              type="text"
              readOnly
              value={status?.connections.dashboard_api_url_configured ? "Configured in .env" : "Not configured"}
              className="mono"
            />
          </div>
          <div className="field">
            <label>Trade Ingest Key</label>
            <input
              type="text"
              readOnly
              value={status?.connections.dashboard_ingest_key_configured ? "Configured for bot push" : "Missing"}
              className="mono"
            />
          </div>
        </div>

        <div className="card">
          <span className="kicker">Readiness</span>
          <h2 style={{ marginTop: 6 }}>Real Solana Status</h2>
          <p className="text-muted" style={{ marginTop: 0 }}>
            Mode: <strong>{status?.connection_manager.engine_mode === "live" ? "Live Solana" : "Paper trading"}</strong>
          </p>
          <span
            className={`badge ${
              status?.connection_manager.real_trading_ready ? "badge--success" : "badge--warning"
            }`}
          >
            {status?.connection_manager.real_trading_ready ? "Ready for live dashboard trading" : "Configuration incomplete"}
          </span>
          {missingRequirements.length ? (
            <ul className="readiness-list">
              {missingRequirements.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">All required live-trading settings detected.</p>
          )}
        </div>
      </div>

      <div className="grid grid--two">
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Connection Health</h2>
          <HealthRow
            label="Solana RPC"
            healthy={status?.connections.solana_rpc.healthy}
            detail={status?.connections.solana_rpc.detail}
            latencyMs={status?.connections.solana_rpc.latency_ms}
          />
          <HealthRow
            label="DexScreener API"
            healthy={status?.connections.dexscreener.healthy}
            detail={status?.connections.dexscreener.detail}
            latencyMs={status?.connections.dexscreener.latency_ms}
          />
          <HealthRow label="OpenRouter Key" healthy={status?.connections.openrouter_key_configured} detail={status?.connections.openrouter_key_configured ? "configured" : "missing"} />
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>API Keys</h2>
          <div className="field">
            <label>OpenRouter API Key</label>
            <input type="text" readOnly value={status?.keys.openrouter_api_key || "not set"} className="mono" />
          </div>
          <div className="field">
            <label>Dashboard / Ingest Key</label>
            <input type="text" readOnly value={status?.keys.dashboard_api_key || "not set"} className="mono" />
          </div>
          <p className="text-muted" style={{ fontSize: 13 }}>
            Keys are configured via the bot's <code>.env</code> file and masked here for reference. Update them on the
            host running the bot, then restart the process.
          </p>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Solana Wallet</h2>
        <p className="text-muted">
          Active address: <span className="mono">{status?.wallet.active_address || "not configured"}</span>
        </p>
        <p className="text-muted">
          Status:{" "}
          <span className={`badge ${status?.wallet.unlocked_override_active ? "badge--success" : "badge--neutral"}`}>
            {status?.wallet.unlocked_override_active ? "Unlocked override active" : "Using .env configured key"}
          </span>{" "}
          {status?.wallet.encrypted_vault_present && <span className="badge badge--neutral">Encrypted vault saved</span>}
        </p>
        <div className="actions-row">
          <button type="button" className="btn btn--secondary" onClick={() => setShowExport(true)}>
            Export Private Key (Encrypted)
          </button>
          <button type="button" className="btn btn--secondary" onClick={() => setShowImport(true)}>
            Import Private Key
          </button>
          {status?.wallet.unlocked_override_active && (
            <button type="button" className="btn btn--danger" onClick={() => void handleLock()}>
              Lock Wallet
            </button>
          )}
        </div>
      </div>

      {showExport && (
        <Modal title="Export Encrypted Private Key" onClose={() => setShowExport(false)}>
          <p className="text-muted">
            Your private key will be encrypted with AES-256-GCM using this passphrase and downloaded as a file. The
            plaintext key is never transmitted or displayed.
          </p>
          <div className="field">
            <label htmlFor="exportPassphrase">Encryption Passphrase</label>
            <input
              id="exportPassphrase"
              type="password"
              value={exportPassphrase}
              onChange={(event) => setExportPassphrase(event.target.value)}
              autoFocus
            />
          </div>
          <div className="actions-row">
            <button type="button" className="btn btn--primary" onClick={() => void handleExport()} disabled={exporting}>
              {exporting ? "Encrypting…" : "Export"}
            </button>
            <button type="button" className="btn btn--secondary" onClick={() => setShowExport(false)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}

      {showImport && (
        <Modal title="Import Solana Private Key" onClose={() => setShowImport(false)}>
          <p className="text-muted">
            Paste a base58-encoded Solana private key. It will be encrypted at rest with the passphrase below and
            activated for this session.
          </p>
          <div className="field">
            <label htmlFor="importPrivateKey">Private Key (base58)</label>
            <input
              id="importPrivateKey"
              type="password"
              value={importPrivateKey}
              onChange={(event) => setImportPrivateKey(event.target.value)}
              autoFocus
            />
          </div>
          <div className="field">
            <label htmlFor="importPassphrase">Encryption Passphrase (for storage)</label>
            <input
              id="importPassphrase"
              type="password"
              value={importPassphrase}
              onChange={(event) => setImportPassphrase(event.target.value)}
            />
          </div>
          <div className="actions-row">
            <button type="button" className="btn btn--primary" onClick={() => void handleImport()} disabled={importing}>
              {importing ? "Importing…" : "Import"}
            </button>
            <button type="button" className="btn btn--secondary" onClick={() => setShowImport(false)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function HealthRow({
  label,
  healthy,
  detail,
  latencyMs,
}: {
  label: string;
  healthy?: boolean;
  detail?: string;
  latencyMs?: number | null;
}) {
  return (
    <div className="field field--inline" style={{ marginBottom: 12 }}>
      <span>{label}</span>
      <span className={`badge ${healthy ? "badge--success" : "badge--danger"}`}>
        <span className={`status-dot ${healthy ? "status-dot--ok" : "status-dot--fail"}`} />
        {detail || (healthy ? "ok" : "unavailable")}
        {latencyMs !== undefined && latencyMs !== null ? ` · ${latencyMs}ms` : ""}
      </span>
    </div>
  );
}

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
