import { useState } from "react";
import type { FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export function LoginPage() {
  const { login, loading, error, isAuthenticated } = useAuth();
  const [password, setPassword] = useState("");

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    await login(password);
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <h1>MemeScope Control</h1>
        <p>Private command center. Sign in to continue.</p>
        {error && <div className="alert alert--error">{error}</div>}
        <form onSubmit={(event) => void handleSubmit(event)}>
          <div className="field">
            <label htmlFor="password">Dashboard password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoFocus
            />
          </div>
          <button type="submit" className="btn btn--primary" style={{ width: "100%" }} disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
