import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  EFFORTS,
  MODELS,
  type ChatMessage,
  type Effort,
  type Model,
  type WorkerMeta,
  type WorkerStatus,
  type WorkerView,
} from "../shared/types.ts";
import { HttpError } from "./http-error.ts";
import { log } from "./log.ts";

const PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"] as const;
const MAX_MESSAGES = 200;
const MAX_TEXT_CHARS = 20_000;
const STDERR_TAIL_CHARS = 2_000;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WorkerSettings {
  claudeBin: string;
  permissionMode: (typeof PERMISSION_MODES)[number];
  maxWorkers: number;
  workspaceRoots: string[];
}

export function loadWorkerSettings(env: NodeJS.ProcessEnv): WorkerSettings {
  const mode = env.WORKER_PERMISSION_MODE ?? "acceptEdits";
  if (!(PERMISSION_MODES as readonly string[]).includes(mode)) {
    throw new Error(`WORKER_PERMISSION_MODE must be one of ${PERMISSION_MODES.join(", ")}`);
  }
  const maxWorkers = Number(env.MAX_WORKERS ?? 4);
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 8) {
    throw new Error("MAX_WORKERS must be an integer between 1 and 8");
  }
  const roots = (env.WORKSPACE_ROOTS ?? os.homedir())
    .split(path.delimiter)
    .map((r) => r.trim())
    .filter((r) => r.length > 0 && existsSync(r))
    .map((r) => realpathSync(r));
  if (roots.length === 0) throw new Error("WORKSPACE_ROOTS has no existing folder");
  return {
    claudeBin: env.CLAUDE_BIN ?? defaultClaudeBin(),
    permissionMode: mode as WorkerSettings["permissionMode"],
    maxWorkers,
    workspaceRoots: roots,
  };
}

/** Native installer location first, then PATH. Windows needs the real .exe (spawned without a shell), so npm's install is probed too. */
function defaultClaudeBin(): string {
  if (process.platform !== "win32") {
    const native = path.join(os.homedir(), ".local", "bin", "claude");
    return existsSync(native) ? native : "claude";
  }
  const candidates = [
    path.join(os.homedir(), ".local", "bin", "claude.exe"),
    process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe") : "",
  ];
  return candidates.find((c) => c && existsSync(c)) ?? "claude.exe";
}

/** "claude-opus-5-5[1m]" → "Opus 5.5"; "sonnet" → "Sonnet". */
export function prettyModel(id: string): string {
  const m = /(opus|sonnet|haiku|fable)-(\d+)-(\d+)/i.exec(id);
  const name = m?.[1] ?? id.replace(/^claude-/, "").split(/[-[]/)[0] ?? id;
  const cap = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
  return m ? `${cap} ${m[2]}.${m[3]}` : cap;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One-line activity label for a tool call, e.g. "Bash: Check warnings and typecheck web". */
export function describeTool(name: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  const detail =
    str("description") ||
    (str("file_path") && path.basename(str("file_path"))) ||
    str("pattern") ||
    str("command") ||
    str("url") ||
    str("query") ||
    str("prompt");
  return clip(detail ? `${name}: ${detail}` : name, 120);
}

interface Internal {
  view: WorkerView;
  proc: ChildProcessWithoutNullStreams | null;
  modelAlias: Model;
  forkFrom: string | null;
  stderrTail: string;
}

export interface CreateInput {
  task?: unknown;
  cwd?: unknown;
  model?: unknown;
  effort?: unknown;
  resumeSessionId?: unknown;
  title?: unknown;
}

type StreamEvent = Record<string, unknown> & { type?: string; subtype?: string };
type Block = { type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string };

export class WorkerManager extends EventEmitter {
  readonly #workers = new Map<string, Internal>();
  readonly #settings: WorkerSettings;

  constructor(settings: WorkerSettings) {
    super();
    this.#settings = settings;
  }

  list(): WorkerView[] {
    return [...this.#workers.values()].map((w) => w.view);
  }

  create(input: CreateInput): WorkerView {
    const cwd = this.#validateCwd(input.cwd);
    const model = pick(input.model, MODELS, "opus" satisfies Model);
    const effort = pick(input.effort, EFFORTS, "high" satisfies Effort);
    const resume = input.resumeSessionId === undefined ? null : validateSessionId(input.resumeSessionId);
    const task = input.task === undefined && resume ? null : validateText(input.task, "task");
    const title = typeof input.title === "string" && input.title.trim() ? clip(input.title.replace(CONTROL_CHARS, " "), 90) : clip(task ?? "Resumed session", 90);
    if (task) this.#assertCapacity();

    const now = Date.now();
    const w: Internal = {
      view: {
        id: randomUUID(),
        sessionId: null,
        cwd,
        location: `${path.basename(path.dirname(cwd))} / ${path.basename(cwd)}`,
        title,
        status: "idle",
        model: prettyModel(model),
        effort,
        activity: null,
        subagents: [],
        messages: [],
        startedAt: now,
        updatedAt: now,
      },
      proc: null,
      modelAlias: model,
      forkFrom: resume,
      stderrTail: "",
    };
    this.#workers.set(w.view.id, w);
    try {
      if (resume) this.#push(w, "system", `Resumed "${title}" as a fork — say what to do next.`);
      if (task) this.#sendTo(w, task);
      else this.#emit(w);
    } catch (err) {
      this.#workers.delete(w.view.id);
      this.emit("removed", w.view.id);
      log("error", "worker start failed", { err: (err as Error).message });
      throw new HttpError(500, `Could not start claude: ${(err as Error).message}`);
    }
    return w.view;
  }

  send(id: string, text: unknown): void {
    const w = this.#get(id);
    if (w.view.status === "cooking" || w.view.status === "starting") {
      throw new HttpError(409, "Worker is still cooking — wait for it or stop it");
    }
    const clean = validateText(text, "text");
    this.#assertCapacity();
    this.#sendTo(w, clean);
  }

  /** Live processes = busy workers: a worker's process ends after each turn and is resumed on the next ask. */
  #assertCapacity(): void {
    if ([...this.#workers.values()].filter((x) => x.proc).length >= this.#settings.maxWorkers) {
      throw new HttpError(429, `Max ${this.#settings.maxWorkers} workers cooking at once — wait for one or stop it`);
    }
  }

  stop(id: string): void {
    const w = this.#get(id);
    this.#kill(w);
    this.#set(w, { status: "stopped", activity: null, subagents: [] });
    this.#push(w, "system", "Stopped.");
  }

  remove(id: string): void {
    const w = this.#get(id);
    this.#kill(w);
    this.#workers.delete(id);
    this.emit("removed", id);
  }

  shutdown(): void {
    for (const w of this.#workers.values()) this.#kill(w);
  }

  #sendTo(w: Internal, text: string): void {
    if (!w.proc) this.#spawn(w);
    this.#push(w, "user", text);
    this.#set(w, { status: w.view.sessionId ? "cooking" : "starting", activity: null });
    const line = JSON.stringify({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: w.view.sessionId ?? "" });
    w.proc?.stdin.write(`${line}\n`);
  }

  #spawn(w: Internal): void {
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", this.#settings.permissionMode,
      "--effort", w.view.effort,
      "--model", w.modelAlias,
    ];
    if (w.view.sessionId) args.push("--resume", w.view.sessionId);
    else if (w.forkFrom) args.push("--resume", w.forkFrom, "--fork-session");
    else args.push("--name", `Claudia: ${w.view.title}`.slice(0, 80));

    const proc = spawn(this.#settings.claudeBin, args, { cwd: w.view.cwd, windowsHide: true, env: process.env, detached: process.platform !== "win32" });
    w.proc = proc;
    w.stderrTail = "";
    log("info", "worker spawned", { id: w.view.id, pid: proc.pid, cwd: w.view.cwd });

    proc.stdin.on("error", (err) => log("warn", "worker stdin error", { id: w.view.id, err: err.message }));
    proc.stderr.on("data", (chunk: Buffer) => {
      w.stderrTail = (w.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
    });
    createInterface({ input: proc.stdout }).on("line", (line) => {
      // Lines from a process we already stopped or finished must not resurrect the worker.
      if (w.proc !== proc || !line.trim()) return;
      try {
        this.#handle(w, JSON.parse(line) as StreamEvent);
      } catch (err) {
        log("warn", "unparseable worker line", { id: w.view.id, err: (err as Error).message, line: line.slice(0, 200) });
      }
    });
    proc.on("error", (err) => {
      if (w.proc !== proc) return;
      log("error", "worker spawn failed", { id: w.view.id, err: err.message });
      w.proc = null;
      this.#set(w, { status: "error", activity: null });
      this.#push(w, "system", `Could not start claude (${err.message}). Set CLAUDE_BIN in .env.`);
    });
    proc.on("exit", (code) => {
      if (w.proc !== proc) return;
      w.proc = null;
      if (w.view.status === "cooking" || w.view.status === "starting") {
        const tail = clip(w.stderrTail, 400);
        this.#set(w, { status: "error", activity: null, subagents: [] });
        this.#push(w, "system", `Worker exited (code ${code ?? "?"})${tail ? `: ${tail}` : ""}`);
      }
      log("info", "worker exited", { id: w.view.id, code });
    });
  }

  #handle(w: Internal, ev: StreamEvent): void {
    switch (ev.type) {
      case "system":
        if (ev.subtype === "init") {
          this.#set(w, {
            sessionId: typeof ev.session_id === "string" ? ev.session_id : w.view.sessionId,
            model: typeof ev.model === "string" ? prettyModel(ev.model) : w.view.model,
            status: "cooking",
          });
          w.forkFrom = null;
        }
        return;
      case "rate_limit_event":
        this.emit("rate-limit", ev);
        return;
      case "assistant":
        this.#onAssistant(w, ev);
        return;
      case "user":
        this.#onToolResults(w, ev);
        return;
      case "result":
        this.#onResult(w, ev);
        return;
      default:
        return;
    }
  }

  #onAssistant(w: Internal, ev: StreamEvent): void {
    const msg = ev.message as { content?: Block[] } | undefined;
    const isSubagent = typeof ev.parent_tool_use_id === "string";
    for (const block of msg?.content ?? []) {
      if (block.type === "text" && block.text?.trim() && !isSubagent) {
        this.#push(w, "assistant", block.text.trim());
      } else if (block.type === "tool_use" && block.name) {
        const input = block.input ?? {};
        const activity = describeTool(block.name, input);
        if (!isSubagent && (block.name === "Task" || block.name === "Agent") && block.id) {
          const model = typeof input.model === "string" ? prettyModel(input.model) : w.view.model;
          const kind = typeof input.subagent_type === "string" ? input.subagent_type : "agent";
          const desc = typeof input.description === "string" ? input.description : "subtask";
          this.#set(w, { activity, subagents: [...w.view.subagents, { id: block.id, model, label: clip(`${kind} · ${desc}`, 70) }] });
        } else {
          this.#set(w, { activity });
        }
      }
    }
  }

  #onToolResults(w: Internal, ev: StreamEvent): void {
    const msg = ev.message as { content?: Block[] | string } | undefined;
    if (!Array.isArray(msg?.content)) return;
    const done = new Set(msg.content.filter((b) => b.type === "tool_result" && b.tool_use_id).map((b) => b.tool_use_id));
    if (done.size && w.view.subagents.some((s) => done.has(s.id))) {
      this.#set(w, { subagents: w.view.subagents.filter((s) => !done.has(s.id)) });
    }
  }

  #onResult(w: Internal, ev: StreamEvent): void {
    const denials = Array.isArray(ev.permission_denials) ? (ev.permission_denials as { tool_name?: string }[]) : [];
    const isError = ev.is_error === true;
    let status: WorkerStatus = "idle";
    if (isError) {
      status = "error";
      const reason = clip(typeof ev.result === "string" ? ev.result : `Turn failed (${ev.subtype ?? "error"})`, 400);
      // The CLI often already printed the same text as an assistant message.
      if (w.view.messages.at(-1)?.text !== reason) this.#push(w, "system", reason);
      if (/authenticat|log ?in/i.test(reason)) this.#push(w, "system", "Claude Code is not logged in: run `claude` in a terminal, type /login, then send again.");
    } else if (denials.length) {
      status = "needs-you";
      const tools = [...new Set(denials.map((d) => d.tool_name ?? "tool"))].join(", ");
      this.#push(w, "system", `Needs you: permission denied for ${tools}. Allow it in your Claude settings or change WORKER_PERMISSION_MODE.`);
    }
    // Free the process (and its RAM / worker slot) between turns; the next ask resumes the session.
    const proc = w.proc;
    w.proc = null;
    proc?.stdin.end();
    this.#set(w, { status, activity: null, subagents: [] });
  }

  #validateCwd(raw: unknown): string {
    if (typeof raw !== "string" || !raw.trim() || !path.isAbsolute(raw.trim())) {
      throw new HttpError(400, "cwd must be an absolute folder path");
    }
    let real: string;
    try {
      real = realpathSync(raw.trim());
    } catch {
      throw new HttpError(400, "cwd does not exist");
    }
    if (!statSync(real).isDirectory()) throw new HttpError(400, "cwd is not a folder");
    const inside = this.#settings.workspaceRoots.some((root) => {
      const rel = path.relative(root, real);
      return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
    });
    if (!inside) throw new HttpError(403, "cwd is outside WORKSPACE_ROOTS");
    return real;
  }

  #get(id: string): Internal {
    const w = this.#workers.get(id);
    if (!w) throw new HttpError(404, "Worker not found");
    return w;
  }

  #kill(w: Internal): void {
    const proc = w.proc;
    if (!proc?.pid) return;
    w.proc = null;
    if (process.platform === "win32") {
      execFile("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true }, (err) => {
        if (err) log("warn", "taskkill failed", { id: w.view.id, err: err.message });
      });
    } else {
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        proc.kill("SIGTERM");
      }
    }
  }

  #push(w: Internal, role: ChatMessage["role"], text: string): void {
    const message: ChatMessage = { id: randomUUID(), role, text, at: Date.now() };
    w.view = { ...w.view, messages: [...w.view.messages, message].slice(-MAX_MESSAGES), updatedAt: message.at };
    if (this.#workers.has(w.view.id)) this.emit("message", w.view.id, message);
  }

  #set(w: Internal, patch: Partial<WorkerMeta>): void {
    w.view = { ...w.view, ...patch, updatedAt: Date.now() };
    this.#emit(w);
  }

  /** Broadcasts metadata only; messages travel as separate "message" events. */
  #emit(w: Internal): void {
    if (!this.#workers.has(w.view.id)) return;
    const { messages: _messages, ...meta } = w.view;
    this.emit("worker", meta);
  }
}

function pick<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  if (raw === undefined) return fallback;
  if (typeof raw === "string" && (allowed as readonly string[]).includes(raw)) return raw as T;
  throw new HttpError(400, `Must be one of ${allowed.join(", ")}`);
}

function validateText(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !raw.trim()) throw new HttpError(400, `${field} is required`);
  if (raw.length > MAX_TEXT_CHARS) throw new HttpError(400, `${field} is longer than ${MAX_TEXT_CHARS} characters`);
  if (CONTROL_CHARS.test(raw)) throw new HttpError(400, `${field} contains control characters`);
  return raw.trim();
}

function validateSessionId(raw: unknown): string {
  if (typeof raw !== "string" || !UUID.test(raw)) throw new HttpError(400, "resumeSessionId must be a session UUID");
  return raw;
}
