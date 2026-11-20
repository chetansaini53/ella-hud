import { Badge, Button, SegmentedControl, Select, Switch, Tooltip } from "@mantine/core";
import { IconHeartbeat, IconPlayerPlay, IconPlayerStop } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type { ClaudeConfigView, CommandResult, DockerProjectUsage, DockerReport, PluginInfo, ProjectItem } from "../../../shared/types.ts";
import { api } from "../../api.ts";
import { fmtBytes, projectQuery, useFetch } from "../../useFetch.ts";
import { Loadable, Section, useConfirm } from "./shared.tsx";

export function McpPanel({ project, onError }: { project: ProjectItem | null; onError: (msg: string) => void }) {
  const cfg = useFetch<ClaudeConfigView>(`/api/config?${projectQuery(project?.path ?? null)}`);
  const plugins = useFetch<PluginInfo[]>(project ? null : "/api/plugins");
  const [health, setHealth] = useState<{ busy: boolean; result: CommandResult | null }>({ busy: false, result: null });
  const [confirmModal, ask] = useConfirm();

  const checkHealth = async () => {
    setHealth({ busy: true, result: null });
    try {
      setHealth({ busy: false, result: await api<CommandResult>("POST", "/api/commands", { command: "mcp-list", project: project?.path ?? "" }) });
    } catch (err) {
      setHealth({ busy: false, result: null });
      onError((err as Error).message);
    }
  };

  const toggleMcp = async (name: string, enabled: boolean) => {
    if (!project) return;
    const ok = await ask(`${enabled ? "Approve" : "Reject"} the "${name}" MCP server for ${project.name}?\n\nThis writes ${enabled ? "enabledMcpjsonServers" : "disabledMcpjsonServers"} in ${project.path}\\.claude\\settings.local.json (a backup is saved next to it). New sessions pick it up.`, enabled ? "Approve" : "Reject");
    if (!ok) return;
    try {
      await api("POST", "/api/config/mcp", { project: project.path, name, enabled });
      cfg.reload();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  const togglePlugin = async (p: PluginInfo) => {
    const ok = await ask(`${p.enabled ? "Disable" : "Enable"} plugin ${p.id} (user scope)?\n\nRuns: claude plugin ${p.enabled ? "disable" : "enable"} ${p.id} --scope user`, p.enabled ? "Disable" : "Enable");
    if (!ok) return;
    try {
      await api("POST", "/api/plugins", { id: p.id, enabled: !p.enabled, scope: "user" });
      plugins.reload();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  return (
    <>
      {confirmModal}
      <Section
        title="MCP servers"
        count={cfg.data?.mcp.length}
        actions={
          <Button size="compact-xs" variant="light" leftSection={<IconHeartbeat size={12} />} loading={health.busy} onClick={() => void checkHealth()}>
            Health check
          </Button>
        }
      >
        <Loadable state={cfg} empty="No MCP servers configured." isEmpty={(c) => c.mcp.length === 0}>
          {(c) => (
            <table className="ctl-table">
              <thead>
                <tr><th>Server</th><th>Scope</th><th>Transport</th><th>Command / URL</th><th>{project ? "In this project" : "Status"}</th></tr>
              </thead>
              <tbody>
                {c.mcp.map((m) => (
                  <tr key={`${m.scope}:${m.name}`}>
                    <td><b>{m.name}</b></td>
                    <td><Badge size="xs" variant="outline">{m.scope}</Badge></td>
                    <td>{m.transport}</td>
                    <td className="mono dim">{m.target}</td>
                    <td>
                      {m.toggleable ? (
                        <Switch size="xs" checked={m.enabled} onChange={(e) => void toggleMcp(m.name, e.currentTarget.checked)} label={m.enabled ? "approved" : "off"} />
                      ) : (
                        <Tooltip label={m.scope === "user" ? "User-scope servers load in every project; turn one off for a project with /mcp inside a session" : "Local-scope server for this project"}>
                          <span className="dim">{m.enabled ? "loads" : "off"}</span>
                        </Tooltip>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Loadable>
        {health.result && <pre className="ctl-pre">{health.result.output || `(exit ${health.result.code})`}</pre>}
      </Section>

      {!project && (
        <Section title="Plugins" count={plugins.data?.length}>
          <Loadable state={plugins} empty="No plugins installed." isEmpty={(d) => d.length === 0}>
            {(d) => (
              <table className="ctl-table">
                <tbody>
                  {d.map((p) => (
                    <tr key={p.id}>
                      <td><b>{p.id}</b></td>
                      <td className="dim">{p.version}</td>
                      <td><Badge size="xs" variant="outline">{p.scope}</Badge></td>
                      <td><Switch size="xs" checked={p.enabled} onChange={() => void togglePlugin(p)} label={p.enabled ? "enabled" : "disabled"} /></td>
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

function GroupSection({ g, pending, busy, onAct }: { g: DockerProjectUsage; pending: boolean; busy: string | null; onAct: (id: string, name: string, action: "start" | "stop") => void }) {
  return (
    <Section title={g.label} actions={<b>{fmtBytes(g.sizeBytes)}</b>}>
      {g.projectPath && <div className="mono dim ctl-sub">{g.projectPath}</div>}
      {g.containers.length > 0 && (
        <table className="ctl-table">
          <thead>
            <tr><th>Container</th><th>Image</th><th>State</th><th>Size</th><th /></tr>
          </thead>
          <tbody>
            {g.containers.map((c) => (
              <tr key={c.id}>
                <td><b>{c.name}</b></td>
                <td className="mono dim">{c.image}</td>
                <td><Badge size="xs" variant="light" color={c.state === "running" ? "teal" : "gray"}>{c.status}</Badge></td>
                <td>{fmtBytes(c.sizeBytes)}</td>
                <td>
                  {c.state === "running" ? (
                    <Button size="compact-xs" variant="subtle" color="red" loading={busy === c.id} leftSection={<IconPlayerStop size={12} />} onClick={() => onAct(c.id, c.name, "stop")}>Stop</Button>
                  ) : (
                    <Button size="compact-xs" variant="subtle" loading={busy === c.id} leftSection={<IconPlayerPlay size={12} />} onClick={() => onAct(c.id, c.name, "start")}>Start</Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {g.volumes.length > 0 && (
        <table className="ctl-table">
          <thead>
            <tr><th>Volume</th><th>Size</th></tr>
          </thead>
          <tbody>
            {g.volumes.map((v) => (
              <tr key={v.name}>
                <td className="mono">{v.name}</td>
                <td>{pending ? "…" : fmtBytes(v.sizeBytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

const groupKey = (g: DockerProjectUsage) => g.projectPath ?? `compose:${g.label}`;

/** Two views: All (whole Docker footprint) and Project (pick one project; its containers, volumes and bulk controls). */
export function DockerPanel({ project, onError }: { project: ProjectItem | null; onError: (msg: string) => void }) {
  const report = useFetch<DockerReport>("/api/docker");
  const [confirmModal, ask] = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [view, setView] = useState<"all" | "project">(project ? "project" : "all");
  const [pick, setPick] = useState<string | null>(project?.path ?? null);

  // Volume sizes arrive from a slow background scan; poll until they land.
  useEffect(() => {
    if (!report.data?.volumesPending) return;
    const t = setTimeout(report.reload, 15_000);
    return () => clearTimeout(t);
  }, [report.data, report.reload]);

  const act = async (id: string, name: string, action: "start" | "stop") => {
    if (!(await ask(`${action === "stop" ? "Stop" : "Start"} container ${name}?`, action === "stop" ? "Stop" : "Start"))) return;
    setBusy(id);
    try {
      await api("POST", "/api/docker/action", { id, action });
      report.reload();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const bulk = async (g: DockerProjectUsage, action: "start" | "stop") => {
    const targets = g.containers.filter((c) => (action === "stop" ? c.state === "running" : c.state !== "running"));
    if (!targets.length) return;
    const verb = action === "stop" ? "Stop" : "Start";
    if (!(await ask(`${verb} ${targets.length} container(s) of ${g.label}?\n\n${targets.map((c) => c.name).join("\n")}`, `${verb} all`))) return;
    setBusy("bulk");
    try {
      for (const c of targets) await api("POST", "/api/docker/action", { id: c.id, action });
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(null);
      report.reload();
    }
  };

  return (
    <Loadable state={report} empty="">
      {(r) => {
        if (!r.available) return <div className="ctl-state error">Docker is not reachable: {r.error}</div>;
        const selected = r.groups.find((g) => groupKey(g) === pick) ?? null;
        const running = selected?.containers.filter((c) => c.state === "running").length ?? 0;
        const onAct = (id: string, n: string, a: "start" | "stop") => void act(id, n, a);
        return (
          <>
            {confirmModal}
            <div className="ctl-subtabs">
              <SegmentedControl size="xs" value={view} onChange={(v) => setView(v as "all" | "project")} data={[{ value: "all", label: `All · ${r.groups.length}` }, { value: "project", label: "Project" }]} />
              {view === "project" && (
                <Select
                  className="hud-input"
                  size="xs"
                  w={320}
                  searchable
                  placeholder="Pick a project"
                  aria-label="Docker project"
                  value={pick}
                  onChange={setPick}
                  data={r.groups.map((g) => ({ value: groupKey(g), label: `${g.label} · ${fmtBytes(g.sizeBytes)}` }))}
                  nothingFoundMessage="No such project"
                />
              )}
              <Button size="compact-xs" variant="subtle" ml="auto" onClick={report.reload}>Refresh</Button>
            </div>
            {r.volumesPending && <p className="ctl-note">Measuring volume sizes in the background (docker system df -v can take ~30 s)…</p>}

            {view === "all" && (
              <>
                <div className="ctl-stats">
                  <div><span className="dim">Images</span><b>{fmtBytes(r.imagesBytes)}</b></div>
                  <div><span className="dim">Build cache</span><b>{fmtBytes(r.buildCacheBytes)}</b></div>
                  <div><span className="dim">Projects using Docker</span><b>{r.groups.length}</b></div>
                  <div><span className="dim">Containers</span><b>{r.groups.reduce((n, g) => n + g.containers.length, 0)}</b></div>
                  <div><span className="dim">Volumes</span><b>{r.groups.reduce((n, g) => n + g.volumes.length, 0)}</b></div>
                </div>
                {r.groups.map((g) => <GroupSection key={groupKey(g)} g={g} pending={r.volumesPending} busy={busy} onAct={onAct} />)}
              </>
            )}

            {view === "project" && !selected && <div className="ctl-state">{pick ? "This project has no containers or volumes." : "Pick a project above to see its containers and volumes."}</div>}
            {view === "project" && selected && (
              <>
                <div className="ctl-stats">
                  <div><span className="dim">Disk used</span><b>{fmtBytes(selected.sizeBytes)}</b></div>
                  <div><span className="dim">Running</span><b>{running} / {selected.containers.length}</b></div>
                  <div><span className="dim">Volumes</span><b>{selected.volumes.length}</b></div>
                  <div className="ctl-stat-actions">
                    <Button size="compact-sm" variant="light" leftSection={<IconPlayerPlay size={13} />} loading={busy === "bulk"} disabled={running === selected.containers.length} onClick={() => void bulk(selected, "start")}>Start all</Button>
                    <Button size="compact-sm" variant="light" color="red" leftSection={<IconPlayerStop size={13} />} loading={busy === "bulk"} disabled={running === 0} onClick={() => void bulk(selected, "stop")}>Stop all</Button>
                  </div>
                </div>
                <GroupSection g={selected} pending={r.volumesPending} busy={busy} onAct={onAct} />
              </>
            )}
          </>
        );
      }}
    </Loadable>
  );
}
