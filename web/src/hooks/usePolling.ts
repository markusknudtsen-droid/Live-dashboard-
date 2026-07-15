import { useEffect, useRef, useState, useCallback } from "react";
import { ApiError } from "../api/client";
import { useAuth } from "../context/AuthContext";

interface PollingResult<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

export function usePolling<T>(fetcher: () => Promise<T>, intervalMs = 10_000): PollingResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { logout } = useAuth();
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const load = useCallback(async () => {
    try {
      const result = await fetcherRef.current();
      setData(result);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logout();
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to load data.");
    } finally {
      setLoading(false);
    }
  }, [logout]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), intervalMs);
    return () => clearInterval(id);
  }, [load, intervalMs]);

  return { data, error, loading, refresh: load };
}
