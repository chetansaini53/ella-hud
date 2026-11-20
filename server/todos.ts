import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TodoItem } from "../shared/types.ts";
import { HttpError } from "./http-error.ts";

const FILE = path.resolve("data", "todos.json");
const MAX_TODOS = 200;

let todos: TodoItem[] | null = null;
let loading: Promise<TodoItem[]> | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** One shared first read, so a slow initial load can never overwrite a newer in-memory list. */
function load(): Promise<TodoItem[]> {
  if (todos) return Promise.resolve(todos);
  loading ??= readFile(FILE, "utf8")
    .then((raw) => {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as TodoItem[]) : [];
    })
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return [];
      loading = null;
      throw err;
    })
    .then((list) => (todos ??= list));
  return loading;
}

/** Serialised writes + atomic rename; memory only moves forward once the file is on disk. */
function mutate(fn: (list: TodoItem[]) => TodoItem[]): Promise<TodoItem[]> {
  const run = queue.then(async () => {
    const next = fn(await load());
    await mkdir(path.dirname(FILE), { recursive: true });
    await writeFile(`${FILE}.tmp`, JSON.stringify(next, null, 2));
    await rename(`${FILE}.tmp`, FILE);
    todos = next;
    return next;
  });
  queue = run.catch(() => undefined);
  return run;
}

export const listTodos = (): Promise<TodoItem[]> => load();

export function addTodo(text: unknown): Promise<TodoItem[]> {
  if (typeof text !== "string" || !text.trim() || text.length > 300) throw new HttpError(400, "text must be 1–300 characters");
  return mutate((list) => {
    if (list.length >= MAX_TODOS) throw new HttpError(400, `Max ${MAX_TODOS} todos`);
    return [...list, { id: randomUUID(), text: text.trim(), done: false, at: Date.now() }];
  });
}

export function setTodoDone(id: string, done: unknown): Promise<TodoItem[]> {
  if (typeof done !== "boolean") throw new HttpError(400, "done must be true or false");
  return mutate((list) => {
    if (!list.some((t) => t.id === id)) throw new HttpError(404, "Todo not found");
    return list.map((t) => (t.id === id ? { ...t, done } : t));
  });
}
