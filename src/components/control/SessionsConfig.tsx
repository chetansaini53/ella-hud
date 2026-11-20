import { Badge, Button, Tooltip } from "@mantine/core";
import { IconEye, IconFileOff, IconPlayerPlay } from "@tabler/icons-react";
import { useState } from "react";
import type { ClaudeConfigView, ClaudeSessionProc, HistoryItem, NamedItem, ProjectItem } from "../../../shared/types.ts";
import { api } from "../../api.ts";
import { ago, hhmm } from "../../format.ts";
import { projectQuery, useFetch } from "../../useFetch.ts";
import { Loadable, Section, TextViewer } from "./shared.tsx";

const samePath = (a: string, b: string) => a.toLowerCase().replace(/[\\/]+$/, "") === b.toLowerCase().replace(/[\\/]+$/, "");

export function SessionsPanel({ project, now, onOpenWorker }: { project: ProjectItem | null; now: number; onOpenWorker: (item: HistoryItem) => void }) {
  const live = useFetch<ClaudeSessionProc[]>("/api/claude-sessions");
  const sessions = useFetch<(HistoryItem & { fromHud: boolean })[]>(project ? `/api/projects/sessions?${projectQuery(project.path)}` : null);

  return (
    <>
      <Section title="Running Claude sessions" actions={<Button size="compact-xs" variant="subtle" onClick={live.reload}>Refresh</Button>}>
        <Loadable state={live} empty="No Claude Code session is running right now." isEmpty={(d) => !d.filter((s) => !project || samePath(s.cwd, project.path)).length}>
          {(d) => (
            <table className="ctl-table">
              <thead>
                <tr><th>Session</th><th>Folder</th><th>Kind</th><th>Status</th><th>Started</th></tr>
              </thead>
              <tbody>
                {d.filter((s) => !project || samePath(s.cwd, project.path)).map((s) => (
                  <tr key={s.pid}>
                    <td>{s.name || s.sessionId.slice(0, 8)}</td>
                    <td className="mono dim">{s.cwd}</td>
                    <td>{s.kind}</td>
                    <td><Badge size="sm" variant="light" color={s.status === "busy" ? "hud" : "gray"}>{s.status}</Badge></td>
                    <td className="dim">{ago(s.startedAt, now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Loadable>
      </Section>

      {project && (
        <Section title="Session files" count={sessions.data?.length}>
          <Loadable state={sessions} empty="No session has been created in this project yet.">
            {(d) => (
              <table className="ctl-table">
                <thead>
                  <tr><th>Title</th><th>Asks</th><th>Last activity</th><th /></tr>
                </thead>
                <tbody>
                  {d.map((s) => (
                    <tr key={s.id}>
                      <td>
                        {s.title} {s.fromHud && <Badge size="xs" variant="outline" ml={6}>HUD</Badge>}
                        <div className="mono dim">{s.id}</div>
                      </td>
                      <td>{s.asks}</td>
                      <td className="dim">{new Date(s.at).toLocaleDateString("en-GB")} {hhmm(s.at)}</td>
                      <td>
                        <Tooltip label="Continue as a forked worker (the original stays untouched)">
                          <Button size="compact-xs" variant="light" leftSection={<IconPlayerPlay size={12} />} onClick={() => onOpenWorker(s)} disabled={!project.exists}>
                            Open
                          </Button>
                        </Tooltip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Loadable>
        </Section>
      )}
    </>
  );
}

function ItemTable({ items, onView }: { items: NamedItem[]; onView: (i: NamedItem) => void }) {
  return (
    <table className="ctl-table">
      <tbody>
        {items.map((i, n) => (
          <tr key={`${n}:${i.source}:${i.name}`}>
            <td className="nowrap"><b>{i.name}</b></td>
            <td className="dim">{i.detail}</td>
            <td className="nowrap">
              {i.path && (
                <Button size="compact-xs" variant="subtle" leftSection={<IconEye size={12} />} onClick={() => onView(i)}>
                  View
                </Button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ConfigPanel({ project }: { project: ProjectItem | null }) {
  const cfg = useFetch<ClaudeConfigView>(`/api/config?${projectQuery(project?.path ?? null)}`);
  const [viewer, setViewer] = useState<{ title: string; text: string } | null>(null);

  const view = async (filePath: string, title: string) => {
    try {
      const { text } = await api<{ text: string }>("GET", `/api/config/file?${projectQuery(project?.path ?? null)}&path=${encodeURIComponent(filePath)}`);
      setViewer({ title, text });
    } catch (err) {
      setViewer({ title, text: (err as Error).message });
    }
  };

  return (
    <Loadable state={cfg} empty="">
      {(c) => (
        <>
          <p className="ctl-note">Read-only view. Ella never edits these files: change them in Claude Code or your editor.</p>
          <Section title={c.scope === "global" ? "Global profile files" : "Project files"}>
            <table className="ctl-table">
              <tbody>
                {c.files.map((f) => (
                  <tr key={f.path}>
                    <td className="nowrap"><b>{f.label}</b></td>
                    <td className="mono dim">{f.path}</td>
                    <td className="nowrap">
                      {f.exists ? (
                        <Button size="compact-xs" variant="subtle" leftSection={<IconEye size={12} />} onClick={() => void view(f.path, f.label)}>View</Button>
                      ) : (
                        <span className="dim"><IconFileOff size={12} /> none</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
          {(
            [
              ["Skills", c.skills],
              ["Rules", c.rules],
              ["Agents", c.agents],
              ["Slash commands", c.commands],
            ] as const
          ).map(([title, items]) => (
            <Section key={title} title={title} count={items.length}>
              {items.length ? <ItemTable items={items} onView={(i) => void view(i.path ?? "", i.name)} /> : <div className="ctl-state">None at this level.</div>}
            </Section>
          ))}
          <Section title="Permissions">
            {c.permissions.length === 0 && <div className="ctl-state">No permission rules at this level.</div>}
            {c.permissions.map((p) => (
              <div key={p.source} className="perm-block">
                <div className="dim">{p.source}{p.defaultMode ? ` · default mode: ${p.defaultMode}` : ""}</div>
                {(["allow", "ask", "deny"] as const).map((k) =>
                  p[k].length ? (
                    <div key={k} className="perm-row">
                      <Badge size="sm" variant="light" color={k === "deny" ? "red" : k === "ask" ? "yellow" : "teal"}>{k} {p[k].length}</Badge>
                      <span className="chips">{p[k].map((r) => <code key={r}>{r}</code>)}</span>
                    </div>
                  ) : null,
                )}
              </div>
            ))}
          </Section>
          <Section title="Hooks" count={c.hooks.length}>
            {c.hooks.length ? <ItemTable items={c.hooks} onView={() => undefined} /> : <div className="ctl-state">No hooks at this level.</div>}
          </Section>
          <TextViewer title={viewer?.title ?? null} text={viewer?.text ?? ""} onClose={() => setViewer(null)} />
        </>
      )}
    </Loadable>
  );
}
