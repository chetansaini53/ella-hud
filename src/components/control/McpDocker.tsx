import { Badge, Button, SegmentedControl, Select, Switch, TextInput, Tooltip } from "@mantine/core";
import { IconHeartbeat, IconPlayerPlay, IconPlayerStop, IconSearch, IconTrash } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type { ClaudeConfigView, CommandResult, DockerProjectUsage, DockerPrune, DockerReport, PluginInfo, ProjectItem } from "../../../shared/types.ts";
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

type Act = (id: string, name: string, action: "start" | "stop" | "remove") => void;

function GroupSection({ g, pending, busy, onAct, onRemoveVolume }: { g: DockerProjectUsage; pending: boolean; busy: string | null; onAct: Act; onRemoveVolume: (name: string) => void }) {
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
                <td className="nowrap">
                  {c.state === "running" ? (
                    <Button size="compact-xs" variant="subtle" color="red" loading={busy === c.id} leftSection={<IconPlayerStop size={12} />} onClick={() => onAct(c.id, c.name, "stop")}>Stop</Button>
                  ) : (
                    <Button size="compact-xs" variant="subtle" loading={busy === c.id} leftSection={<IconPlayerPlay size={12} />} onClick={() => onAct(c.id, c.name, "start")}>Start</Button>
                  )}
                  <Tooltip label={c.state === "running" ? "Stop it first" : "Delete this container"}>
                    <span>
                      <Button size="compact-xs" variant="subtle" color="red" disabled={c.state === "running" || busy === c.id} leftSection={<IconTrash size={12} />} onClick={() => onAct(c.id, c.name, "remove")}>Remove</Button>
                    </span>
                  </Tooltip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {g.volumes.length > 0 && (
        <table className="ctl-table">
          <thead>
            <tr><th>Volume</th><th>Size</th><th /></tr>
          </thead>
          <tbody>
            {g.volumes.map((v) => (
              <tr key={v.name}>
                <td className="mono">{v.name}</td>
                <td>{pending ? "…" : fmtBytes(v.sizeBytes)}</td>
                <td className="nowrap">
                  <Tooltip label="Delete this volume and its data (Docker refuses if a container still uses it)">
                    <Button size="compact-xs" variant="subtle" color="red" loading={busy === `vol:${v.name}`} leftSection={<IconTrash size={12} />} onClick={() => onRemoveVolume(v.name)}>Remove</Button>
                  </Tooltip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function CleanupRow({ title, detail, size, action, danger, busy, locked, onRun }: { title: string; detail: string; size: string; action: string; danger?: boolean; busy: boolean; locked: boolean; onRun: () => void }) {
  return (
    <tr>
      <td><b>{title}</b><div className="dim">{detail}</div></td>
      <td className="nowrap">{size}</td>
      <td className="nowrap">
        <Button size="compact-xs" variant="light" color={danger ? "red" : "hud"} loading={busy} disabled={locked && !busy} leftSection={<IconTrash size={12} />} onClick={onRun}>{action}</Button>
      </td>
    </tr>
  );
}

const groupKey = (g: DockerProjectUsage) => g.projectPath ?? `compose:${g.label}`;
/** `docker rm` without -f only takes containers in these states. */
const REMOVABLE = new Set(["exited", "created"]);

/** Narrows a group to what matches the search (container, image, volume or the group's own name). */
function filterGroup(g: DockerProjectUsage, q: string): DockerProjectUsage | null {
  if (!q) return g;
  if (g.label.toLowerCase().includes(q)) return g;
  const containers = g.containers.filter((c) => `${c.name} ${c.image}`.toLowerCase().includes(q));
  const volumes = g.volumes.filter((v) => v.name.toLowerCase().includes(q));
  return containers.length || volumes.length ? { ...g, containers, volumes } : null;
}

/** Two views: All (whole Docker footprint, search, global cleanup) and Project (one project's containers, volumes, cleanup). */
export function DockerPanel({ project, onError }: { project: ProjectItem | null; onError: (msg: string) => void }) {
  const report = useFetch<DockerReport>("/api/docker");
  const [confirmModal, ask] = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [view, setView] = useState<"all" | "project">(project ? "project" : "all");
  const [pick, setPick] = useState<string | null>(project?.path ?? null);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<string | null>(null);

  // Volume sizes arrive from a slow background scan; poll until they land.
  useEffect(() => {
    if (!report.data?.volumesPending) return;
    const t = setTimeout(report.reload, 15_000);
    return () => clearTimeout(t);
  }, [report.data, report.reload]);

  useEffect(() => setResult(null), [view, pick]);

  const call = async (key: string, fn: () => Promise<unknown>) => {
    setResult(null);
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(null);
      report.reload();
    }
  };

  const act: Act = async (id, name, action) => {
    const msg = action === "remove" ? `Delete container ${name}?\n\nThis cannot be undone. Its volumes are kept.` : `${action === "stop" ? "Stop" : "Start"} container ${name}?`;
    const label = action === "remove" ? "Delete" : action === "stop" ? "Stop" : "Start";
    if (!(await ask(msg, label))) return;
    await call(id, () => api("POST", "/api/docker/action", { id, action }, 70_000));
  };

  const removeVolume = async (name: string) => {
    if (!(await ask(`Delete volume ${name}?\n\nEverything stored in it (databases, uploads…) is deleted. This cannot be undone.`, "Delete volume"))) return;
    await call(`vol:${name}`, () => api("POST", "/api/docker/volume-remove", { name }, 70_000));
  };

  const pruneAll = async (target: DockerPrune, what: string, warning: string) => {
    if (!(await ask(`${what}?\n\n${warning}\nThis cannot be undone.`, "Clean up"))) return;
    await call(`prune:${target}`, async () => {
      const r = await api<{ output: string }>("POST", "/api/docker/prune", { target }, 610_000);
      setResult(`${what}: ${r.output}`);
    });
  };

  const bulk = async (g: DockerProjectUsage, action: "start" | "stop" | "remove") => {
    const targets = g.containers.filter((c) => (action === "start" ? c.state !== "running" : action === "stop" ? c.state === "running" : REMOVABLE.has(c.state)));
    if (!targets.length) return;
    const verb = action === "remove" ? "Delete" : action === "stop" ? "Stop" : "Start";
    const extra = action === "remove" ? "\n\nThis cannot be undone. Volumes are kept." : "";
    if (!(await ask(`${verb} ${targets.length} container(s) of ${g.label}?\n\n${targets.map((c) => c.name).join("\n")}${extra}`, `${verb} all`))) return;
    await call("bulk", async () => {
      const failed: string[] = [];
      for (const c of targets) await api("POST", "/api/docker/action", { id: c.id, action }, 70_000).catch((e: Error) => failed.push(`${c.name} (${e.message})`));
      setResult(`${verb}: ${targets.length - failed.length} done${failed.length ? `; failed: ${failed.join(", ")}` : ""}`);
    });
  };

  const removeProjectVolumes = async (g: DockerProjectUsage) => {
    if (!g.volumes.length) return;
    if (!(await ask(`Delete ${g.volumes.length} volume(s) of ${g.label}?\n\n${g.volumes.map((v) => v.name).join("\n")}\n\nAll data in them is deleted. Volumes a container still uses are skipped. This cannot be undone.`, "Delete volumes"))) return;
    await call("bulk", async () => {
      const kept: string[] = [];
      const failed: string[] = [];
      for (const v of g.volumes) {
        await api("POST", "/api/docker/volume-remove", { name: v.name }, 70_000).catch((e: Error) => (/in use/i.test(e.message) ? kept : failed).push(/in use/i.test(e.message) ? v.name : `${v.name} (${e.message})`));
      }
      const deleted = g.volumes.length - kept.length - failed.length;
      setResult(`Deleted ${deleted} volume(s)${kept.length ? `; kept (in use): ${kept.join(", ")}` : ""}${failed.length ? `; failed: ${failed.join(", ")}` : ""}`);
    });
  };

  return (
    <Loadable state={report} empty="">
      {(r) => {
        if (!r.available) return <div className="ctl-state error">Docker is not reachable: {r.error}</div>;
        const selected = r.groups.find((g) => groupKey(g) === pick) ?? null;
        const running = selected?.containers.filter((c) => c.state === "running").length ?? 0;
        const stopped = selected?.containers.filter((c) => REMOVABLE.has(c.state)).length ?? 0;
        const locked = busy !== null;
        const q = query.trim().toLowerCase();
        const shown = r.groups.map((g) => filterGroup(g, q)).filter((g): g is DockerProjectUsage => g !== null);
        const onAct: Act = (id, n, a) => void act(id, n, a);
        const onVol = (n: string) => void removeVolume(n);
        return (
          <>
            {confirmModal}
            <div className="ctl-subtabs">
              <SegmentedControl size="xs" value={view} onChange={(v) => setView(v as "all" | "project")} data={[{ value: "all", label: `All · ${r.groups.length}` }, { value: "project", label: "Project" }]} />
              {view === "all" ? (
                <TextInput className="hud-input" size="xs" w={320} aria-label="Search containers, images and volumes" placeholder="Search containers, images, volumes, projects…" value={query} onChange={(e) => setQuery(e.currentTarget.value)} leftSection={<IconSearch size={13} />} />
              ) : (
                <Select className="hud-input" size="xs" w={320} searchable placeholder="Pick a project" aria-label="Docker project" value={pick} onChange={setPick} data={r.groups.map((g) => ({ value: groupKey(g), label: `${g.label} · ${fmtBytes(g.sizeBytes)}` }))} nothingFoundMessage="No such project" />
              )}
              <Button size="compact-xs" variant="subtle" ml="auto" onClick={report.reload}>Refresh</Button>
            </div>
            {r.volumesPending && <p className="ctl-note">Measuring volume sizes in the background (docker system df -v can take ~30 s)…</p>}
            {result && <p className="ctl-note ok">{result}</p>}

            {view === "all" && (
              <>
                <div className="ctl-stats">
                  <div><span className="dim">Images</span><b>{fmtBytes(r.imagesBytes)}</b></div>
                  <div><span className="dim">Build cache</span><b>{fmtBytes(r.buildCacheBytes)}</b></div>
                  <div><span className="dim">Projects using Docker</span><b>{r.groups.length}</b></div>
                  <div><span className="dim">Containers</span><b>{r.groups.reduce((n, g) => n + g.containers.length, 0)}</b></div>
                  <div><span className="dim">Volumes</span><b>{r.groups.reduce((n, g) => n + g.volumes.length, 0)}</b></div>
                </div>
                {q && shown.length === 0 && <div className="ctl-state">Nothing matches “{query}”.</div>}
                {shown.map((g) => <GroupSection key={groupKey(g)} g={g} pending={r.volumesPending} busy={busy} onAct={onAct} onRemoveVolume={onVol} />)}
                <Section title="Free up disk space">
                  <table className="ctl-table">
                    <tbody>
                      <CleanupRow title="Dangling images" detail={`${r.danglingImages} untagged leftovers from old builds found; any still used by a container are kept`} size="" action="Remove" locked={locked} busy={busy === "prune:dangling-images"} onRun={() => void pruneAll("dangling-images", "Remove dangling images", "Untagged images no container uses are deleted.")} />
                      <CleanupRow title="Build cache" detail="Cached layers from docker build / compose build" size={`${fmtBytes(r.reclaimable.buildCache)} reclaimable`} action="Clear" locked={locked} busy={busy === "prune:build-cache"} onRun={() => void pruneAll("build-cache", "Clear build cache", "Next builds will be slower the first time.")} />
                      <CleanupRow title="Stopped containers" detail="Every container that is not running" size={`${fmtBytes(r.reclaimable.containers)} reclaimable`} action="Remove" danger locked={locked} busy={busy === "prune:stopped-containers"} onRun={() => void pruneAll("stopped-containers", "Remove all stopped containers", "Every stopped container on this machine is deleted (their volumes are kept).")} />
                      <CleanupRow title="Unused anonymous volumes" detail="Unnamed volumes no container uses" size={`up to ${fmtBytes(r.reclaimable.volumes)} unused`} action="Remove" danger locked={locked} busy={busy === "prune:anonymous-volumes"} onRun={() => void pruneAll("anonymous-volumes", "Remove unused anonymous volumes", "Data in unnamed volumes that no container uses is deleted. Named volumes are kept.")} />
                      <CleanupRow title="All unused images" detail="Images no container uses; they download again when needed" size={`${fmtBytes(r.reclaimable.images)} reclaimable`} action="Remove" danger locked={locked} busy={busy === "prune:unused-images"} onRun={() => void pruneAll("unused-images", "Remove all unused images", "Every image without a container is deleted and must be pulled or rebuilt again.")} />
                    </tbody>
                  </table>
                </Section>
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
                    <Button size="compact-sm" variant="light" leftSection={<IconPlayerPlay size={13} />} loading={busy === "bulk"} disabled={stopped === 0} onClick={() => void bulk(selected, "start")}>Start all</Button>
                    <Button size="compact-sm" variant="light" color="red" leftSection={<IconPlayerStop size={13} />} loading={busy === "bulk"} disabled={running === 0} onClick={() => void bulk(selected, "stop")}>Stop all</Button>
                  </div>
                </div>
                <GroupSection g={selected} pending={r.volumesPending} busy={busy} onAct={onAct} onRemoveVolume={onVol} />
                <Section title={`Free up disk space · ${selected.label}`}>
                  <table className="ctl-table">
                    <tbody>
                      <CleanupRow title={`Stopped containers (${stopped})`} detail="This project's exited or created containers" size="" action="Remove" danger locked={locked} busy={busy === "bulk"} onRun={() => void bulk(selected, "remove")} />
                      <CleanupRow title={`Project volumes (${selected.volumes.length})`} detail="Deletes their data; volumes still in use are skipped" size={r.volumesPending ? "measuring…" : fmtBytes(selected.volumes.reduce((n, v) => n + v.sizeBytes, 0))} action="Remove" danger locked={locked} busy={busy === "bulk"} onRun={() => void removeProjectVolumes(selected)} />
                    </tbody>
                  </table>
                </Section>
              </>
            )}
          </>
        );
      }}
    </Loadable>
  );
}
