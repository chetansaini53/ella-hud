import { Button, Menu, ScrollArea, Textarea } from "@mantine/core";
import { IconCaretDownFilled } from "@tabler/icons-react";
import { useEffect, useRef, type KeyboardEvent } from "react";
import type { WorkerView } from "../../shared/types.ts";

export type InputMode = "talk" | "collect";

interface Props {
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
