export const MODELS = ["opus", "sonnet", "haiku"] as const;
export type Model = (typeof MODELS)[number];

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export type WorkerStatus = "starting" | "working" | "idle" | "needs-you" | "error" | "stopped";

export interface SubagentLine {
  id: string;
  model: string;
  label: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  at: number;
}

export interface WorkerView {
  id: string;
  sessionId: string | null;
  cwd: string;
  location: string;
  title: string;
  status: WorkerStatus;
  model: string;
  effort: Effort;
  activity: string | null;
  subagents: SubagentLine[];
  messages: ChatMessage[];
  startedAt: number;
  updatedAt: number;
}

export type WorkerMeta = Omit<WorkerView, "messages">;

export interface UsageWindow {
  pct: number;
  resetsAt: number | null;
}

export interface Usage {
  session: UsageWindow | null;
  week: UsageWindow | null;
  /** Contributor lines from `/usage` (24h / 7d breakdown), for the meter tooltip. */
  details: string[];
}

export interface HistoryItem {
  id: string;
  title: string;
  project: string;
  cwd: string;
  at: number;
  asks: number;
}

export interface EvolutionItem {
  id: string;
  title: string;
  detail: string;
  project: string;
  at: number;
}

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  at: number;
}

export interface AppConfig {
  defaultCwd: string;
  permissionMode: string;
  maxWorkers: number;
}

/* ---------- Which Claude this instance drives ---------- */

export interface ClaudeBinary {
  path: string;
  version: string;
  source: string;
}

export interface ClaudeProfile {
  configDir: string;
  label: string;
  source: string;
  account: string | null;
  projects: number;
}

export interface InstanceInfo {
  name: string;
  bin: string;
  configDir: string;
  port: number;
  saved: boolean;
}

/* ---------- Control center ---------- */

export interface ProjectItem {
  key: string;
  path: string;
  name: string;
  exists: boolean;
  sessions: number;
  lastActive: number | null;
}

export interface ConfigFile {
  path: string;
  label: string;
  exists: boolean;
}

export interface NamedItem {
  name: string;
  detail: string;
  source: string;
  path?: string;
}

export interface McpServerInfo {
  name: string;
  scope: "user" | "local" | "project" | "plugin";
  transport: string;
  target: string;
  enabled: boolean;
  toggleable: boolean;
}

export interface PermissionSet {
  source: string;
  allow: string[];
  deny: string[];
  ask: string[];
  defaultMode: string | null;
}

export interface ClaudeConfigView {
  scope: "global" | "project";
  files: ConfigFile[];
  skills: NamedItem[];
  agents: NamedItem[];
  commands: NamedItem[];
  rules: NamedItem[];
  hooks: NamedItem[];
  mcp: McpServerInfo[];
  permissions: PermissionSet[];
}

export interface PluginInfo {
  id: string;
  version: string;
  scope: string;
  enabled: boolean;
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  sizeBytes: number;
  composeProject: string | null;
  workingDir: string | null;
}

export interface DockerVolume {
  name: string;
  sizeBytes: number;
  composeProject: string | null;
}

export interface DockerProjectUsage {
  projectPath: string | null;
  label: string;
  containers: DockerContainer[];
  volumes: DockerVolume[];
  sizeBytes: number;
}

export interface DockerReport {
  available: boolean;
  error: string | null;
  groups: DockerProjectUsage[];
  imagesBytes: number;
  buildCacheBytes: number;
  volumesPending: boolean;
  reclaimable: { images: number; buildCache: number; volumes: number; containers: number };
  danglingImages: number;
}

export type DockerPrune = "dangling-images" | "unused-images" | "build-cache" | "anonymous-volumes" | "stopped-containers";

export interface ClaudeSessionProc {
  pid: number;
  cwd: string;
  kind: string;
  sessionId: string;
  name: string;
  status: string;
  startedAt: number;
}

export interface ExternalProc {
  pid: number;
  name: string;
  commandLine: string;
  playwright: boolean;
}

export type TaskStatus = "running" | "exited" | "failed" | "stopped";

export interface TaskView {
  id: string;
  projectPath: string;
  label: string;
  command: string;
  status: TaskStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  lines: string[];
}

export interface TaskPreset {
  id: string;
  label: string;
  group: "script" | "playwright";
}

export interface CommandResult {
  command: string;
  code: number | null;
  output: string;
  timedOut: boolean;
}

export type ServerEvent =
  | { type: "snapshot"; workers: WorkerView[]; usage: Usage; vpn: boolean; config: AppConfig; tasks: TaskView[]; instance: InstanceInfo }
  | { type: "instance"; instance: InstanceInfo }
  | { type: "worker"; worker: WorkerMeta }
  | { type: "message"; workerId: string; message: ChatMessage }
  | { type: "worker-removed"; id: string }
  | { type: "usage"; usage: Usage }
  | { type: "vpn"; vpn: boolean }
  | { type: "task"; task: Omit<TaskView, "lines"> }
  | { type: "task-log"; id: string; lines: string[] }
  | { type: "task-removed"; id: string };
