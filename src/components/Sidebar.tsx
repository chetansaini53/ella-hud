import { Button, ScrollArea, Skeleton, TextInput } from "@mantine/core";
import { IconRefresh, IconSearch } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import type { EvolutionItem, HistoryItem, WorkerView } from "../../shared/types.ts";
import { dayGroup, hhmm } from "../format.ts";

export type SideTab = "active" | "cooked" | "evolution";

interface Row {
  id: string;
  title: string;
  meta: string;
  search: string;
  at: number;
  tooltip?: string;
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

export function Sidebar(p: Props) {
  const [query, setQuery] = useState("");

  const rows = useMemo<Row[] | null>(() => {
    if (p.tab === "active") {
      return [...p.workers]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((w) => ({ id: w.id, title: w.title, meta: `${w.location.split(" / ").pop()}, ${hhmm(w.updatedAt)}, ${w.status}`, search: `${w.title} ${w.location}`, at: w.updatedAt }));
    }
    if (p.tab === "cooked") {
      return p.history.data?.map((h) => ({ id: h.id, title: h.title, meta: `${h.project}, ${hhmm(h.at)}, ${h.asks} asks`, search: `${h.title} ${h.project}`, at: h.at })) ?? null;
    }
    return p.evolution.data?.map((e) => ({ id: e.id, title: e.title, meta: `${e.project}, ${hhmm(e.at)}`, search: `${e.title} ${e.detail} ${e.project}`, at: e.at, tooltip: e.detail })) ?? null;
  }, [p.tab, p.workers, p.history.data, p.evolution.data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows && q ? rows.filter((r) => r.search.toLowerCase().includes(q)) : rows;
  }, [rows, query]);

  const error = p.tab === "cooked" ? p.history.error : p.tab === "evolution" ? p.evolution.error : null;
  const counts: Record<SideTab, number | string> = {
    active: p.workers.length,
    cooked: p.history.data?.length ?? "…",
    evolution: p.evolution.data?.length ?? "…",
  };

  const pick = (id: string) => {
    if (p.tab === "active") p.onPickWorker(id);
    else if (p.tab === "cooked") {
      const item = p.history.data?.find((h) => h.id === id);
      if (item) p.onPickHistory(item);
    }
  };

  let lastGroup = "";
  return (
    <aside className="left" aria-label="Sessions">
      <div className="tabs" role="tablist">
        {(["active", "cooked", "evolution"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={p.tab === t} className={`tab ${p.tab === t ? "active" : ""}`} onClick={() => p.onTab(t)}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
            <span className="n">{counts[t]}</span>
          </button>
        ))}
      </div>
      <div className="search hud-input">
        <TextInput
          aria-label="Search by project, title or ask"
          placeholder="Search by project, title or ask"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          rightSection={<IconSearch size={14} color="var(--hud-text-dim)" />}
        />
      </div>
      <ScrollArea className="list" type="hover" scrollbarSize={6}>
        {error && (
          <div className="list-state">
            {error}
            <Button variant="subtle" size="xs" leftSection={<IconRefresh size={14} />} onClick={p.onRetry}>
              Retry
            </Button>
          </div>
        )}
        {!error && filtered === null && (
          <div className="list-state">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} style={{ marginBottom: 14 }}>
                <Skeleton height={13} width="85%" mb={6} />
                <Skeleton height={10} width="55%" />
              </div>
            ))}
          </div>
        )}
        {filtered?.length === 0 && (
          <div className="list-state">
            {query ? "Nothing matches that search." : p.tab === "active" ? "No workers in this session yet — press + to start one." : "Nothing here yet."}
          </div>
        )}
        {filtered?.map((r) => {
          const group = dayGroup(r.at, p.now);
          const showGroup = group !== lastGroup;
          lastGroup = group;
          const clickable = p.tab !== "evolution";
          return (
            <div key={r.id}>
              {showGroup && <div className="group-label">{group}</div>}
              <button
                type="button"
                className={`item ${p.tab === "active" && r.id === p.selectedWorkerId ? "selected" : ""}`}
                onClick={() => pick(r.id)}
                disabled={!clickable}
                title={r.tooltip ?? (p.tab === "cooked" ? "Open as a worker (forks the session — the original stays untouched)" : undefined)}
                style={clickable ? undefined : { cursor: "default" }}
              >
                <div className="item-title">{r.title}</div>
                <div className="item-meta">{r.meta}</div>
              </button>
            </div>
          );
        })}
      </ScrollArea>
    </aside>
  );
}
