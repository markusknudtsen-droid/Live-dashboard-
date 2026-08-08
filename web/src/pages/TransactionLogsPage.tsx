import { useState } from "react";
import { usePolling } from "../hooks/usePolling";
import { api } from "../api/client";
import type { TradeLogResponse } from "../api/types";

export function TransactionLogsPage() {
  const [page, setPage] = useState(1);
  const pageSize = 15;
  const logs = usePolling<TradeLogResponse>(() => api.get(`/trades?page=${page}&pageSize=${pageSize}`), 12000);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Transaction Logs</h1>
          <p>A paginated list of all completed sequences with timestamps and outcomes.</p>
        </div>
      </div>

      {logs.error && <div className="alert alert--error">{logs.error}</div>}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Type</th>
              <th>Pair</th>
              <th>Token Address</th>
              <th>Confidence</th>
              <th>Profit (SOL)</th>
              <th>Status</th>
              <th>Outcome</th>
              <th>Tx Signature</th>
            </tr>
          </thead>
          <tbody>
            {logs.data?.items.length ? (
              logs.data.items.map((item) => (
                <tr key={item.id}>
                  <td>{new Date(item.timestamp).toLocaleString()}</td>
                  <td>{item.type}</td>
                  <td>{item.pair}</td>
                  <td className="mono">{item.token_address ? `${item.token_address.slice(0, 10)}…` : "—"}</td>
                  <td>{item.confidence !== undefined ? `${item.confidence}%` : "—"}</td>
                  <td className={item.profit_sol >= 0 ? "stat-card__value--positive" : "stat-card__value--negative"}>
                    {item.profit_sol >= 0 ? "+" : ""}
                    {item.profit_sol.toFixed(4)}
                  </td>
                  <td>
                    <span
                      className={`badge ${
                        item.status === "failed" ? "badge--danger" : item.status === "pending" ? "badge--warning" : "badge--success"
                      }`}
                    >
                      {item.status}
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${item.status === "failed" ? "badge--danger" : "badge--success"}`}>
                      {item.outcome}
                    </span>
                  </td>
                  <td>
                    {item.tx_signature ? (
                      <a
                        href={`https://solscan.io/tx/${item.tx_signature}`}
                        target="_blank"
                        rel="noreferrer"
                        className="mono"
                      >
                        {item.tx_signature.slice(0, 8)}…
                      </a>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={9} className="text-muted">
                  No transactions recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="pagination">
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
          >
            Previous
          </button>
          <span>
            Page {logs.data?.page ?? page} of {logs.data?.totalPages ?? 1}
          </span>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => setPage((p) => (logs.data && p < logs.data.totalPages ? p + 1 : p))}
            disabled={!logs.data || page >= logs.data.totalPages}
          >
            Next
          </button>
        </div>
      </div>
    </>
  );
}
