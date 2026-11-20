import type { IncomingMessage } from "node:http";
import type { CommandResult, ProjectItem } from "../shared/types.ts";
import { globalConfig, listPlugins, projectConfig, setPlugin, setProjectMcp, viewFile } from "./config.ts";
import { containerAction, dockerReport } from "./docker.ts";
import { run } from "./exec.ts";
import { HttpError } from "./http-error.ts";
import { listProjects, projectEntry, projectSessions, requireProject } from "./projects.ts";
import { claudeSessions, externalProcesses, stopExternal, taskPresets, type TaskManager } from "./tasks.ts";

/** Read-only Claude CLI commands the Commands panel may run (in the project folder when one is selected). */
const COMMANDS: Record<string, { label: string; args: string[]; timeoutMs: number }> = {
  version: { label: "claude --version", args: ["--version"], timeoutMs: 15_000 },
  doctor: { label: "claude doctor", args: ["doctor"], timeoutMs: 60_000 },
  "auth-status": { label: "claude auth status", args: ["auth", "status"], timeoutMs: 15_000 },
  "mcp-list": { label: "claude mcp list (health check)", args: ["mcp", "list"], timeoutMs: 120_000 },
  "plugin-list": { label: "claude plugin list", args: ["plugin", "list"], timeoutMs: 30_000 },
  agents: { label: "claude agents --json", args: ["agents", "--json"], timeoutMs: 30_000 },
};

export const commandList = () => Object.entries(COMMANDS).map(([id, c]) => ({ id, label: c.label }));

type Body = (req: IncomingMessage) => Promise<Record<string, unknown>>;
type Route = [string, RegExp, (req: IncomingMessage, params: string[]) => Promise<unknown> | unknown];

const query = (req: IncomingMessage, key: string) => new URL(req.url ?? "/", "http://x").searchParams.get(key) ?? "";
/** Empty project = global scope; otherwise it must be a project Claude Code knows. */
const optionalProject = async (raw: unknown): Promise<ProjectItem | null> => (raw ? requireProject(raw) : null);

export function controlRoutes(claudeBin: string, tasks: TaskManager, body: Body): Route[] {
  const ID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
  return [
    ["GET", /^\/api\/projects$/, () => listProjects()],
    ["GET", /^\/api\/projects\/sessions$/, async (req) => projectSessions(await requireProject(query(req, "project")))],

    ["GET", /^\/api\/config$/, async (req) => {
      const p = await optionalProject(query(req, "project"));
      return p ? projectConfig(p) : globalConfig();
    }],
    ["GET", /^\/api\/config\/file$/, async (req) => {
      const p = await optionalProject(query(req, "project"));
      return { text: await viewFile(p ? await projectConfig(p) : await globalConfig(), query(req, "path")) };
    }],
    ["POST", /^\/api\/config\/mcp$/, async (req) => {
      const b = await body(req);
      await setProjectMcp(await requireProject(b.project), b.name, b.enabled);
      return { ok: true };
    }],
    ["GET", /^\/api\/plugins$/, () => listPlugins(claudeBin)],
    ["POST", /^\/api\/plugins$/, async (req) => {
      const b = await body(req);
      return { output: await setPlugin(claudeBin, b.id, b.enabled) };
    }],

    ["GET", /^\/api\/docker$/, async () => dockerReport(await listProjects())],
    ["POST", /^\/api\/docker\/action$/, async (req) => {
      const b = await body(req);
      await containerAction(b.id, b.action);
      return { ok: true };
    }],

    ["GET", /^\/api\/tasks\/presets$/, async (req) => taskPresets(await requireProject(query(req, "project")))],
    ["POST", /^\/api\/tasks$/, async (req) => {
      const b = await body(req);
      return tasks.start(await requireProject(b.project), b.preset);
    }],
    ["POST", new RegExp(`^/api/tasks/${ID}/stop$`), (_req, [id]) => tasks.stop(id ?? "")],
    ["DELETE", new RegExp(`^/api/tasks/${ID}$`), (_req, [id]) => tasks.remove(id ?? "")],

    ["GET", /^\/api\/claude-sessions$/, () => claudeSessions(claudeBin)],
    ["GET", /^\/api\/processes$/, async (req) => externalProcesses((await optionalProject(query(req, "project")))?.path ?? null)],
    ["POST", /^\/api\/processes\/stop$/, async (req) => {
      const b = await body(req);
      await stopExternal((await optionalProject(b.project))?.path ?? null, b.pid);
      return { ok: true };
    }],

    ["GET", /^\/api\/commands$/, () => commandList()],
    ["POST", /^\/api\/commands$/, async (req): Promise<CommandResult> => {
      const b = await body(req);
      const cmd = typeof b.command === "string" ? COMMANDS[b.command] : undefined;
      if (!cmd) throw new HttpError(400, "Unknown command");
      const p = await optionalProject(b.project);
      // `mcp list` starts the project's .mcp.json servers — only in folders you already trusted in Claude Code.
      if (p && b.command === "mcp-list" && (await projectEntry(p.path)).hasTrustDialogAccepted !== true) {
        throw new HttpError(403, "This folder isn't trusted in Claude Code yet — open it in Claude Code once and accept the trust prompt");
      }
      const r = await run(claudeBin, cmd.args, { cwd: p?.exists ? p.path : undefined, timeoutMs: cmd.timeoutMs });
      return { command: cmd.label, code: r.code, output: `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.trim(), timedOut: r.timedOut };
    }],
  ];
}
