import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream";
import type { AppConfig, ChatMessage, ServerEvent, TaskView, WorkerMeta } from "../shared/types.ts";
import { controlRoutes } from "./control-routes.ts";
import { guardConfig, guardRequest, resolveStatic } from "./guard.ts";
import { listEvolution, listHistory } from "./history.ts";
import { HttpError } from "./http-error.ts";
import { log } from "./log.ts";
import { TaskManager } from "./tasks.ts";
import { addTodo, listTodos, setTodoDone } from "./todos.ts";
import { UsageTracker } from "./usage.ts";
import { vpnActive } from "./vpn.ts";
import { WorkerManager, loadWorkerSettings } from "./workers.ts";

const PORT = Number(process.env.PORT ?? 4317);
const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 64 * 1024;
const DIST = path.resolve("dist");
const ID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
const STREAMING = Symbol("streaming");
// --dev (set by the dev:server script) also trusts the Vite dev server on 5173.
const guard = guardConfig(PORT, process.argv.includes("--dev") ? 5173 : null);

const settings = loadWorkerSettings(process.env);
const config: AppConfig = {
  defaultCwd: process.env.DEFAULT_CWD ?? settings.workspaceRoots[0] ?? "",
  permissionMode: settings.permissionMode,
  maxWorkers: settings.maxWorkers,
};
const workers = new WorkerManager(settings);
const tasks = new TaskManager();
const usage = new UsageTracker();
const clients = new Set<ServerResponse>();
let vpn = vpnActive();

function broadcast(event: ServerEvent): void {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(frame);
}

workers.on("worker", (worker: WorkerMeta) => broadcast({ type: "worker", worker }));
workers.on("message", (workerId: string, message: ChatMessage) => broadcast({ type: "message", workerId, message }));
workers.on("removed", (id: string) => broadcast({ type: "worker-removed", id }));
tasks.on("task", (task: Omit<TaskView, "lines">) => broadcast({ type: "task", task }));
tasks.on("log", (id: string, lines: string[]) => broadcast({ type: "task-log", id, lines }));
tasks.on("removed", (id: string) => broadcast({ type: "task-removed", id }));
workers.on("rate-limit", (ev: Record<string, unknown>) => {
  if (usage.apply(ev)) broadcast({ type: "usage", usage: usage.get() });
});
setInterval(() => {
  const now = vpnActive();
  if (now !== vpn) broadcast({ type: "vpn", vpn: (vpn = now) });
  for (const res of clients) res.write(": ping\n\n");
}, 25_000).unref();

type Handler = (req: IncomingMessage, res: ServerResponse, params: string[]) => Promise<unknown> | unknown;
const routes: [string, RegExp, Handler][] = [
  ["GET", /^\/api\/events$/, (req, res) => openStream(req, res)],
  ["GET", /^\/api\/history$/, () => listHistory()],
  ["GET", /^\/api\/evolution$/, () => listEvolution()],
  ["GET", /^\/api\/todos$/, () => listTodos()],
  ["POST", /^\/api\/todos$/, async (req) => addTodo((await body(req)).text)],
  ["PATCH", new RegExp(`^/api/todos/${ID}$`), async (req, _res, [id]) => setTodoDone(id ?? "", (await body(req)).done)],
  ["POST", /^\/api\/workers$/, async (req) => workers.create(await body(req))],
  ["POST", new RegExp(`^/api/workers/${ID}/messages$`), async (req, _res, [id]) => workers.send(id ?? "", (await body(req)).text)],
  ["POST", new RegExp(`^/api/workers/${ID}/stop$`), (_req, _res, [id]) => workers.stop(id ?? "")],
  ["DELETE", new RegExp(`^/api/workers/${ID}$`), (_req, _res, [id]) => workers.remove(id ?? "")],
  ...controlRoutes(settings.claudeBin, tasks, body).map(([m, re, fn]): [string, RegExp, Handler] => [m, re, (req, _res, params) => fn(req, params)]),
];

function openStream(req: IncomingMessage, res: ServerResponse): typeof STREAMING {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
  const snapshot: ServerEvent = { type: "snapshot", workers: workers.list(), usage: usage.get(), vpn, config, tasks: tasks.list() };
  res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
  return STREAMING;
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "Content-Type must be application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Body must be a JSON object");
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload ?? { ok: true }));
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json",
};

async function serveStatic(urlPath: string, res: ServerResponse): Promise<void> {
  let file = resolveStatic(DIST, urlPath);
  if (file === null) throw new HttpError(400, "Bad path");
  try {
    if (!(await stat(file)).isFile()) file = path.join(DIST, "index.html");
  } catch {
    file = path.join(DIST, "index.html");
  }
  try {
    await stat(file);
  } catch {
    send(res, 404, { error: "UI not built — run the start script" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self'",
    "Permissions-Policy": "microphone=(self)",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  pipeline(createReadStream(file), res, (err) => {
    if (err && err.code !== "ERR_STREAM_PREMATURE_CLOSE") log("warn", "static read failed", { file, err: err.message });
  });
}

const server = createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  try {
    guardRequest(req, guard);
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (!url.pathname.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
      await serveStatic(url.pathname, res);
      return;
    }
    for (const [method, pattern, handler] of routes) {
      const m = pattern.exec(url.pathname);
      if (!m || req.method !== method) continue;
      const result = await handler(req, res, m.slice(1));
      if (result !== STREAMING) send(res, 200, result);
      return;
    }
    throw new HttpError(404, "Not found");
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) log("error", "request failed", { url: req.url, err: (err as Error).stack });
    if (!res.headersSent) send(res, status, { error: status === 500 ? "Internal error" : (err as Error).message });
    else res.end();
  }
});

server.on("error", (err: NodeJS.ErrnoException) => {
  log("error", err.code === "EADDRINUSE" ? `Port ${PORT} is busy — set PORT in .env` : "server error", { err: err.message });
  process.exit(1);
});
server.listen(PORT, HOST, () => log("info", "ella-hud listening", { url: `http://${HOST}:${PORT}`, roots: settings.workspaceRoots }));

function shutdown(): void {
  workers.shutdown();
  tasks.shutdown();
  server.close();
  process.exit(0);
}
// SIGHUP = console window closed on Windows; stop the workers instead of orphaning them.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, shutdown);
