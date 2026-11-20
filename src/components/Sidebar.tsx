import { Button, Combobox, ScrollArea, Skeleton, TextInput, useCombobox } from "@mantine/core";
import { IconBolt, IconChevronDown, IconChevronRight, IconHistory, IconRefresh, IconSearch } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import type { EvolutionItem, HistoryItem, WorkerView } from "../../shared/types.ts";
import { ago, hhmm } from "../format.ts";
import { rankMatches } from "../search.ts";

export type SideTab = "active" | "done" | "evolution";

interface Row {
  id: string;
  title: string;
  group: string;
  meta: string;
  at: number;
  tooltip?: string;
}

interface Hit extends Row {
  kind: "worker" | "session";
}

export interface Loadable<T> {
  data: T[] | null;
  error: string | null;
}

interface Props {
  tab: SideTab;
  onTab: (tab: SideTab) => void;
  workers: WorkerView[];
  history: Loadable<HistoryItem>;
  evolution: Loadable<EvolutionItem>;
  selectedWorkerId: string | null;
  now: number;
  onPickWorker: (id: string) => void;
  onPickHistory: (item: HistoryItem) => void;
  onRetry: () => void;
}

const OPEN_BY_DEFAULT = 4;
const workerProject = (w: WorkerView) => w.location.split(" / ").pop() ?? w.location;

/** Rows grouped by project, groups ordered by their most recent activity. */
function groupRows(rows: Row[]): { name: string; rows: Row[]; at: number }[] {
  const map = new Map<string, Row[]>();
  for (const r of rows) map.set(r.group, [...(map.get(r.group) ?? []), r]);
  return [...map.entries()]
    .map(([name, list]) => {
      const sorted = list.sort((a, b) => b.at - a.at);
      return { name, rows: sorted, at: sorted[0]?.at ?? 0 };
    })
    .sort((a, b) => b.at - a.at);
}

export function Sidebar(p: Props) {
  const [query, setQuery] = useState("");
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const combobox = useCombobox({ onDropdownClose: () => combobox.resetSelectedOption() });

  const rows = useMemo<Row[] | null>(() => {
    if (p.tab === "active") {
      return p.workers.map((w) => ({ id: w.id, title: w.title, group: workerProject(w), meta: `${hhmm(w.updatedAt)} · ${w.status}`, at: w.updatedAt }));
    }
    if (p.tab === "done") {
      return p.history.data?.map((h) => ({ id: h.id, title: h.title, group: h.project, meta: `${hhmm(h.at)} · ${h.asks} asks`, at: h.at })) ?? null;
    }
    return p.evolution.data?.map((e) => ({ id: e.id, title: e.title, group: e.project, meta: hhmm(e.at), at: e.at, tooltip: e.detail })) ?? null;
  }, [p.tab, p.workers, p.history.data, p.evolution.data]);

  // Quick search spans live workers and every recent session, whatever tab is open.
  const hits = useMemo<Hit[]>(() => {
    const pool: Hit[] = [
      ...p.workers.map((w) => ({ id: w.id, kind: "worker" as const, title: w.title, group: workerProject(w), meta: w.status, at: w.updatedAt })),
      ...(p.history.data ?? []).map((h) => ({ id: h.id, kind: "session" as const, title: h.title, group: h.project, meta: `${h.asks} asks`, at: h.at })),
    ];
    return rankMatches(pool, query, 8);
  }, [p.workers, p.history.data, query]);

  const filtered = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return rows && words.length ? rows.filter((r) => words.every((w) => `${r.title} ${r.group}`.toLowerCase().includes(w))) : rows;
  }, [rows, query]);
  const groups = useMemo(() => (filtered ? groupRows(filtered) : null), [filtered]);

  const error = p.tab === "done" ? p.history.error : p.tab === "evolution" ? p.evolution.error : null;
  const counts: Record<SideTab, number | string> = { active: p.workers.length, done: p.history.data?.length ?? "…", evolution: p.evolution.data?.length ?? "…" };

  const openRow = (id: string) => {
    if (p.tab === "active") p.onPickWorker(id);
    else if (p.tab === "done") {
      const item = p.history.data?.find((h) => h.id === id);
      if (item) p.onPickHistory(item);
    }
  };
  const openHit = (key: string) => {
    const [kind, id] = key.split("|");
    if (kind === "worker" && id) p.onPickWorker(id);
    const item = kind === "session" ? p.history.data?.find((h) => h.id === id) : undefined;
    if (item) p.onPickHistory(item);
    setQuery("");
    combobox.closeDropdown();
  };
  const isOpen = (name: string, index: number) => Boolean(query.trim()) || (index < OPEN_BY_DEFAULT) !== toggled.has(name);
  const toggle = (name: string) => setToggled((s) => {
    const next = new Set(s);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    return next;
  });

  return (
    <aside className="left" aria-label="Sessions">
      <div className="tabs" role="tablist">
        {(["active", "done", "evolution"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={p.tab === t} className={`tab ${p.tab === t ? "active" : ""}`} onClick={() => p.onTab(t)}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
            <span className="n">{counts[t]}</span>
          </button>
        ))}
      </div>

      <div className="search hud-input">
        <Combobox store={combobox} onOptionSubmit={openHit} withinPortal={false}>
          <Combobox.Target>
            <TextInput
              aria-label="Quick search sessions"
              placeholder="Quick search sessions…"
              value={query}
              onChange={(e) => {
                setQuery(e.currentTarget.value);
                combobox.openDropdown();
                combobox.updateSelectedOptionIndex();
              }}
              onFocus={() => query && combobox.openDropdown()}
              onBlur={() => combobox.closeDropdown()}
              rightSection={<IconSearch size={14} color="var(--hud-text-dim)" />}
            />
          </Combobox.Target>
          <Combobox.Dropdown hidden={!query.trim()} className="quick-drop">
            <Combobox.Options>
              {hits.length === 0 && <Combobox.Empty>No session matches “{query}”</Combobox.Empty>}
              {hits.map((h) => (
                <Combobox.Option key={`${h.kind}|${h.id}`} value={`${h.kind}|${h.id}`} className="quick-opt">
                  <span className="quick-icon">{h.kind === "worker" ? <IconBolt size={13} /> : <IconHistory size={13} />}</span>
                  <span className="quick-text">
                    <span className="quick-title">{h.title}</span>
                    <span className="quick-meta">{h.group} · {h.meta} · {ago(h.at, p.now)}</span>
                  </span>
                </Combobox.Option>
              ))}
            </Combobox.Options>
          </Combobox.Dropdown>
        </Combobox>
      </div>

      <ScrollArea className="list" type="hover" scrollbarSize={6}>
        {error && (
          <div className="list-state">
            {error}
            <Button variant="subtle" size="xs" leftSection={<IconRefresh size={14} />} onClick={p.onRetry}>Retry</Button>
          </div>
        )}
        {!error && groups === null && (
          <div className="list-state">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} style={{ marginBottom: 14 }}>
                <Skeleton height={12} width="50%" mb={8} />
                <Skeleton height={13} width="85%" mb={6} />
                <Skeleton height={10} width="40%" />
              </div>
            ))}
          </div>
        )}
        {groups?.length === 0 && (
          <div className="list-state">
            {query ? "Nothing matches that search." : p.tab === "active" ? "No workers in this session yet — press + to start one." : "Nothing here yet."}
          </div>
        )}
        {groups?.map((g, i) => {
          const open = isOpen(g.name, i);
          return (
            <div key={g.name} className="side-group">
              <button type="button" className="side-group-head" onClick={() => toggle(g.name)} aria-expanded={open}>
                {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
                <span className="side-group-name">{g.name}</span>
                <span className="side-group-count">{g.rows.length}</span>
              </button>
              {open &&
                g.rows.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className={`item ${p.tab === "active" && r.id === p.selectedWorkerId ? "selected" : ""}`}
                    onClick={() => openRow(r.id)}
                    disabled={p.tab === "evolution"}
                    title={r.tooltip ?? (p.tab === "done" ? "Open as a worker (forks the session — the original stays untouched)" : undefined)}
                  >
                    <div className="item-title">{r.title}</div>
                    <div className="item-meta">{r.meta}</div>
                  </button>
                ))}
            </div>
          );
        })}
      </ScrollArea>
    </aside>
  );
}
