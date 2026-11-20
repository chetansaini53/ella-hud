export const MODELS = ["opus", "sonnet", "haiku"] as const;
export type Model = (typeof MODELS)[number];

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export type WorkerStatus = "starting" | "cooking" | "idle" | "needs-you" | "error" | "stopped";

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

export type ServerEvent =
  | { type: "snapshot"; workers: WorkerView[]; usage: Usage; vpn: boolean; config: AppConfig }
  | { type: "worker"; worker: WorkerMeta }
  | { type: "message"; workerId: string; message: ChatMessage }
  | { type: "worker-removed"; id: string }
  | { type: "usage"; usage: Usage }
  | { type: "vpn"; vpn: boolean };
