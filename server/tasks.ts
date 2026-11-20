import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { ClaudeSessionProc, ExternalProc, ProjectItem, TaskPreset, TaskView } from "../shared/types.ts";
import { killTree, run, spawnTool } from "./exec.ts";
import { HttpError } from "./http-error.ts";
import { log } from "./log.ts";

const MAX_LINES = 500;
const MAX_RUNNING = 10;
const MAX_KEPT = 30;
/** No leading "-" (would become an npm/pnpm option) and no cmd.exe metacharacters. */
const SCRIPT_NAME = /^[\w@][\w:.@/-]{0,79}$/;
const PLAYWRIGHT_CONFIGS = ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs", "playwright.config.cjs"];
const PLAYWRIGHT_PRESETS: Record<string, { label: string; args: string[] }> = {
  "pw:test": { label: "Playwright · run tests", args: ["playwright", "test"] },
  "pw:ui": { label: "Playwright · UI mode", args: ["playwright", "test", "--ui"] },
  "pw:report": { label: "Playwright · show report", args: ["playwright", "show-report"] },
};

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Package manager from the lockfile, plus how it runs a local binary. */
async function packageManager(dir: string): Promise<{ bin: string; exec: string[] }> {
  if (await exists(path.join(dir, "pnpm-lock.yaml"))) return { bin: "pnpm", exec: ["exec"] };
  if (await exists(path.join(dir, "yarn.lock"))) return { bin: "yarn", exec: [] };
  if ((await exists(path.join(dir, "bun.lockb"))) || (await exists(path.join(dir, "bun.lock")))) return { bin: "bunx", exec: [] };
  return { bin: "npx", exec: [] };
}

async function scripts(dir: string): Promise<string[]> {
  try {
    const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    return Object.keys(pkg.scripts ?? {}).filter((s) => SCRIPT_NAME.test(s));
  } catch {
    return [];
  }
}

export async function taskPresets(project: ProjectItem): Promise<TaskPreset[]> {
  const list: TaskPreset[] = (await scripts(project.path)).map((s) => ({ id: `script:${s}`, label: s, group: "script" }));
  const hasPlaywright = (await Promise.all(PLAYWRIGHT_CONFIGS.map((f) => exists(path.join(project.path, f))))).some(Boolean);
  if (hasPlaywright) for (const [id, p] of Object.entries(PLAYWRIGHT_PRESETS)) list.push({ id, label: p.label, group: "playwright" });
  return list;
}

interface Internal {
  view: TaskView;
  proc: ChildProcess | null;
  pending: string[];
  flush: NodeJS.Timeout | null;
}

export class TaskManager extends EventEmitter {
  readonly #tasks = new Map<string, Internal>();

  list(): TaskView[] {
    return [...this.#tasks.values()].map((t) => t.view);
  }

  async start(project: ProjectItem, presetId: unknown): Promise<TaskView> {
    if (typeof presetId !== "string") throw new HttpError(400, "preset is required");
    const preset = (await taskPresets(project)).find((p) => p.id === presetId);
    if (!preset) throw new HttpError(404, "Unknown task for this project");
    const pm = await packageManager(project.path);
    // No await between these checks and registering the task, so two quick clicks can't both pass.
    const live = [...this.#tasks.values()].filter((t) => t.view.status === "running");
    if (live.some((t) => t.view.projectPath === project.path && t.view.label === preset.label)) throw new HttpError(409, `${preset.label} is already running`);
    if (live.length >= MAX_RUNNING) throw new HttpError(429, `Max ${MAX_RUNNING} tasks at once`);
    const runner = pm.bin === "npx" ? "npm" : pm.bin === "bunx" ? "bun" : pm.bin;
    const [bin, args] =
      preset.group === "script" ? [runner, ["run", preset.id.slice("script:".length)]] : [pm.bin, [...pm.exec, ...(PLAYWRIGHT_PRESETS[preset.id]?.args ?? [])]];

    const now = Date.now();
    const t: Internal = {
      view: { id: randomUUID(), projectPath: project.path, label: preset.label, command: `${bin} ${args.join(" ")}`, status: "running", exitCode: null, startedAt: now, endedAt: null, lines: [] },
      proc: null,
      pending: [],
      flush: null,
    };
    this.#tasks.set(t.view.id, t);
    this.#evict();
    let proc: ChildProcess;
    try {
      proc = spawnTool(bin, args, project.path);
    } catch (err) {
      this.#tasks.delete(t.view.id);
      throw new HttpError(500, `Could not start ${bin}: ${(err as Error).message}`);
    }
    t.proc = proc;
    log("info", "task started", { id: t.view.id, cmd: t.view.command, cwd: project.path });
    const onLine = (line: string) => this.#line(t, line);
    if (proc.stdout) createInterface({ input: proc.stdout }).on("line", onLine);
    if (proc.stderr) createInterface({ input: proc.stderr }).on("line", onLine);
    proc.on("error", (err) => {
      this.#line(t, `[ella] ${err.message}`);
      this.#finish(t, proc, "failed", null);
    });
    proc.on("exit", (code) => this.#finish(t, proc, code === 0 ? "exited" : "failed", code));
    this.#emitMeta(t);
    return t.view;
  }

  stop(id: string): void {
    const t = this.#tasks.get(id);
    if (!t) throw new HttpError(404, "Task not found");
    const proc = t.proc;
    if (!proc) return;
    t.proc = null;
    killTree(proc);
    t.view = { ...t.view, status: "stopped", endedAt: Date.now() };
    this.#emitMeta(t);
  }

  remove(id: string): void {
    const t = this.#tasks.get(id);
    if (!t) throw new HttpError(404, "Task not found");
    if (t.proc) throw new HttpError(409, "Stop the task first");
    this.#tasks.delete(id);
    this.emit("removed", id);
  }

  shutdown(): void {
    for (const t of this.#tasks.values()) if (t.proc) killTree(t.proc);
  }

  /** Keeps the newest MAX_KEPT tasks; only finished ones are dropped. */
  #evict(): void {
    const finished = [...this.#tasks.values()].filter((t) => !t.proc && t.view.status !== "running").sort((a, b) => a.view.startedAt - b.view.startedAt);
    while (this.#tasks.size > MAX_KEPT && finished.length) {
      const old = finished.shift();
      if (!old) break;
      this.#tasks.delete(old.view.id);
      this.emit("removed", old.view.id);
    }
  }

  #line(t: Internal, line: string): void {
    // Strip ANSI colour/cursor sequences (CSI) so logs read cleanly.
    const clean = line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
    t.view.lines.push(clean);
    if (t.view.lines.length > MAX_LINES) t.view.lines.splice(0, t.view.lines.length - MAX_LINES);
    t.pending.push(clean);
    t.flush ??= setTimeout(() => {
      t.flush = null;
      const lines = t.pending.splice(0);
      if (lines.length && this.#tasks.has(t.view.id)) this.emit("log", t.view.id, lines);
    }, 150);
  }

  #finish(t: Internal, proc: ChildProcess, status: TaskView["status"], code: number | null): void {
    if (t.proc !== proc) return;
    t.proc = null;
    t.view = { ...t.view, status, exitCode: code, endedAt: Date.now() };
    this.#emitMeta(t);
  }

  #emitMeta(t: Internal): void {
    if (!this.#tasks.has(t.view.id)) return;
    const { lines: _lines, ...meta } = t.view;
    this.emit("task", meta);
  }
}

/** Live Claude Code sessions (interactive and background) from the official CLI. */
export async function claudeSessions(claudeBin: string): Promise<ClaudeSessionProc[]> {
  const r = await run(claudeBin, ["agents", "--json"], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new HttpError(502, (r.stderr || "claude agents failed").trim().slice(0, 300));
  try {
    const list = JSON.parse(r.stdout) as Partial<ClaudeSessionProc>[];
    return list.map((s) => ({
      pid: Number(s.pid ?? 0),
      cwd: String(s.cwd ?? ""),
      kind: String(s.kind ?? ""),
      sessionId: String(s.sessionId ?? ""),
      name: String(s.name ?? ""),
      status: String(s.status ?? ""),
      startedAt: Number(s.startedAt ?? 0),
    }));
  } catch {
    throw new HttpError(502, "Unexpected output from claude agents");
  }
}

const PLAYWRIGHT_PROC = /playwright|ms-playwright|chrome-devtools-mcp|chrome-for-testing/i;

async function allProcesses(): Promise<{ pid: number; name: string; commandLine: string }[]> {
  if (process.platform === "win32") {
    const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"], { timeoutMs: 30_000 });
    if (r.code !== 0) throw new HttpError(502, "Could not list processes");
    const parsed = JSON.parse(r.stdout || "[]") as { ProcessId: number; Name: string; CommandLine: string | null }[];
    return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({ pid: p.ProcessId, name: p.Name, commandLine: p.CommandLine ?? "" }));
  }
  const r = await run("ps", ["-eo", "pid=,comm=,args="], { timeoutMs: 15_000 });
  return r.stdout
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), name: m[2] ?? "", commandLine: m[3] ?? "" }));
}

/** Processes whose command line mentions the project folder, or Playwright-related processes when no project is given. */
const normPath = (s: string) => s.toLowerCase().replace(/\\/g, "/");

/** True when the command line names this folder itself (or something inside it) — not a sibling like app-two. */
export function mentionsFolder(commandLine: string, folder: string): boolean {
  const hay = normPath(commandLine);
  const needle = normPath(folder).replace(/\/+$/, "");
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    const next = hay[i + needle.length];
    if (next === undefined || next === "/" || next === '"' || next === "'" || next === " ") return true;
  }
  return false;
}

export async function externalProcesses(projectPath: string | null): Promise<ExternalProc[]> {
  return (await allProcesses())
    // Never list Ella itself (or the shell that launched it) as something to kill.
    .filter((p) => p.pid !== process.pid && p.pid !== process.ppid && p.commandLine && (projectPath ? mentionsFolder(p.commandLine, projectPath) : PLAYWRIGHT_PROC.test(p.commandLine)))
    .map((p) => ({ pid: p.pid, name: p.name, commandLine: p.commandLine.slice(0, 400), playwright: PLAYWRIGHT_PROC.test(p.commandLine) }));
}

/** Only kills a pid that is still in the same filtered list the user was shown. */
export async function stopExternal(projectPath: string | null, pid: unknown): Promise<void> {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) throw new HttpError(400, "Invalid pid");
  if (!(await externalProcesses(projectPath)).some((p) => p.pid === pid)) throw new HttpError(404, "That process is no longer in this list");
  killTree(pid);
}
