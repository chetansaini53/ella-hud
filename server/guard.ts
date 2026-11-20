import path from "node:path";
import { HttpError } from "./http-error.ts";

export interface GuardConfig {
  hosts: Set<string>;
  origins: Set<string>;
}

/** Host allowlist for the API port, plus the Vite dev port only in --dev mode. */
export function guardConfig(port: number, devPort: number | null): GuardConfig {
  const hosts = new Set([port, ...(devPort ? [devPort] : [])].flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`]));
  return { hosts, origins: new Set([...hosts].map((h) => `http://${h}`)) };
}

interface RequestLike {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * DNS-rebinding + cross-site guard.
 * - Host must be one of ours (blocks rebinding to 127.0.0.1).
 * - A present Origin must be ours.
 * - State-changing methods must prove same-origin: our Origin, or Sec-Fetch-Site: same-origin.
 */
export function guardRequest(req: RequestLike, cfg: GuardConfig): void {
  const host = req.headers.host;
  if (typeof host !== "string" || !cfg.hosts.has(host)) throw new HttpError(421, "Unknown host");
  const origin = req.headers.origin;
  if (origin !== undefined && (typeof origin !== "string" || !cfg.origins.has(origin))) throw new HttpError(403, "Cross-origin request blocked");
  const safe = req.method === "GET" || req.method === "HEAD";
  if (!safe && origin === undefined && req.headers["sec-fetch-site"] !== "same-origin") {
    throw new HttpError(403, "Same-origin proof required");
  }
}

/** Maps a URL path to a file inside dist; anything outside (or undecodable) is refused. */
export function resolveStatic(dist: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const target = path.resolve(dist, `.${decoded}`);
  return target === dist || target.startsWith(dist + path.sep) ? target : null;
}
