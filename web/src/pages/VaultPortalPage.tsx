import { useState } from "react";
import { usePolling } from "../hooks/usePolling";
import { api, ApiError } from "../api/client";
import type { VaultInfo } from "../api/types";
import { Modal } from "../components/Modal";

export function VaultPortalPage() {
  const vaultPoll = usePolling<VaultInfo>(() => api.get("/vault"), 10000);
  const [showConfirm, setShowConfirm] = useState(false);
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState("");
  const [confirmationCode, setConfirmationCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const vault = vaultPoll.data;

  function openConfirm() {
    setMessage(null);
    if (!amount || Number(amount) <= 0) {
      setMessage({ type: "error", text: "Enter a valid withdrawal amount." });
      return;
    }
    if (!destination) {
      setMessage({ type: "error", text: "Enter a destination wallet address." });
      return;
    }
    setShowConfirm(true);
  }

  async function handleWithdraw() {
    setSubmitting(true);
    setMessage(null);
    try {
      const result = await api.post<{ tx_signature: string }>("/vault/withdraw", {
        amountSol: Number(amount),
        destinationAddress: destination,
        confirmationCode,
      });
      setMessage({ type: "success", text: `Withdrawal submitted. Tx: ${result.tx_signature}` });
      setShowConfirm(false);
      setConfirmationCode("");
      setAmount("");
      vaultPoll.refresh();
    } catch (err) {
      setMessage({ type: "error", text: err instanceof ApiError ? err.message : "Withdrawal failed." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Vault Portal</h1>
          <p>Extract earned SOL to your private wallet with secondary verification.</p>
        </div>
      </div>

      {vaultPoll.error && <div className="alert alert--error">{vaultPoll.error}</div>}
      {message && <div className={`alert alert--${message.type === "success" ? "success" : "error"}`}>{message.text}</div>}

      <div className="grid grid--stats">
        <div className="card stat-card">
          <span className="stat-card__label">Wallet Balance</span>
          <span className="stat-card__value">{(vault?.balance_sol ?? 0).toFixed(4)} SOL</span>
        </div>
        <div className="card stat-card">
          <span className="stat-card__label">Extractable Profit</span>
          <span className="stat-card__value stat-card__value--positive">{(vault?.extractable_sol ?? 0).toFixed(4)} SOL</span>
        </div>
        <div className="card stat-card">
          <span className="stat-card__label">Reserved (fees)</span>
          <span className="stat-card__value">{(vault?.reserved_sol ?? 0).toFixed(4)} SOL</span>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Transfer to Private Wallet</h2>
        <p className="text-muted mono">{vault?.wallet_address}</p>
        <div className="grid grid--two">
          <div className="field">
            <label htmlFor="amount">Amount (SOL)</label>
            <input
              id="amount"
              type="number"
              min="0"
              step="0.0001"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder={`Up to ${(vault?.extractable_sol ?? 0).toFixed(4)}`}
            />
          </div>
          <div className="field">
            <label htmlFor="destination">Destination Address</label>
            <input
              id="destination"
              type="text"
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
              placeholder={vault?.private_withdrawal_address || "Solana wallet address"}
            />
          </div>
        </div>
        <button type="button" className="btn btn--primary" onClick={openConfirm}>
          Transfer to Private Wallet
        </button>
      </div>

      {showConfirm && (
        <Modal title="Confirm Withdrawal" onClose={() => setShowConfirm(false)}>
          <p>
            You are about to transfer <strong>{amount} SOL</strong> to:
          </p>
          <p className="mono">{destination}</p>
          <div className="field">
            <label htmlFor="confirmationCode">Secondary Confirmation Code</label>
            <input
              id="confirmationCode"
              type="password"
              value={confirmationCode}
              onChange={(event) => setConfirmationCode(event.target.value)}
              placeholder="Enter your withdrawal confirmation code"
              autoFocus
            />
          </div>
          <div className="actions-row">
            <button type="button" className="btn btn--primary" onClick={() => void handleWithdraw()} disabled={submitting}>
              {submitting ? "Processing…" : "Confirm Withdrawal"}
            </button>
            <button type="button" className="btn btn--secondary" onClick={() => setShowConfirm(false)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
