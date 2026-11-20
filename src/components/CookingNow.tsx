import { Button } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import type { WorkerView } from "../../shared/types.ts";
import { ago } from "../format.ts";

const STATUS_TEXT: Record<WorkerView["status"], string> = {
  starting: "starting",
  working: "working",
  idle: "done, waiting",
  "needs-you": "needs you",
  error: "error",
  stopped: "stopped",
};

interface Props {
  workers: WorkerView[];
  selectedId: string | null;
  talkingId: string | null;
  now: number;
  onSelect: (id: string) => void;
  onNewWorker: () => void;
}

function WorkerCard({ w, selected, talking, now, onSelect }: { w: WorkerView; selected: boolean; talking: boolean; now: number; onSelect: () => void }) {
  const status = talking ? "talking" : w.status;
  return (
    <button type="button" className={`card ${talking ? "talking" : ""} ${selected ? "selected" : ""}`} onClick={onSelect} aria-pressed={selected}>
      <span className="card-path">{w.location}</span>
      <span className="card-title">{w.activity ?? w.title}</span>
      <span className={`card-status status-${status}`}>
        <span className="dot" />
        {talking ? "working, talking" : STATUS_TEXT[w.status]}
        <span className="when">{ago(w.updatedAt, now)}</span>
      </span>
      <span className="card-meta">
        {w.model} · {w.effort} effort
      </span>
      {w.subagents.length > 0 && (
        <span className="card-subs">
          {w.subagents.slice(0, 3).map((s) => (
            <span key={s.id} className="sub-line">
              ↳ <b>{s.model}</b> · {s.label}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

export function WorkingOn({ workers, selectedId, talkingId, now, onSelect, onNewWorker }: Props) {
  const running = workers.filter((w) => w.status === "working" || w.status === "starting").length;
  const visible = workers.filter((w) => w.status !== "stopped");
  return (
    <section className="working" aria-label="Workers">
      <div className="working-head">
        <span className="working-title label-caps">Working on</span>
        <span className="dim">{running} running</span>
      </div>
      <div className="cards">
        {visible.map((w) => (
          <WorkerCard key={w.id} w={w} selected={w.id === selectedId} talking={w.id === talkingId} now={now} onSelect={() => onSelect(w.id)} />
        ))}
        {visible.length === 0 && (
          <div className="cards-empty">
            <span>No workers yet. Give one a task and watch it work.</span>
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={onNewWorker}>
              New worker
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
