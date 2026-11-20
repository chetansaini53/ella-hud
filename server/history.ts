import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EvolutionItem, HistoryItem } from "../shared/types.ts";
import { log } from "./log.ts";

/** Same lookup Claude Code uses: $CLAUDE_CONFIG_DIR, else ~/.claude. */
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
export const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");
const HISTORY_LIMIT = 80;
const EVOLUTION_LIMIT = 60;
const SCAN_CONCURRENCY = 4;
const NEWLINE = 0x0a;
/** Prompts the harness injects as "user" turns — not real asks. */
const SYSTEM_PREFIXES = ["<command-", "<local-command", "<system-reminder", "<task-notification", "<side-sessions-event", "<ci-monitor-event", "Caveat:"];

export interface FileRef {
  file: string;
  mtimeMs: number;
  size: number;
}

/** Per-transcript scan state. Transcripts are append-only JSONL, so each poll only reads the new bytes. */
interface ScanState {
  offset: number;
  customTitle: string;
  firstAsk: string;
  cwd: string;
  asks: number;
}

const states = new Map<string, ScanState>();
let inflight: Promise<HistoryItem[]> | null = null;

/** Recent Claude Code sessions, newest first. Concurrent callers share one scan. */
export function listHistory(): Promise<HistoryItem[]> {
  inflight ??= scanHistory().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function scanHistory(): Promise<HistoryItem[]> {
  const files = (await listFiles((dir) => readdirSafe(dir), ".jsonl")).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, HISTORY_LIMIT);
  const items: (HistoryItem | null)[] = new Array(files.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      const ref = files[i];
      if (!ref) continue;
      try {
        items[i] = await scanSession(ref);
      } catch (err) {
        log("warn", "session scan failed", { file: ref.file, err: (err as Error).message });
      }
    }
  };
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
  return items.filter((x): x is HistoryItem => x !== null);
}

export async function scanSession(ref: FileRef): Promise<HistoryItem | null> {
  let st = states.get(ref.file);
  if (!st || ref.size < st.offset) st = { offset: 0, customTitle: "", firstAsk: "", cwd: "", asks: 0 };
  if (ref.size > st.offset) st = await readFrom(ref.file, st);
  states.set(ref.file, st);
  if (st.asks === 0) return null;
  return {
    id: path.basename(ref.file, ".jsonl"),
    title: clean(st.customTitle || st.firstAsk),
    project: projectName(st.cwd) || prettyProjectDir(path.basename(path.dirname(ref.file))),
    cwd: st.cwd,
    at: ref.mtimeMs,
    asks: st.asks,
  };
}

/** Reads complete lines from `offset`; a trailing half-written line is left for the next poll. */
async function readFrom(file: string, start: ScanState): Promise<ScanState> {
  const st = { ...start };
  let pending: Buffer[] = [];
  for await (const chunk of createReadStream(file, { start: st.offset }) as AsyncIterable<Buffer>) {
    let from = 0;
    let nl = chunk.indexOf(NEWLINE);
    while (nl !== -1) {
      const line = pending.length ? Buffer.concat([...pending, chunk.subarray(from, nl)]) : chunk.subarray(from, nl);
      pending = [];
      consume(st, line);
      st.offset += line.length + 1;
      from = nl + 1;
      nl = chunk.indexOf(NEWLINE, from);
    }
    if (from < chunk.length) pending.push(chunk.subarray(from));
  }
  return st;
}

function consume(st: ScanState, line: Buffer): void {
  if (line.includes('"type":"custom-title"')) {
    const t = parse<{ customTitle?: string }>(line)?.customTitle;
    if (t) st.customTitle = t;
    return;
  }
  // Cheap byte filters first: most lines are assistant turns or tool results.
  if (!line.includes('"type":"user"') || line.includes('"type":"tool_result"')) return;
  const d = parse<{ type?: string; isMeta?: boolean; isSidechain?: boolean; cwd?: string; message?: { content?: unknown } }>(line);
  if (!d || d.type !== "user" || d.isMeta || d.isSidechain) return;
  const text = askText(d.message?.content);
  if (!text || SYSTEM_PREFIXES.some((p) => text.startsWith(p))) return;
  st.asks++;
  if (!st.firstAsk) st.firstAsk = text.slice(0, 500);
  if (!st.cwd && d.cwd) st.cwd = d.cwd;
}

export async function listEvolution(): Promise<EvolutionItem[]> {
  const files = await listFiles((dir) => readdirSafe(path.join(dir, "memory")).then((names) => names.map((n) => path.join("memory", n))), ".md");
  const recent = files.filter((f) => path.basename(f.file) !== "MEMORY.md").sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, EVOLUTION_LIMIT);
  const items = await Promise.all(
    recent.map(async (ref): Promise<EvolutionItem | null> => {
      try {
        const head = await readHead(ref.file, 1200);
        const field = (k: string) => new RegExp(`^${k}:\\s*["']?(.+?)["']?\\s*$`, "m").exec(head)?.[1] ?? "";
        return {
          id: ref.file,
          title: field("name") || path.basename(ref.file, ".md"),
          detail: field("description"),
          project: prettyProjectDir(path.basename(path.dirname(path.dirname(ref.file)))),
          at: ref.mtimeMs,
        };
      } catch {
        return null;
      }
    }),
  );
  return items.filter((x): x is EvolutionItem => x !== null);
}

async function listFiles(entries: (projectDir: string) => Promise<string[]>, ext: string): Promise<FileRef[]> {
  const projects = await readdirSafe(PROJECTS_DIR);
  const nested = await Promise.all(
    projects.map(async (p) => {
      const dir = path.join(PROJECTS_DIR, p);
      const names = (await entries(dir)).filter((n) => n.endsWith(ext));
      const refs = await Promise.all(
        names.map(async (n) => {
          const file = path.join(dir, n);
          try {
            const s = await stat(file);
            return s.isFile() ? { file, mtimeMs: s.mtimeMs, size: s.size } : null;
          } catch {
            return null;
          }
        }),
      );
      return refs.filter((r): r is FileRef => r !== null);
    }),
  );
  return nested.flat();
}

function askText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const block = content.find((b: { type?: string; text?: string }) => b?.type === "text" && typeof b.text === "string");
  return (block?.text ?? "").trim();
}

function clean(text: string): string {
  const flat = text.replace(/<\/?pasted_content[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
}

/** "D:\Projects\shop\dev" or "/home/me/shop/dev" → "shop" (generic leaf folders fall back to their parent). */
export function projectName(cwd: string): string {
  if (!cwd) return "";
  const base = path.win32.basename(cwd);
  return ["dev", "app", "src", "main", "web"].includes(base.toLowerCase()) ? path.win32.basename(path.win32.dirname(cwd)) : base;
}

/** Claude Code's encoded project folder ("D--Projects-shop", "-home-me-shop") → readable-ish name. */
export function prettyProjectDir(dir: string): string {
  return dir.replace(/^[A-Za-z]--/, "").replace(/^-?(Users|home)-[^-]+-?/, "").replace(/^Projects-/, "") || "home";
}

function parse<T>(line: Buffer): T | null {
  try {
    return JSON.parse(line.toString("utf8")) as T;
  } catch {
    return null;
  }
}

export async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function readHead(file: string, bytes: number): Promise<string> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}
