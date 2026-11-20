import { Button, Checkbox, Collapse, Menu, ScrollArea, Textarea, TextInput } from "@mantine/core";
import { IconCaretDownFilled, IconCaretRightFilled, IconPlus } from "@tabler/icons-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { TodoItem, WorkerView } from "../../shared/types.ts";
import { longDate } from "../format.ts";

export type InputMode = "talk" | "collect";

interface Props {
  now: number;
  worker: WorkerView | null;
  workers: WorkerView[];
  onSelectWorker: (id: string) => void;
  mode: InputMode;
  onMode: (m: InputMode) => void;
  draft: string;
  onDraft: (text: string) => void;
  onSend: () => void;
  onStop: () => void;
  onTyping: (typing: boolean) => void;
  listening: boolean;
  todos: TodoItem[] | null;
  onAddTodo: (text: string) => Promise<void>;
  onToggleTodo: (id: string, done: boolean) => void;
}

function TodoPanel({ todos, now, onAdd, onToggle }: { todos: TodoItem[] | null; now: number; onAdd: (t: string) => Promise<void>; onToggle: (id: string, done: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const openCount = todos?.filter((t) => !t.done).length;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      await onAdd(text);
      setText("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className="row" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="row-title gold label-caps">To-do</span>
        <span className="dim">{openCount === undefined ? "…" : `${openCount} open`}</span>
        <span className="row-right">
          {longDate(now)} {open ? <IconCaretDownFilled size={10} /> : <IconCaretRightFilled size={10} />}
        </span>
      </button>
      <Collapse expanded={open}>
        <div className="todo-box">
          {todos?.length === 0 && <span className="dim">No to-dos yet — add the first one.</span>}
          {todos?.map((t) => (
            <Checkbox key={t.id} size="xs" label={t.text} checked={t.done} onChange={(e) => onToggle(t.id, e.currentTarget.checked)} styles={{ label: { color: t.done ? "var(--hud-text-dim)" : "var(--hud-text-body)", textDecoration: t.done ? "line-through" : undefined } }} />
          ))}
          <form onSubmit={submit} className="hud-input">
            <TextInput
              size="xs"
              aria-label="New to-do"
              placeholder="Add a to-do"
              value={text}
              maxLength={300}
              onChange={(e) => setText(e.currentTarget.value)}
              rightSection={
                <Button type="submit" variant="subtle" size="compact-xs" loading={busy} aria-label="Add to-do" disabled={!text.trim()}>
                  <IconPlus size={14} />
                </Button>
              }
            />
          </form>
        </div>
      </Collapse>
    </>
  );
}

export function RightPanel(p: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  const lastId = p.worker?.messages.at(-1)?.id;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lastId, p.worker?.id]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      p.onSend();
    }
  };

  const busy = p.worker?.status === "cooking" || p.worker?.status === "starting";
  const placeholder = p.mode === "collect" ? "Collecting asks — speak or type, then Send them all" : p.listening ? "Or type here. Listening pauses while you type." : "Type here, or unmute the mic to talk";

  return (
    <aside className="right" aria-label="Side panel">
      <button type="button" className="row" disabled title="Calendar sync is not connected yet">
        <span className="row-title cyan label-caps">Meetings</span>
        <span className="dim">not connected</span>
        <span className="row-right">calendar sync off</span>
      </button>
      <TodoPanel todos={p.todos} now={p.now} onAdd={p.onAddTodo} onToggle={p.onToggleTodo} />

      <div className="chat-head">
        <Menu position="bottom-start" withinPortal disabled={p.workers.length === 0}>
          <Menu.Target>
            <button type="button" aria-label="Pick the worker to chat with">
              Chat <IconCaretDownFilled size={9} color="var(--hud-text-dim)" />
            </button>
          </Menu.Target>
          <Menu.Dropdown>
            {p.workers.map((w) => (
              <Menu.Item key={w.id} onClick={() => p.onSelectWorker(w.id)} color={w.id === p.worker?.id ? "hud" : undefined}>
                {w.title}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      </div>

      <ScrollArea className="chat-scroll" type="hover" scrollbarSize={6}>
        <div className="chat" aria-live="polite">
          {!p.worker && <div className="msg system">Pick a worker, or press + to start one. Its conversation shows up here.</div>}
          {p.worker?.messages.map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              {m.text}
            </div>
          ))}
          {busy && <div className="msg system">{p.worker?.activity ?? "Thinking…"}</div>}
          <div ref={endRef} />
        </div>
      </ScrollArea>

      <div className="composer">
        <div className="mode-tabs" role="tablist" aria-label="Input mode">
          <button type="button" role="tab" aria-selected={p.mode === "talk"} className={`mode ${p.mode === "talk" ? "active" : ""}`} onClick={() => p.onMode("talk")}>
            Talk
          </button>
          <button type="button" role="tab" aria-selected={p.mode === "collect"} className={`mode ${p.mode === "collect" ? "active" : ""}`} onClick={() => p.onMode("collect")}>
            Collect asks
          </button>
        </div>
        <div className="composer-row">
          <Textarea
            className="hud-input"
            style={{ flex: 1 }}
            aria-label="Message"
            placeholder={placeholder}
            autosize
            minRows={1}
            maxRows={5}
            value={p.draft}
            onChange={(e) => p.onDraft(e.currentTarget.value)}
            onKeyDown={onKey}
            onFocus={() => p.onTyping(true)}
            onBlur={() => p.onTyping(false)}
          />
          <Button className="btn-send" onClick={p.onSend} disabled={!p.draft.trim() || busy}>
            Send
          </Button>
          <Button className="btn-stop" onClick={p.onStop} disabled={!busy}>
            Stop
          </Button>
        </div>
      </div>
    </aside>
  );
}
