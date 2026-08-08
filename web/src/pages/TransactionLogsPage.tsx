import { useEffect, useState } from "react";
import { usePolling } from "../hooks/usePolling";
import { api } from "../api/client";
import type { TradeLogResponse } from "../api/types";

export function TransactionLogsPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const pageSize = 15;
  const logs = usePolling<TradeLogResponse>(
    () => api.get(`/trades?page=${page}&pageSize=${pageSize}&search=${encodeURIComponent(search)}`),
    12000
  );

  useEffect(() => {
    void logs.refresh();
  }, [logs.refresh, page, search]);

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
        <div className="field" style={{ maxWidth: 360 }}>
          <label htmlFor="trade-search">Search trade log</label>
          <input
            id="trade-search"
            type="search"
            value={search}
            onChange={(event) => {
              setPage(1);
              setSearch(event.target.value);
            }}
            placeholder="Filter by symbol, token address, status, tx signature…"
          />
        </div>
        <div className="table-shell table-shell--tall">
          <table>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Type</th>
                <th>Pair</th>
                <th>Token Address</th>
                <th>Confidence</th>
                <th>PnL / Profit</th>
                <th>Mode</th>
                <th>Status</th>
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
                    <td className="mono">{item.token_address ? `${item.token_address.slice(0, 8)}…` : "—"}</td>
                    <td>{item.confidence ? `${item.confidence}%` : "—"}</td>
                    <td>
                      {item.pnl_percent !== undefined ? (
                        <span className={item.pnl_percent >= 0 ? "stat-card__value--positive" : "stat-card__value--negative"}>
                          {item.pnl_percent >= 0 ? "+" : ""}
                          {item.pnl_percent.toFixed(2)}%
                          {item.profit_sol !== undefined ? ` / ${item.profit_sol >= 0 ? "+" : ""}${item.profit_sol.toFixed(4)} SOL` : ""}
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td>{item.paper === undefined ? "—" : item.paper ? "Paper" : "Live"}</td>
                    <td>
                      <span className={`badge ${item.status === "completed" ? "badge--success" : "badge--danger"}`}>
                        {item.status}
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
        </div>

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
