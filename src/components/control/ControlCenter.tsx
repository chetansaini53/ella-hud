import { ScrollArea, TextInput } from "@mantine/core";
import { IconSearch, IconWorld } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import type { HistoryItem, ProjectItem, TaskView } from "../../../shared/types.ts";
import { hhmm } from "../../format.ts";
import { useFetch } from "../../useFetch.ts";
import { McpPanel, DockerPanel } from "./McpDocker.tsx";
import { ConfigPanel, SessionsPanel } from "./SessionsConfig.tsx";
import { CommandsPanel, TasksPanel } from "./TasksCommands.tsx";
import { Loadable } from "./shared.tsx";

const TABS = [
  { id: "sessions", label: "Sessions" },
  { id: "config", label: "Config" },
  { id: "mcp", label: "MCP & Plugins" },
  { id: "docker", label: "Docker" },
  { id: "tasks", label: "Tasks" },
  { id: "commands", label: "Commands" },
] as const;
type Tab = (typeof TABS)[number]["id"];

interface Props {
  now: number;
  tasks: TaskView[];
  onOpenWorker: (item: HistoryItem) => void;
  onError: (msg: string) => void;
}

export function ControlCenter({ now, tasks, onOpenWorker, onError }: Props) {
  const projects = useFetch<ProjectItem[]>("/api/projects");
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("sessions");
  const [query, setQuery] = useState("");

  const project = projects.data?.find((p) => p.path === selected) ?? null;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (projects.data ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q));
  }, [projects.data, query]);
  const runningIn = (p: string) => tasks.filter((t) => t.projectPath === p && t.status === "running").length;

  return (
    <div className="control">
      <aside className="left" aria-label="Projects">
        <div className="search hud-input">
          <TextInput aria-label="Search projects" placeholder="Search projects" value={query} onChange={(e) => setQuery(e.currentTarget.value)} rightSection={<IconSearch size={14} color="var(--hud-text-dim)" />} />
        </div>
        <ScrollArea className="list" type="hover" scrollbarSize={6}>
          <button type="button" className={`item ${selected === null ? "selected" : ""}`} onClick={() => setSelected(null)}>
            <div className="item-title"><IconWorld size={13} /> Global profile</div>
            <div className="item-meta">CLAUDE.md, rules, skills, plugins, all Docker</div>
          </button>
          <div className="group-label">Projects {projects.data ? `· ${projects.data.length}` : ""}</div>
          <Loadable state={projects} empty="Claude Code has no projects yet." isEmpty={(d) => d.length === 0}>
            {() =>
              filtered.map((p) => (
                <button key={p.key} type="button" className={`item ${p.path === selected ? "selected" : ""}`} onClick={() => setSelected(p.path)} title={p.path}>
                  <div className="item-title">
                    {p.name} {runningIn(p.path) > 0 && <span className="dot status-cooking" aria-label="task running" />}
                  </div>
                  <div className="item-meta">
                    {p.sessions} sessions{p.lastActive ? `, ${new Date(p.lastActive).toLocaleDateString("en-GB")} ${hhmm(p.lastActive)}` : ""}
                    {!p.exists && " · folder missing"}
                  </div>
                </button>
              ))
            }
          </Loadable>
        </ScrollArea>
      </aside>

      <main className="ctl-main">
        <div className="ctl-header">
          <div>
            <div className="ctl-title">{project ? project.name : "Global profile"}</div>
            <div className="mono dim">{project ? project.path : "~/.claude — applies to every project"}</div>
          </div>
        </div>
        <div className="tabs ctl-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <ScrollArea className="ctl-body" type="hover" scrollbarSize={6}>
          <div className="ctl-content" key={`${selected ?? "global"}:${tab}`}>
            {tab === "sessions" && <SessionsPanel project={project} now={now} onOpenWorker={onOpenWorker} />}
            {tab === "config" && <ConfigPanel project={project} />}
            {tab === "mcp" && <McpPanel project={project} onError={onError} />}
            {tab === "docker" && <DockerPanel project={project} onError={onError} />}
            {tab === "tasks" && <TasksPanel project={project} tasks={tasks} now={now} onError={onError} />}
            {tab === "commands" && <CommandsPanel project={project} />}
          </div>
        </ScrollArea>
      </main>
    </div>
  );
}
