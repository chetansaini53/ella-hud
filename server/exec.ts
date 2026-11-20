import { execFile, spawn, type ChildProcess } from "node:child_process";
import { log } from "./log.ts";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const MAX_OUTPUT = 4 * 1024 * 1024;

/** Runs a binary without a shell; never rejects — the caller reads code/stderr. */
export function run(bin: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 30_000, maxBuffer: MAX_OUTPUT, windowsHide: true, encoding: "utf8" },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        if (e && typeof e.code === "string") {
          resolve({ code: null, stdout: "", stderr: `${bin}: ${e.message}`, timedOut: false });
          return;
        }
        resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr, timedOut: Boolean(e?.killed) });
      },
    );
  });
}

/** Kills a process and everything it started (Windows: taskkill /T; POSIX: the process group). */
export function killTree(proc: ChildProcess | number): void {
  const pid = typeof proc === "number" ? proc : proc.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, (err) => {
      if (err) log("warn", "taskkill failed", { pid, err: err.message });
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch (err) {
      log("warn", "kill failed", { pid, err: (err as Error).message });
    }
  }
}

/** Spawns a package-manager command. Windows shims (npm.cmd, pnpm.cmd) need cmd.exe, so callers must pass validated args only. */
export function spawnTool(bin: string, args: string[], cwd: string): ChildProcess {
  const win = process.platform === "win32";
  // NoDefaultCurrentDirectoryInExePath: cmd.exe would otherwise prefer an npm.bat/pnpm.cmd planted in the project folder.
  return win
    ? spawn("cmd.exe", ["/d", "/s", "/c", bin, ...args], { cwd, windowsHide: true, env: { ...process.env, FORCE_COLOR: "0", NoDefaultCurrentDirectoryInExePath: "1" } })
    : spawn(bin, args, { cwd, detached: true, env: { ...process.env, FORCE_COLOR: "0" } });
}
