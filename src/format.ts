const MIN = 60_000;
const DAY = 86_400_000;

export const hhmm = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

export function ago(t: number, now: number): string {
  const d = now - t;
  if (d < MIN) return "just now";
  if (d < 60 * MIN) return `${Math.floor(d / MIN)} min ago`;
  return hhmm(t);
}

/** "resets in 1 h 22 min, 11:49" for < 1 day away, else "resets Tue 24 Nov 11:59". */
export function resetsText(at: number | null, now: number): string {
  if (!at) return "reset time unknown";
  const d = at - now;
  if (d <= 0) return "resetting";
  if (d < DAY) {
    const h = Math.floor(d / (60 * MIN));
    const m = Math.floor((d % (60 * MIN)) / MIN);
    return `resets in ${h ? `${h} h ` : ""}${m} min, ${hhmm(at)}`;
  }
  const day = new Date(at).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  return `resets ${day} ${hhmm(at)}`;
}

export function dayGroup(t: number, now: number): string {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (t >= start.getTime()) return "Today";
  if (t >= start.getTime() - DAY) return "Yesterday";
  return new Date(t).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" });
}

export const longDate = (t: number) => new Date(t).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" });

/** "1 h 22 min 05 s" countdown to `at`; empty string once it has passed. */
export function countdown(at: number, now: number): string {
  const d = Math.max(0, at - now);
  const days = Math.floor(d / DAY);
  const h = Math.floor((d % DAY) / (60 * MIN));
  const m = Math.floor((d % (60 * MIN)) / MIN);
  const sec = Math.floor((d % MIN) / 1000);
  if (days) return `${days} d ${h} h ${m} min`;
  return `${h ? `${h} h ` : ""}${m} min${h ? "" : ` ${String(sec).padStart(2, "0")} s`}`;
}

/** "Fri 20 Nov, 17:50" */
export const resetStamp = (at: number) =>
  `${new Date(at).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}, ${hhmm(at)}`;
