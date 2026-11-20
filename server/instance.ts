import { existsSync, realpathSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ClaudeBinary, ClaudeProfile, InstanceInfo } from "../shared/types.ts";
import { run } from "./exec.ts";
import { HttpError } from "./http-error.ts";
import { log } from "./log.ts";

/**
 * Which Claude Code this HUD instance drives: a CLI binary + a config folder (= account/profile) + the assistant's name.
 * Saved per port, so two instances on two ports can drive two different Claudes from the same checkout.
 */
interface Saved {
  bin: string;
  configDir: string;
  name: string;
}

const HOME = os.homedir();
const WIN = process.platform === "win32";
const DEFAULT_DIR = path.join(HOME, ".claude");
const DATA_DIR = path.join(import.meta.dirname, "..", "data");
const NAME = /^[\p{L}\p{N} ._-]{1,24}$/u;
/** Only these exact names are ever executed; other claude-* files are read as wrapper scripts, never run. */
const CLI_NAMES = WIN ? ["claude.exe"] : ["claude"];
const WRAPPER_NAME = /^claude[\w.-]*$/i;
/** Desktop-app folders also contain a claude.exe — running it would open the GUI. */
const DESKTOP_DIR = /WindowsApps|AnthropicClaude|[\\/]Programs[\\/]Claude([\\/]|$)|Claude\.app/i;
const DETECT_TTL = 30_000;

let current: Saved = { bin: "", configDir: process.env.CLAUDE_CONFIG_DIR ?? DEFAULT_DIR, name: "Ella" };
let saved = false;
let settingsFile = "";
let envBin: string | undefined;

/** Same file? realpath when it exists, trailing separators ignored, case-insensitive on Windows. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    let r = path.resolve(p);
    try {
      r = realpathSync(r);
    } catch {
      // keep the resolved path for files that don't exist yet
    }
    r = r.replace(/[\\/]+$/, "");
    return WIN ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

const isDefaultDir = (dir: string) => samePath(dir, DEFAULT_DIR);

export const claudeBin = () => current.bin;
export const defaultClaudeDir = () => DEFAULT_DIR;
export const isDefaultClaudeDir = isDefaultDir;
export const assistantName = () => current.name;
/** Claude Code's own rule: $CLAUDE_CONFIG_DIR, else ~/.claude. Read lazily so a profile switch applies everywhere. */
export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR ?? DEFAULT_DIR;
export const projectsDir = () => path.join(claudeDir(), "projects");
export const claudeJsonPath = () => (process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(HOME, ".claude.json"));
export const dataDir = () => DATA_DIR;

const listeners = new Set<() => void>();
/** Modules holding caches keyed on the old profile register here to drop them. */
export function onProfileChange(fn: () => void): void {
  listeners.add(fn);
}

function apply(next: Saved): void {
  current = next;
  if (isDefaultDir(next.configDir)) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = next.configDir;
  for (const fn of listeners) fn();
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function head(file: string, bytes = 4096): Promise<string> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

/** `CLAUDE_CONFIG_DIR=...` from a wrapper script (sh, cmd, ps1). Comment lines are skipped; the result must be absolute. */
export function configDirFromScript(text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(#|::|rem\b)/i.test(line)) continue;
    const m = /CLAUDE_CONFIG_DIR\s*=\s*["']?([^"'&;]+?)["']?\s*(?:$|[&;]|\s+(?:exec|claude|&&))/i.exec(line);
    if (!m?.[1]) continue;
    const value = m[1]
      .trim()
      .replace(/^~(?=$|[\\/])/, HOME)
      .replace(/%USERPROFILE%|\$\{HOME\}|\$HOME\b|\$env:USERPROFILE\b/gi, HOME);
    return path.isAbsolute(value) && !/[$%]/.test(value) ? path.normalize(value) : null;
  }
  return null;
}

async function version(bin: string): Promise<string | null> {
  const r = await run(bin, ["--version"], { timeoutMs: 10_000 });
  return r.code === 0 && /claude code/i.test(r.stdout) ? (r.stdout.trim().split(/\r?\n/)[0] ?? null) : null;
}

/** Real config folder = has .claude.json, projects/ or history.jsonl (plugin data folders like ~/.claude-mem have none). */
async function isConfigDir(dir: string): Promise<boolean> {
  if (isDefaultDir(dir)) return existsSync(dir);
  return existsSync(path.join(dir, ".claude.json")) || existsSync(path.join(dir, "projects")) || existsSync(path.join(dir, "history.jsonl"));
}

function maskEmail(email: string): string {
  const [user = "", domain = ""] = email.split("@");
  return domain ? `${user.slice(0, 2)}…@${domain}` : "";
}

async function describeProfile(dir: string, source: string): Promise<ClaudeProfile> {
  const json = isDefaultDir(dir) ? path.join(HOME, ".claude.json") : path.join(dir, ".claude.json");
  let account: string | null = null;
  try {
    const data = JSON.parse(await readFile(json, "utf8")) as { oauthAccount?: { emailAddress?: string } };
    account = data.oauthAccount?.emailAddress ? maskEmail(data.oauthAccount.emailAddress) : null;
  } catch {
    account = null;
  }
  let projects = 0;
  try {
    projects = (await readdir(path.join(dir, "projects"))).length;
  } catch {
    projects = 0;
  }
  return { configDir: dir, label: path.basename(dir), source, account, projects };
}

let detectCache: { at: number; result: Promise<{ binaries: ClaudeBinary[]; profiles: ClaudeProfile[] }> } | null = null;

/** Every Claude Code CLI binary and config profile on this machine (cached briefly; concurrent callers share one scan). */
export function detect(): Promise<{ binaries: ClaudeBinary[]; profiles: ClaudeProfile[] }> {
  if (!detectCache || Date.now() - detectCache.at > DETECT_TTL) {
    const result = scan();
    detectCache = { at: Date.now(), result };
    result.catch(() => {
      detectCache = null;
    });
  }
  return detectCache.result;
}

async function scan(): Promise<{ binaries: ClaudeBinary[]; profiles: ClaudeProfile[] }> {
  const dirs = [...new Set((process.env.PATH ?? "").split(path.delimiter).filter(Boolean))].filter((d) => !DESKTOP_DIR.test(d));
  const binCandidates = new Map<string, string>();
  const profileDirs = new Map<string, string>([[DEFAULT_DIR, "default (~/.claude)"]]);
  if (process.env.CLAUDE_CONFIG_DIR) profileDirs.set(path.normalize(process.env.CLAUDE_CONFIG_DIR), "CLAUDE_CONFIG_DIR");
  if (envBin) binCandidates.set(envBin, "CLAUDE_BIN");
  const npmExe = process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe") : "";
  for (const p of [path.join(HOME, ".local", "bin", CLI_NAMES[0] ?? "claude"), npmExe]) if (p && (await isFile(p))) binCandidates.set(p, "install");

  for (const d of dirs) {
    let names: string[] = [];
    try {
      names = await readdir(d);
    } catch {
      continue;
    }
    for (const n of names) {
      const ext = path.extname(n).toLowerCase();
      const base = path.basename(n, ext);
      if (!WRAPPER_NAME.test(base)) continue;
      const full = path.join(d, n);
      if (!(await isFile(full))) continue;
      if (CLI_NAMES.some((c) => c.toLowerCase() === n.toLowerCase())) {
        // A POSIX `claude` that is a script may be a wrapper pinning a profile — read it; run only real binaries.
        const text = WIN ? "" : await head(full).catch(() => "");
        const dir = text.startsWith("#!") ? configDirFromScript(text) : null;
        if (dir) profileDirs.set(dir, `wrapper ${n}`);
        else binCandidates.set(full, `PATH (${n})`);
      } else if ((WIN && [".cmd", ".bat", ".ps1"].includes(ext)) || (!WIN && ext === "")) {
        const dir = configDirFromScript(await head(full).catch(() => ""));
        if (dir) profileDirs.set(dir, `wrapper ${n}`);
      }
    }
  }
  for (const n of await readdir(HOME).catch(() => [] as string[])) {
    if (/^\.claude[\w.-]*$/i.test(n) && !n.endsWith(".json") && !n.includes(".json.")) {
      const dir = path.join(HOME, n);
      if (![...profileDirs.keys()].some((k) => samePath(k, dir))) profileDirs.set(dir, "home folder");
    }
  }

  const binaries: ClaudeBinary[] = [];
  for (const [bin, source] of binCandidates) {
    if (binaries.some((b) => samePath(b.path, bin))) continue;
    const v = await version(bin);
    if (v) binaries.push({ path: bin, version: v, source });
  }
  const profiles: ClaudeProfile[] = [];
  for (const [dir, source] of profileDirs) {
    if (profiles.some((p) => samePath(p.configDir, dir))) continue;
    if (await isConfigDir(dir).catch(() => false)) profiles.push(await describeProfile(dir, source));
  }
  return { binaries, profiles };
}

/** Shared validation for a saved file and for a POST: the binary must be one Ella detected, the folder a Claude config folder. */
async function validate(input: { bin?: unknown; configDir?: unknown; name?: unknown }): Promise<Saved> {
  if (typeof input.name !== "string" || !NAME.test(input.name.trim())) throw new HttpError(400, "Name: 1–24 letters, numbers, spaces, . _ -");
  if (typeof input.bin !== "string" || !input.bin) throw new HttpError(400, "Pick a Claude Code binary");
  if (/^\\\\|^\/\//.test(input.bin)) throw new HttpError(400, "Network paths are not allowed");
  const { binaries, profiles } = await detect();
  const bin = binaries.find((b) => samePath(b.path, input.bin as string));
  if (!bin) throw new HttpError(400, "Pick one of the detected Claude Code binaries (or set CLAUDE_BIN and restart)");
  if (typeof input.configDir !== "string" || !path.isAbsolute(input.configDir) || /^\\\\|^\/\//.test(input.configDir)) throw new HttpError(400, "Pick a Claude config folder");
  const known = profiles.find((p) => samePath(p.configDir, input.configDir as string));
  if (!known && !(existsSync(input.configDir) && (await isConfigDir(input.configDir)))) throw new HttpError(400, "That folder does not look like a Claude Code config folder");
  return { bin: bin.path, configDir: known?.configDir ?? path.normalize(input.configDir), name: input.name.trim() };
}

export async function initInstance(port: number, binFromEnv: string | undefined, fallbackBin: string): Promise<void> {
  settingsFile = path.join(DATA_DIR, `instance-${port}.json`);
  envBin = binFromEnv;
  current.bin = binFromEnv ?? fallbackBin;
  let raw: string;
  try {
    raw = await readFile(settingsFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") log("warn", "instance settings unreadable", { file: settingsFile, err: (err as Error).message });
    return;
  }
  try {
    const next = await validate(JSON.parse(raw) as Saved);
    if (binFromEnv && !samePath(binFromEnv, next.bin)) log("warn", "saved Claude binary overrides CLAUDE_BIN", { saved: next.bin, env: binFromEnv });
    apply(next);
    saved = true;
  } catch (err) {
    log("warn", "saved Claude choice ignored", { file: settingsFile, err: (err as Error).message });
  }
}

export function instanceInfo(port: number): InstanceInfo {
  return { name: current.name, bin: current.bin, configDir: claudeDir(), port, saved };
}

let queue: Promise<unknown> = Promise.resolve();

/** Switches binary/profile/name. Serialized; `assertIdle` runs right before the switch so no worker starts mid-way. */
export function setInstance(input: { bin?: unknown; configDir?: unknown; name?: unknown }, assertIdle: () => void = () => undefined): Promise<void> {
  const job = queue.then(async () => {
    const next = await validate(input);
    assertIdle();
    await mkdir(path.dirname(settingsFile), { recursive: true });
    const tmp = `${settingsFile}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2));
    await rename(tmp, settingsFile);
    saved = true;
    apply(next);
    log("info", "instance switched", { bin: next.bin, configDir: next.configDir, name: next.name });
  });
  queue = job.catch(() => undefined);
  return job;
}
