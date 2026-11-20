import { useEffect, useReducer } from "react";
import type { AppConfig, InstanceInfo, ServerEvent, TaskView, Usage, WorkerView } from "../shared/types.ts";

/** JSON call to the HUD server; `timeoutMs` defaults to 15 s (long Docker cleanups pass more). */
export async function api<T>(method: string, url: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error("The HUD server is not reachable — is it running?");
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export interface HudState {
  connected: boolean;
  workers: WorkerView[];
  usage: Usage;
  vpn: boolean;
  config: AppConfig | null;
  tasks: TaskView[];
  instance: InstanceInfo | null;
}

type Action = ServerEvent | { type: "disconnected" };

const MAX_MESSAGES = 200;

const initial: HudState = { connected: false, workers: [], usage: { session: null, week: null, details: [] }, vpn: false, config: null, tasks: [], instance: null };
const MAX_TASK_LINES = 500;

function reducer(state: HudState, ev: Action): HudState {
  switch (ev.type) {
    case "snapshot":
      return { connected: true, workers: ev.workers, usage: ev.usage, vpn: ev.vpn, config: ev.config, tasks: ev.tasks, instance: ev.instance };
    case "worker": {
      const exists = state.workers.some((w) => w.id === ev.worker.id);
      return {
        ...state,
        workers: exists ? state.workers.map((w) => (w.id === ev.worker.id ? { ...ev.worker, messages: w.messages } : w)) : [...state.workers, { ...ev.worker, messages: [] }],
      };
    }
    case "message":
      return {
        ...state,
        workers: state.workers.map((w) => (w.id === ev.workerId ? { ...w, messages: [...w.messages, ev.message].slice(-MAX_MESSAGES) } : w)),
      };
    case "worker-removed":
      return { ...state, workers: state.workers.filter((w) => w.id !== ev.id) };
    case "usage":
      return { ...state, usage: ev.usage };
    case "vpn":
      return { ...state, vpn: ev.vpn };
    case "task": {
      const exists = state.tasks.some((t) => t.id === ev.task.id);
      return {
        ...state,
        tasks: exists ? state.tasks.map((t) => (t.id === ev.task.id ? { ...ev.task, lines: t.lines } : t)) : [...state.tasks, { ...ev.task, lines: [] }],
      };
    }
    case "task-log":
      return { ...state, tasks: state.tasks.map((t) => (t.id === ev.id ? { ...t, lines: [...t.lines, ...ev.lines].slice(-MAX_TASK_LINES) } : t)) };
    case "task-removed":
      return { ...state, tasks: state.tasks.filter((t) => t.id !== ev.id) };
    case "instance":
      return { ...state, instance: ev.instance };
    case "disconnected":
      return { ...state, connected: false };
  }
}

/** Live HUD state over Server-Sent Events; EventSource reconnects on its own and the server re-sends a snapshot. */
export function useHud(): HudState {
  const [state, dispatch] = useReducer(reducer, initial);
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = (e: MessageEvent<string>) => {
      try {
        dispatch(JSON.parse(e.data) as ServerEvent);
      } catch {
        dispatch({ type: "disconnected" });
      }
    };
    es.onerror = () => dispatch({ type: "disconnected" });
    return () => es.close();
  }, []);
  return state;
}
