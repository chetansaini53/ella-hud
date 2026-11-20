import { execFile } from "node:child_process";
import type { Usage, UsageWindow } from "../shared/types.ts";

const EMPTY: Usage = { session: null, week: null, details: [] };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Wall-clock time in an IANA zone → epoch ms (the offset is read back from Intl at that instant). */
function zonedToEpoch(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo, d, h, mi);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(guess);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return guess - (Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute")) - guess);
}

/** "Nov 20, 5:50pm (Asia/Kolkata)" → epoch ms. The year is not printed, so a past date rolls to next year. */
export function parseResetTime(text: string, now: number): number | null {
  const m = /^([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?\s*([ap]m)\s*(?:\(([^)]+)\))?/i.exec(text.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!.toLowerCase());
  if (month < 0) return null;
  const hour = (Number(m[3]) % 12) + (m[5]!.toLowerCase() === "pm" ? 12 : 0);
  const tz = m[6] ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    const year = new Date(now).getFullYear();
    const at = zonedToEpoch(year, month, Number(m[2]), hour, Number(m[4] ?? 0), tz);
    return at < now - 86_400_000 ? zonedToEpoch(year + 1, month, Number(m[2]), hour, Number(m[4] ?? 0), tz) : at;
  } catch {
    return null;
  }
}

/** Parses the text `/usage` prints: "Current session: 18% used · resets Nov 20, 5:50pm (Asia/Kolkata)". */
export function parseUsageText(text: string, now: number): Usage {
  const out: Usage = { session: null, week: null, details: [] };
  let inDetails = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const w = /^Current (session|week[^:]*):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s+(.+))?$/i.exec(line);
    if (w) {
      const win: UsageWindow = { pct: Math.min(100, Number(w[2])), resetsAt: w[3] ? parseResetTime(w[3], now) : null };
      // Only the all-models week feeds the WEEK meter; per-model weeks are ignored.
      if (w[1]!.toLowerCase() === "session") out.session = win;
      else if (/all models/i.test(w[1]!) || !/\(/.test(w[1]!)) out.week = win;
      continue;
    }
    if (/^What's contributing/i.test(line)) inDetails = true;
    else if (inDetails && line) out.details.push(line);
  }
  return out;
}

/** Runs the CLI's own `/usage` (local command, no tokens spent) and parses it. */
export function fetchUsage(bin: string, configDir: string | null): Promise<Usage> {
  const env = { ...process.env };
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  else delete env.CLAUDE_CONFIG_DIR;
  return new Promise((resolve, reject) => {
    const child = execFile(bin, ["-p", "/usage", "--output-format", "json"], { env, timeout: 20_000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const result = (JSON.parse(stdout) as { result?: unknown }).result;
        resolve(typeof result === "string" ? parseUsageText(result, Date.now()) : EMPTY);
      } catch (e) {
        reject(e);
      }
    });
    // Nothing is piped in; without this, claude -p waits 3 s for stdin on every poll.
    child.stdin?.end();
  });
}

/**
 * Plan usage. Two feeds: `/usage` polling (authoritative, works before any worker replies) and the
 * `rate_limit_event` lines a headless worker prints (fresher between polls; utilization is 0–1).
 */
export class UsageTracker {
  #usage: Usage = { ...EMPTY };

  reset(): void {
    this.#usage = { ...EMPTY };
  }

  get(): Usage {
    const now = Date.now();
    const live = (w: UsageWindow | null) => (w?.resetsAt && w.resetsAt < now ? null : w);
    this.#usage = { ...this.#usage, session: live(this.#usage.session), week: live(this.#usage.week) };
    return this.#usage;
  }

  /** Replaces the meters with a `/usage` snapshot; returns true when anything changed. */
  setSnapshot(next: Usage): boolean {
    if (!next.session && !next.week) return false;
    const changed = JSON.stringify(next) !== JSON.stringify(this.#usage);
    this.#usage = next;
    return changed;
  }

  /** Returns true when the event changed a meter. */
  apply(event: Record<string, unknown>): boolean {
    const info = event.rate_limit_info as Record<string, unknown> | undefined;
    if (!info) return false;
    const kind = info.rateLimitType ?? info.rate_limit_type;
    const slot = kind === "five_hour" ? "session" : kind === "seven_day" ? "week" : null;
    const util = info.utilization;
    if (!slot || typeof util !== "number" || !Number.isFinite(util)) return false;
    const resets = info.resetsAt ?? info.resets_at;
    const resetsAt = typeof resets === "number" ? (resets < 1e12 ? resets * 1000 : resets) : null;
    const pct = Math.max(0, Math.min(100, util <= 1 ? util * 100 : util));
    this.#usage = { ...this.#usage, [slot]: { pct, resetsAt } };
    return true;
  }
}
