import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.ts";

export interface FetchState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** GET with loading/error state; a null url means "nothing to load". Stale responses are dropped. */
export function useFetch<T>(url: string | null): FetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const load = useCallback(() => {
    if (!url) {
      seq.current++;
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    api<T>("GET", url).then(
      (d) => mine === seq.current && setData(d),
      (e: Error) => mine === seq.current && setError(e.message),
    ).finally(() => mine === seq.current && setLoading(false));
  }, [url]);

  useEffect(load, [load]);
  return { data, error, loading, reload: load };
}

export function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} kB`;
  return `${n} B`;
}

export const projectQuery = (projectPath: string | null) => (projectPath ? `project=${encodeURIComponent(projectPath)}` : "");
