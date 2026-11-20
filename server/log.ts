type Level = "info" | "warn" | "error";

/** Structured one-line JSON logs on stderr (stdout stays free for tooling). */
export function log(level: Level, msg: string, extra: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra })}\n`);
}
