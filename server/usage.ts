import type { Usage, UsageWindow } from "../shared/types.ts";

/**
 * Plan usage from the `rate_limit_event` lines a headless worker prints (Agent SDK `SDKRateLimitEvent`).
 * Fields arrive camelCase from the CLI; snake_case is accepted too. utilization is a 0–1 fraction.
 */
export class UsageTracker {
  #usage: Usage = { session: null, week: null };

  get(): Usage {
    const now = Date.now();
    const live = (w: UsageWindow | null) => (w?.resetsAt && w.resetsAt < now ? null : w);
    this.#usage = { session: live(this.#usage.session), week: live(this.#usage.week) };
    return this.#usage;
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
