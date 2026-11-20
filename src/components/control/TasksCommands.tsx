import { Badge, Button, Group } from "@mantine/core";
import { IconTestPipe, IconPlayerPlay, IconPlayerStop, IconTerminal2, IconTrash } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import type { CommandResult, ExternalProc, ProjectItem, TaskPreset, TaskView } from "../../../shared/types.ts";
import { api } from "../../api.ts";
import { ago } from "../../format.ts";
import { projectQuery, useFetch } from "../../useFetch.ts";
import { Loadable, Section, useConfirm } from "./shared.tsx";

const STATUS_COLOR: Record<TaskView["status"], string> = { running: "hud", exited: "teal", failed: "red", stopped: "gray" };

function TaskLog({ task }: { task: TaskView }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [task.lines.length]);
  return (
    <pre ref={ref} className="ctl-pre ctl-log">
      {task.lines.length ? task.lines.join("\n") : "Waiting for output…"}
    </pre>
  );
}

export function TasksPanel({ project, tasks, now, onError }: { project: ProjectItem | null; tasks: TaskView[]; now: number; onError: (msg: string) => void }) {
  const presets = useFetch<TaskPreset[]>(project?.exists ? `/api/tasks/presets?${projectQuery(project.path)}` : null);
  const procs = useFetch<ExternalProc[]>(`/api/processes?${projectQuery(project?.path ?? null)}`);
  const [confirmModal, ask] = useConfirm();
  const [open, setOpen] = useState<string | null>(null);
  const mine = project ? tasks.filter((t) => t.projectPath === project.path) : tasks;

  const start = async (preset: TaskPreset) => {
    if (!project) return;
    try {
      const t = await api<TaskView>("POST", "/api/tasks", { project: project.path, preset: preset.id });
      setOpen(t.id);
    } catch (err) {
      onError((err as Error).message);
    }
  };
  const call = (method: string, url: string) => api(method, url).catch((err: Error) => onError(err.message));
  const killProc = async (p: ExternalProc) => {
    if (!(await ask(`Kill process ${p.pid} (${p.name}) and its children?\n\n${p.commandLine}`, "Kill"))) return;
    try {
      await api("POST", "/api/processes/stop", { project: project?.path ?? "", pid: p.pid });
      procs.reload();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  return (
    <>
      {confirmModal}
      {project && (
        <Section title="Start a task">
          {!project.exists ? (
            <div className="ctl-state">This folder no longer exists.</div>
          ) : (
            <Loadable state={presets} empty="No package.json scripts or Playwright config in this folder." isEmpty={(d) => d.length === 0}>
              {(d) => (
                <Group gap={6}>
                  {d.map((p) => (
                    <Button key={p.id} size="compact-sm" variant={p.group === "playwright" ? "light" : "default"} leftSection={p.group === "playwright" ? <IconTestPipe size={14} /> : <IconPlayerPlay size={12} />} onClick={() => void start(p)}>
                      {p.label}
                    </Button>
                  ))}
                </Group>
              )}
            </Loadable>
          )}
        </Section>
      )}

      <Section title={project ? "Tasks in this project" : "Tasks started from Claudia"} count={mine.length}>
        {mine.length === 0 && <div className="ctl-state">No tasks yet{project ? " — start one above." : "."}</div>}
        {mine.map((t) => (
          <div key={t.id} className="task-row">
            <div className="task-head">
              <button type="button" className="task-title" onClick={() => setOpen(open === t.id ? null : t.id)} aria-expanded={open === t.id}>
                <IconTerminal2 size={14} /> <b>{t.label}</b> <span className="mono dim">{t.command}</span>
              </button>
              <Badge size="xs" variant="light" color={STATUS_COLOR[t.status]}>{t.status}{t.exitCode !== null ? ` ${t.exitCode}` : ""}</Badge>
              <span className="dim">{ago(t.startedAt, now)}</span>
              {t.status === "running" ? (
                <Button size="compact-xs" color="red" variant="subtle" leftSection={<IconPlayerStop size={12} />} onClick={() => void call("POST", `/api/tasks/${t.id}/stop`)}>Stop</Button>
              ) : (
                <Button size="compact-xs" variant="subtle" leftSection={<IconTrash size={12} />} onClick={() => void call("DELETE", `/api/tasks/${t.id}`)}>Clear</Button>
              )}
            </div>
            {open === t.id && <TaskLog task={t} />}
          </div>
        ))}
      </Section>

      <Section title={project ? "Other processes using this folder" : "Playwright & browser-automation processes"} count={procs.data?.length} actions={<Button size="compact-xs" variant="subtle" onClick={procs.reload}>Refresh</Button>}>
        <Loadable state={procs} empty="Nothing running." isEmpty={(d) => d.length === 0}>
          {(d) => (
            <table className="ctl-table">
              <tbody>
                {d.map((p) => (
                  <tr key={p.pid}>
                    <td className="nowrap"><b>{p.pid}</b> {p.name} {p.playwright && <Badge size="xs" variant="outline">automation</Badge>}</td>
                    <td className="mono dim">{p.commandLine}</td>
                    <td><Button size="compact-xs" color="red" variant="subtle" onClick={() => void killProc(p)}>Kill</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Loadable>
      </Section>
    </>
  );
}

export function CommandsPanel({ project }: { project: ProjectItem | null }) {
  const list = useFetch<{ id: string; label: string }[]>("/api/commands");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<CommandResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runCmd = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      setResult(await api<CommandResult>("POST", "/api/commands", { command: id, project: project?.path ?? "" }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section title="Claude CLI commands">
      <p className="ctl-note">Read-only commands, run {project ? <>in <span className="mono">{project.path}</span></> : "globally"}.</p>
      <Loadable state={list} empty="">
        {(d) => (
          <Group gap={6}>
            {d.map((c) => (
              <Button key={c.id} size="compact-sm" variant="default" loading={busy === c.id} disabled={busy !== null && busy !== c.id} leftSection={<IconTerminal2 size={12} />} onClick={() => void runCmd(c.id)}>
                {c.label}
              </Button>
            ))}
          </Group>
        )}
      </Loadable>
      {error && <div className="ctl-state error">{error}</div>}
      {result && (
        <>
          <div className="dim ctl-sub">$ {result.command} · exit {result.code ?? "?"}{result.timedOut ? " · timed out" : ""}</div>
          <pre className="ctl-pre">{result.output || "(no output)"}</pre>
        </>
      )}
    </Section>
  );
}
