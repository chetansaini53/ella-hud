import { copyFile, lstat, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ClaudeConfigView, ConfigFile, McpServerInfo, NamedItem, PermissionSet, PluginInfo, ProjectItem } from "../shared/types.ts";
import { run } from "./exec.ts";
import { CLAUDE_DIR, readdirSafe } from "./history.ts";
import { HttpError } from "./http-error.ts";
import { projectEntry, readClaudeJson } from "./projects.ts";

const MAX_VIEW_BYTES = 256 * 1024;
const MASK = "••••••";
const SECRETISH = /(key|token|secret|passw|pwd|auth|bearer|credential|signature|sig$|cookie|session)/i;
/** Long opaque strings without path separators (API keys, base64), or JWTs. */
const TOKENISH = /^(?:[A-Za-z0-9+=_.-]{32,}|[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})$/;
const NAME = /^[\w.@:/-]{1,120}$/;

type Json = Record<string, unknown>;

async function readJson(file: string): Promise<Json | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : null;
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function head(file: string, bytes = 3000): Promise<string> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

/** Top-level `key: value` pairs of YAML front matter, including folded (`>-` / `|`) blocks. */
export function frontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m?.[1]) return {};
  const out: Record<string, string> = {};
  let current: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv?.[1] !== undefined) {
      current = kv[1];
      const v = (kv[2] ?? "").trim();
      out[current] = /^[>|][-+]?$/.test(v) ? "" : v.replace(/^["']|["']$/g, "");
    } else if (current && /^\s+\S/.test(line)) {
      out[current] = `${out[current] ?? ""} ${line.trim()}`.trim();
    }
  }
  return out;
}

const clip = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Skill folders (<dir>/<name>/SKILL.md) or flat markdown files (<dir>/*.md). */
async function markdownItems(dir: string, source: string, nested: boolean): Promise<NamedItem[]> {
  const names = await readdirSafe(dir);
  const items = await Promise.all(
    names.map(async (n): Promise<NamedItem | null> => {
      const file = nested ? path.join(dir, n, "SKILL.md") : path.join(dir, n);
      if (!nested && !n.endsWith(".md")) return null;
      try {
        const text = await head(file);
        const fm = frontmatter(text);
        const firstHeading = /^#\s+(.+)$/m.exec(text)?.[1] ?? "";
        const detail = fm.description || (fm.paths ? `paths: ${fm.paths}` : firstHeading);
        return { name: fm.name || (nested ? n : n.replace(/\.md$/, "")), detail: clip(detail), source, path: file };
      } catch {
        return null;
      }
    }),
  );
  return items.filter((x): x is NamedItem => x !== null).sort((a, b) => a.name.localeCompare(b.name));
}

function hooksOf(settings: Json | null, source: string): NamedItem[] {
  const hooks = (settings?.hooks ?? {}) as Record<string, { matcher?: string; hooks?: { command?: string; type?: string }[] }[]>;
  return Object.entries(hooks).flatMap(([event, groups]) =>
    (Array.isArray(groups) ? groups : []).flatMap((g) =>
      (g.hooks ?? []).map((h) => ({ name: event, detail: clip(`${g.matcher ? `[${g.matcher}] ` : ""}${maskText(h.command ?? h.type ?? "")}`, 160), source })),
    ),
  );
}

function permissionsOf(settings: Json | null, source: string): PermissionSet | null {
  const p = settings?.permissions as { allow?: string[]; deny?: string[]; ask?: string[]; defaultMode?: string } | undefined;
  if (!p) return null;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { source, allow: list(p.allow), deny: list(p.deny), ask: list(p.ask), defaultMode: p.defaultMode ?? null };
}

/** Free text (hook commands, header values): bearer tokens, KEY=value pairs and token-like runs are masked. */
export function maskText(text: string): string {
  return text
    .replace(/\b(authorization\s*[:=]\s*)(?:(?:bearer|basic)\s+)?[^\s'"]+/gi, `$1${MASK}`)
    .replace(/\b((?:bearer|basic)\s+)[^\s'"]+/gi, `$1${MASK}`)
    .replace(/\b([\w-]*(?:key|token|secret|passw|pwd)[\w-]*\s*=\s*)[^\s"'&]+/gi, `$1${MASK}`)
    .replace(/(?<![\w/\\.-])(?:[A-Za-z0-9+=_-]{32,}|(?:sk|ghp|gho|xox[bp]|AKIA)[-_A-Za-z0-9]{10,})(?![\w/\\.-])/g, MASK);
}

/** URL without credentials: user:pass@ and secret-looking query parameters are masked. */
export function maskUrl(url: string): string {
  return url
    .replace(/^([a-z][\w+.-]*:\/\/)[^/@\s]+@/i, `$1${MASK}@`)
    .replace(/([?&])([^=&#]+)=([^&#]*)/g, (m, sep: string, k: string) => (SECRETISH.test(k) ? `${sep}${k}=${MASK}` : m));
}

/** Arg list without secrets: values after secret-looking flags, bearer headers and token-like strings are masked. */
export function maskArgList(args: unknown[]): string[] {
  const out: string[] = [];
  let maskNext = false;
  for (const a of args) {
    const s = String(a);
    if (maskNext) {
      out.push(MASK);
      maskNext = false;
      continue;
    }
    const eq = /^(--?[\w-]+)=(.*)$/.exec(s);
    if (eq && SECRETISH.test(eq[1] ?? "")) out.push(`${eq[1]}=${MASK}`);
    else if (/^--?[\w-]+$/.test(s) && SECRETISH.test(s)) {
      out.push(s);
      maskNext = true;
    } else if (TOKENISH.test(s) || /^(sk|ghp|gho|xox[bp]|AKIA)[-_A-Za-z0-9]{10,}/.test(s)) out.push(MASK);
    else if (/^https?:\/\//i.test(s)) out.push(maskUrl(s));
    else out.push(maskText(s));
  }
  return out;
}

export const maskArgs = (args: unknown[]): string => maskArgList(args).join(" ");

function mcpList(servers: unknown, scope: McpServerInfo["scope"], enabledFor: (name: string) => boolean, toggleable: boolean): McpServerInfo[] {
  return Object.entries((servers ?? {}) as Record<string, { type?: string; command?: string; args?: unknown[]; url?: string }>).map(([name, s]) => ({
    name,
    scope,
    transport: s.type ?? (s.command ? "stdio" : "http"),
    target: s.command ? maskArgs([s.command, ...(s.args ?? [])]) : maskUrl(s.url ?? ""),
    enabled: enabledFor(name),
    toggleable,
  }));
}

const userSettings = () => Promise.all([readJson(path.join(CLAUDE_DIR, "settings.json")), readJson(path.join(CLAUDE_DIR, "settings.local.json"))]);

export async function globalConfig(): Promise<ClaudeConfigView> {
  const [settings, local] = await userSettings();
  const claudeJson = await readClaudeJson();
  const fileDefs: [string, string][] = [
    [path.join(CLAUDE_DIR, "CLAUDE.md"), "Global CLAUDE.md (your profile)"],
    [path.join(CLAUDE_DIR, "settings.json"), "User settings"],
    [path.join(CLAUDE_DIR, "settings.local.json"), "User local settings"],
  ];
  return {
    scope: "global",
    files: await filesOf(fileDefs),
    skills: await markdownItems(path.join(CLAUDE_DIR, "skills"), "user", true),
    agents: await markdownItems(path.join(CLAUDE_DIR, "agents"), "user", false),
    commands: await markdownItems(path.join(CLAUDE_DIR, "commands"), "user", false),
    rules: await markdownItems(path.join(CLAUDE_DIR, "rules"), "user", false),
    hooks: [...hooksOf(settings, "settings.json"), ...hooksOf(local, "settings.local.json")],
    mcp: mcpList(claudeJson.mcpServers, "user", () => true, false),
    permissions: [permissionsOf(settings, "settings.json"), permissionsOf(local, "settings.local.json")].filter((x): x is PermissionSet => x !== null),
  };
}

export async function projectConfig(project: ProjectItem): Promise<ClaudeConfigView> {
  const p = project.path;
  const dot = path.join(p, ".claude");
  const [shared, local, mcpJson, entry, claudeJson, [userS, userL]] = await Promise.all([
    readJson(path.join(dot, "settings.json")),
    readJson(path.join(dot, "settings.local.json")),
    readJson(path.join(p, ".mcp.json")),
    projectEntry(p),
    readClaudeJson(),
    userSettings(),
  ]);
  const names = (...lists: unknown[]) => new Set(lists.flatMap((l) => (Array.isArray(l) ? l.filter((x): x is string => typeof x === "string") : [])));
  const all = [userS, userL, shared, local];
  const rejected = names(entry.disabledMcpjsonServers, ...all.map((s) => s?.disabledMcpjsonServers));
  const approved = names(entry.enabledMcpjsonServers, ...all.map((s) => s?.enabledMcpjsonServers));
  const approveAll = all.some((s) => s?.enableAllProjectMcpServers === true);
  const projectMcpEnabled = (n: string) => !rejected.has(n) && (approveAll || approved.has(n));

  const legacy = Array.isArray(entry.allowedTools) && entry.allowedTools.length ? [{ source: "~/.claude.json allowedTools", allow: entry.allowedTools as string[], deny: [], ask: [], defaultMode: null }] : [];
  return {
    scope: "project",
    files: await filesOf([
      [path.join(p, "CLAUDE.md"), "CLAUDE.md"],
      [path.join(dot, "CLAUDE.md"), ".claude/CLAUDE.md"],
      [path.join(p, "CLAUDE.local.md"), "CLAUDE.local.md"],
      [path.join(dot, "settings.json"), ".claude/settings.json (shared)"],
      [path.join(dot, "settings.local.json"), ".claude/settings.local.json (yours)"],
      [path.join(p, ".mcp.json"), ".mcp.json"],
    ]),
    skills: await markdownItems(path.join(dot, "skills"), "project", true),
    agents: await markdownItems(path.join(dot, "agents"), "project", false),
    commands: await markdownItems(path.join(dot, "commands"), "project", false),
    rules: await markdownItems(path.join(dot, "rules"), "project", false),
    hooks: [...hooksOf(shared, "settings.json"), ...hooksOf(local, "settings.local.json")],
    mcp: [
      ...mcpList(mcpJson?.mcpServers, "project", projectMcpEnabled, true),
      ...mcpList(entry.mcpServers, "local", () => true, false),
      ...mcpList(claudeJson.mcpServers, "user", () => true, false),
    ],
    permissions: [permissionsOf(shared, ".claude/settings.json"), permissionsOf(local, ".claude/settings.local.json"), ...legacy].filter((x): x is PermissionSet => x !== null),
  };
}

async function filesOf(defs: [string, string][]): Promise<ConfigFile[]> {
  return Promise.all(defs.map(async ([p, label]) => ({ path: p, label, exists: await exists(p) })));
}

/** Read-only viewer, limited to files the config view itself lists. JSON env/header values are masked. */
export async function viewFile(view: ClaudeConfigView, raw: unknown): Promise<string> {
  if (typeof raw !== "string") throw new HttpError(400, "path is required");
  const want = path.normalize(raw);
  const allowed = [...view.files.filter((f) => f.exists).map((f) => f.path), ...[view.skills, view.agents, view.commands, view.rules].flat().map((i) => i.path ?? "")];
  if (!allowed.some((a) => a && path.normalize(a) === want)) throw new HttpError(403, "Not a listed config file");
  // A symlinked SKILL.md / .mcp.json in a cloned repo must not turn the viewer into a file reader.
  if ((await lstat(want)).isSymbolicLink()) throw new HttpError(403, "Symlinked config files are not previewed");
  const s = await stat(want);
  if (s.size > MAX_VIEW_BYTES) throw new HttpError(413, "File too large to preview");
  const text = await readFile(want, "utf8");
  if (!want.endsWith(".json")) return text;
  try {
    return JSON.stringify(maskJson(JSON.parse(text)), null, 2);
  } catch {
    // Fail closed: an unparseable file could hold secrets the masker can't see.
    return "This JSON file could not be parsed (comments or a trailing comma?), so it is hidden to avoid showing secrets. Open it in your editor.";
  }
}

export function maskJson(v: unknown, parentKey = ""): unknown {
  if (Array.isArray(v)) return v.map((x) => maskJson(x, parentKey));
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Json).map(([k, x]) => {
        if ((k === "env" || k === "headers") && x && typeof x === "object") return [k, Object.fromEntries(Object.keys(x as Json).map((ek) => [ek, MASK]))];
        if (SECRETISH.test(k) && x !== null && typeof x !== "boolean") return [k, MASK];
        if (k === "args" && Array.isArray(x)) return [k, maskArgList(x)];
        if (typeof x === "string") return [k, /^[a-z][\w+.-]*:\/\//i.test(x) ? maskUrl(x) : k === "command" ? maskText(x) : x];
        return [k, maskJson(x, k)];
      }),
    );
  }
  return v;
}

/** Approve/reject a project .mcp.json server the same way Claude Code's approval dialog does: in .claude/settings.local.json. */
export async function setProjectMcp(project: ProjectItem, name: unknown, enabled: unknown): Promise<void> {
  if (typeof name !== "string" || !NAME.test(name)) throw new HttpError(400, "Invalid server name");
  if (typeof enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
  const mcpJson = await readJson(path.join(project.path, ".mcp.json"));
  if (!mcpJson?.mcpServers || typeof mcpJson.mcpServers !== "object" || !Object.hasOwn(mcpJson.mcpServers, name)) throw new HttpError(404, "Not a server in this project's .mcp.json");

  const file = path.join(project.path, ".claude", "settings.local.json");
  let current: Json = {};
  if (await exists(file)) {
    const parsed = await readJson(file);
    if (!parsed) throw new HttpError(409, ".claude/settings.local.json is not valid JSON — fix it by hand first");
    current = parsed;
    await copyFile(file, `${file}.ella-bak`);
  }
  const list = (k: string) => new Set(Array.isArray(current[k]) ? (current[k] as string[]) : []);
  const on = list("enabledMcpjsonServers");
  const off = list("disabledMcpjsonServers");
  if (enabled) {
    on.add(name);
    off.delete(name);
  } else {
    off.add(name);
    on.delete(name);
  }
  const next: Json = { ...current, enabledMcpjsonServers: [...on], disabledMcpjsonServers: [...off] };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

export async function listPlugins(claudeBin: string): Promise<PluginInfo[]> {
  const r = await run(claudeBin, ["plugin", "list", "--json"], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new HttpError(502, clip(r.stderr || "claude plugin list failed", 300));
  try {
    const list = JSON.parse(r.stdout) as { id: string; version?: string; scope?: string; enabled?: boolean }[];
    return list.map((p) => ({ id: p.id, version: p.version ?? "", scope: p.scope ?? "user", enabled: p.enabled === true }));
  } catch {
    throw new HttpError(502, "Unexpected output from claude plugin list");
  }
}

/** Uses the official CLI so Claude Code itself owns the settings write. User scope only (project/local would write to Ella's own folder). */
export async function setPlugin(claudeBin: string, id: unknown, enabled: unknown): Promise<string> {
  if (typeof id !== "string" || !NAME.test(id) || id.startsWith("-")) throw new HttpError(400, "Invalid plugin id");
  if (typeof enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
  const r = await run(claudeBin, ["plugin", enabled ? "enable" : "disable", id, "--scope", "user"], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new HttpError(502, clip(r.stderr || r.stdout || "claude plugin command failed", 400));
  return r.stdout.trim();
}
