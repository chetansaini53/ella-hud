import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { HistoryItem, ProjectItem } from "../shared/types.ts";
import { HttpError } from "./http-error.ts";
import { projectName, readdirSafe, scanSession, type FileRef } from "./history.ts";
import { assistantName, claudeJsonPath, onProfileChange, projectsDir } from "./instance.ts";

const SESSION_LIMIT = 300;

/** Claude Code names a project's session folder by replacing every non-alphanumeric char with "-". */
export const encodeProjectDir = (p: string) => p.replace(/[^a-zA-Z0-9]/g, "-");

let jsonCache: { file: string; mtimeMs: number; data: Record<string, unknown> } | null = null;

export async function readClaudeJson(): Promise<Record<string, unknown>> {
  try {
    // Claude Code's own state file; read only, never written.
    const file = claudeJsonPath();
    const s = await stat(file);
    if (jsonCache?.file === file && jsonCache.mtimeMs === s.mtimeMs) return jsonCache.data;
    const data = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    jsonCache = { file, mtimeMs: s.mtimeMs, data };
    return data;
  } catch {
    return {};
  }
}

export async function projectEntry(projectPath: string): Promise<Record<string, unknown>> {
  const projects = ((await readClaudeJson()).projects ?? {}) as Record<string, Record<string, unknown>>;
  return projects[projectPath] ?? projects[projectPath.replace(/\\/g, "/")] ?? {};
}

async function sessionFiles(dir: string): Promise<FileRef[]> {
  const names = (await readdirSafe(dir)).filter((n) => n.endsWith(".jsonl"));
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
  return refs.filter((r): r is FileRef => r !== null).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

let listCache: { at: number; items: Promise<ProjectItem[]> } | null = null;
onProfileChange(() => {
  listCache = null;
  jsonCache = null;
});
const LIST_TTL = 5_000;

/** Every project Claude Code knows: trusted folders in ~/.claude.json plus any folder that has session transcripts. */
export function listProjects(): Promise<ProjectItem[]> {
  if (!listCache || Date.now() - listCache.at > LIST_TTL) {
    const items = scanProjects();
    listCache = { at: Date.now(), items };
    items.catch(() => {
      listCache = null;
    });
  }
  return listCache.items;
}

async function scanProjects(): Promise<ProjectItem[]> {
  const known = Object.keys(((await readClaudeJson()).projects ?? {}) as Record<string, unknown>).map((p) => path.normalize(p));
  const byKey = new Map<string, string>(known.map((p) => [encodeProjectDir(p), p]));
  const dirs = await readdirSafe(projectsDir());
  for (const d of dirs) if (!byKey.has(d)) byKey.set(d, "");

  const items = await Promise.all(
    [...byKey.entries()].map(async ([key, knownPath]): Promise<ProjectItem | null> => {
      const files = await sessionFiles(path.join(projectsDir(), key));
      let p = knownPath;
      if (!p) {
        // Session folder without a ~/.claude.json entry: recover the real path from a transcript's cwd.
        for (const f of files.slice(0, 3)) {
          const item = await scanSession(f).catch(() => null);
          if (item?.cwd) {
            p = item.cwd;
            break;
          }
        }
      }
      if (!p) return null;
      return {
        key,
        path: p,
        name: projectName(p) || p,
        exists: await exists(p),
        sessions: files.length,
        lastActive: files[0]?.mtimeMs ?? null,
      };
    }),
  );
  return items
    .filter((x): x is ProjectItem => x !== null)
    .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0) || a.name.localeCompare(b.name));
}

/** Resolves a client-supplied project path to a project Claude Code knows — never an arbitrary folder. */
export async function requireProject(raw: unknown): Promise<ProjectItem> {
  if (typeof raw !== "string" || !raw) throw new HttpError(400, "project is required");
  const want = path.normalize(raw);
  const found = (await listProjects()).find((p) => path.normalize(p.path) === want);
  if (!found) throw new HttpError(404, "Unknown project");
  return found;
}

export async function projectSessions(project: ProjectItem): Promise<(HistoryItem & { fromHud: boolean })[]> {
  const files = (await sessionFiles(path.join(projectsDir(), project.key))).slice(0, SESSION_LIMIT);
  const items = await Promise.all(files.map((f) => scanSession(f).catch(() => null)));
  return items.filter((x): x is HistoryItem => x !== null).map((h) => ({ ...h, fromHud: h.title.startsWith(`${assistantName()}:`) || /^(Ella|Claudia):/.test(h.title) }));
}
