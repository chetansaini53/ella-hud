import { Notification } from "@mantine/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EvolutionItem, HistoryItem, TodoItem, WorkerView } from "../shared/types.ts";
import { api, useHud } from "./api.ts";
import { WorkingOn } from "./components/CookingNow.tsx";
import { ControlCenter } from "./components/control/ControlCenter.tsx";
import { Header } from "./components/Header.tsx";
import { NewWorkerModal, type NewWorkerInput } from "./components/NewWorkerModal.tsx";
import { MeetingsModal, TodoModal } from "./components/PlannerModals.tsx";
import { InstanceModal, type Detected } from "./components/InstanceModal.tsx";
import { Orb, type OrbPhase } from "./components/Orb.tsx";
import { RightPanel, type InputMode } from "./components/RightPanel.tsx";
import { Sidebar, type Loadable, type SideTab } from "./components/Sidebar.tsx";
import { useVoice } from "./voice.ts";

const LANG_KEY = "ella.lang";
const BUSY = new Set<WorkerView["status"]>(["working", "starting"]);

function readLang(): string {
  try {
    return localStorage.getItem(LANG_KEY) ?? "en-IN";
  } catch {
    return "en-IN";
  }
}

function lastAssistant(w: WorkerView | undefined): string {
  return [...(w?.messages ?? [])].reverse().find((m) => m.role === "assistant")?.text ?? "";
}

export function App() {
  const hud = useHud();
  const [now, setNow] = useState(Date.now());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<SideTab>("done");
  const [history, setHistory] = useState<Loadable<HistoryItem>>({ data: null, error: null });
  const [evolution, setEvolution] = useState<Loadable<EvolutionItem>>({ data: null, error: null });
  const [todos, setTodos] = useState<TodoItem[] | null>(null);
  const [micOn, setMicOn] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(true);
  const [announceAll, setAnnounceAll] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [view, setView] = useState<"hud" | "control">("hud");
  const [planner, setPlanner] = useState<"meetings" | "todo" | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const name = hud.instance?.name ?? "Ella";
  const claudeLabel = hud.instance ? `${hud.instance.configDir.split(/[\/]/).pop()} · ${hud.instance.bin.split(/[\/]/).pop()}` : "…";

  useEffect(() => {
    document.title = name;
  }, [name]);

  // First run with more than one Claude on the machine: ask which one before anything else.
  const askedSetup = useRef(false);
  useEffect(() => {
    if (!hud.instance || hud.instance.saved || askedSetup.current) return;
    askedSetup.current = true;
    api<Detected>("GET", "/api/instance/detect").then(
      (d) => (d.binaries.length > 1 || d.profiles.length > 1) && setSetupOpen(true),
      () => undefined,
    );
  }, [hud.instance]);
  const [lang, setLang] = useState(readLang);
  const [mode, setMode] = useState<InputMode>("talk");
  const [draft, setDraft] = useState("");
  const [modal, setModal] = useState<{ opened: boolean; task: string }>({ opened: false, task: "" });
  const [talkingId, setTalkingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const selected = hud.workers.find((w) => w.id === selectedId) ?? null;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  // Keep a worker selected whenever one exists.
  useEffect(() => {
    if (!selected && hud.workers.length) setSelectedId(hud.workers[hud.workers.length - 1]?.id ?? null);
  }, [selected, hud.workers]);

  const loadLists = useCallback(() => {
    api<HistoryItem[]>("GET", "/api/history").then(
      (data) => setHistory({ data, error: null }),
      (err: Error) => setHistory((h) => ({ data: h.data, error: err.message })),
    );
    api<EvolutionItem[]>("GET", "/api/evolution").then(
      (data) => setEvolution({ data, error: null }),
      (err: Error) => setEvolution((e) => ({ data: e.data, error: err.message })),
    );
  }, []);

  useEffect(() => {
    loadLists();
    api<TodoItem[]>("GET", "/api/todos").then(setTodos, (err: Error) => setToast(err.message));
    const t = setInterval(loadLists, 60_000);
    return () => clearInterval(t);
  }, [loadLists]);

  const send = useCallback(
    async (text: string, worker: WorkerView | null) => {
      if (!worker) return setModal({ opened: true, task: text });
      try {
        await api("POST", `/api/workers/${worker.id}/messages`, { text });
      } catch (err) {
        setToast((err as Error).message);
        setDraft((d) => (d ? `${d}\n${text}` : text));
      }
    },
    [],
  );

  const onFinal = useCallback(
    (text: string) => {
      if (mode === "collect" || (selected && BUSY.has(selected.status))) {
        setDraft((d) => (d ? `${d}\n${text}` : text));
        return;
      }
      void send(text, selected);
    },
    [mode, selected, send],
  );

  const voice = useVoice({ lang, listen: micOn, onFinal });

  // Speak when a worker finishes a turn.
  const prevStatus = useRef(new Map<string, WorkerView["status"]>());
  useEffect(() => {
    let finished = false;
    const live = new Set(hud.workers.map((w) => w.id));
    for (const id of prevStatus.current.keys()) if (!live.has(id)) prevStatus.current.delete(id);
    for (const w of hud.workers) {
      const before = prevStatus.current.get(w.id);
      prevStatus.current.set(w.id, w.status);
      // A turn ending on its own (not you pressing Stop) gets read out.
      if (!before || !BUSY.has(before) || BUSY.has(w.status) || w.status === "stopped") continue;
      finished = true;
      if (!speakerOn) continue;
      if (w.id === selectedId) {
        const text = w.status === "idle" ? lastAssistant(w) : (w.messages.at(-1)?.text ?? "");
        setTalkingId(w.id);
        voice.speak(text || `${w.title} is done.`, () => setTalkingId(null));
      } else if (announceAll) {
        voice.speak(`${w.title.slice(0, 60)} — ${w.status === "idle" ? "done" : w.status.replace("-", " ")}.`);
      }
    }
    if (finished) loadLists();
  }, [hud.workers, selectedId, speakerOn, announceAll, voice.speak, loadLists]);

  const create = async (input: NewWorkerInput) => {
    const w = await api<WorkerView>("POST", "/api/workers", input);
    setSelectedId(w.id);
    setTab("active");
  };

  const openHistory = async (item: HistoryItem) => {
    try {
      const w = await api<WorkerView>("POST", "/api/workers", { resumeSessionId: item.id, cwd: item.cwd, title: item.title });
      setSelectedId(w.id);
      setView("hud");
    } catch (err) {
      setToast((err as Error).message);
    }
  };

  const sendDraft = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void send(text, selected);
  };

  const stop = () => {
    if (!selected) return;
    voice.cancelSpeech();
    api("POST", `/api/workers/${selected.id}/stop`).catch((err: Error) => setToast(err.message));
  };

  const addTodo = async (text: string) => {
    try {
      setTodos(await api<TodoItem[]>("POST", "/api/todos", { text }));
    } catch (err) {
      setToast((err as Error).message);
    }
  };

  const toggleTodo = (id: string, done: boolean) => {
    api<TodoItem[]>("PATCH", `/api/todos/${id}`, { done }).then(setTodos, (err: Error) => setToast(err.message));
  };

  const changeLang = (l: string) => {
    setLang(l);
    try {
      localStorage.setItem(LANG_KEY, l);
    } catch {
      // storage unavailable (private window) — the choice still applies for this visit
    }
  };

  const needsYou = hud.workers.filter((w) => w.status === "needs-you" || w.status === "error");
  const anyWorking = hud.workers.some((w) => BUSY.has(w.status));
  const orbPhase: OrbPhase = voice.phase === "speaking" ? "speaking" : voice.phase === "listening" ? "listening" : anyWorking ? "thinking" : "idle";
  const phaseLabel = { speaking: "Speaking", listening: "Listening", thinking: "Working", idle: "Standing by" }[orbPhase];
  const caption =
    (voice.phase === "speaking" && voice.spoken) ||
    (voice.phase === "listening" && voice.interim) ||
    (selected && BUSY.has(selected.status) && selected.activity) ||
    voice.error ||
    lastAssistant(selected ?? undefined).split("\n")[0]?.slice(0, 160) ||
    (selected ? "Waiting for your next ask." : "Press + to start a worker, or unmute the mic and talk.");

  const recentCwds = useMemo(() => [...new Set((history.data ?? []).map((h) => h.cwd).filter(Boolean))], [history.data]);
  const project = selected?.location.split(" / ").pop();

  return (
    <div className="hud">
      <Header
        now={now}
        connected={hud.connected}
        vpn={hud.vpn}
        needsYou={needsYou.length}
        usage={hud.usage}
        config={hud.config}
        micOn={micOn}
        speakerOn={speakerOn}
        announceAll={announceAll}
        rightOpen={rightOpen}
        controlOpen={view === "control"}
        openTodos={todos?.filter((t) => !t.done).length ?? 0}
        lang={lang}
        name={name}
        claudeLabel={claudeLabel}
        onSetup={() => setSetupOpen(true)}
        onToggleMic={() => {
          voice.clearError();
          setMicOn((m) => !m);
        }}
        onToggleSpeaker={() => {
          if (speakerOn) voice.cancelSpeech();
          setSpeakerOn((s) => !s);
        }}
        onToggleAnnounceAll={() => setAnnounceAll((a) => !a)}
        onToggleRight={() => setRightOpen((r) => !r)}
        onToggleControl={() => setView((v) => (v === "hud" ? "control" : "hud"))}
        onMeetings={() => setPlanner("meetings")}
        onTodos={() => setPlanner("todo")}
        onNewWorker={() => setModal({ opened: true, task: "" })}
        onNeedsYou={() => needsYou[0] && setSelectedId(needsYou[0].id)}
        onLang={changeLang}
      />

      {view === "control" && <ControlCenter now={now} tasks={hud.tasks} onOpenWorker={(h) => void openHistory(h)} onError={setToast} />}

      {view === "hud" && <WorkingOn workers={hud.workers} selectedId={selectedId} talkingId={talkingId} now={now} onSelect={setSelectedId} onNewWorker={() => setModal({ opened: true, task: "" })} />}

      {view === "hud" && <div className={`hud-body ${rightOpen ? "" : "no-right"}`}>
        <Sidebar
          tab={tab}
          onTab={setTab}
          workers={hud.workers}
          history={history}
          evolution={evolution}
          selectedWorkerId={selectedId}
          now={now}
          onPickWorker={setSelectedId}
          onPickHistory={(h) => void openHistory(h)}
          onRetry={loadLists}
        />

        <main className="center">
          <div className="talking-to">
            {selected ? (
              <>
                Talking to <b>{project}: {selected.title}</b>
              </>
            ) : (
              "No worker selected"
            )}
          </div>
          <div className="orb-wrap">
            <Orb phase={orbPhase} levelRef={voice.levelRef} name={name} />
          </div>
          <div className="caption-zone" aria-live="polite">
            <div className="phase">{phaseLabel}</div>
            <div className="caption">{caption}</div>
          </div>
        </main>

        {rightOpen && (
          <RightPanel
            worker={selected}
            workers={hud.workers}
            onSelectWorker={setSelectedId}
            mode={mode}
            onMode={setMode}
            draft={draft}
            onDraft={setDraft}
            onSend={sendDraft}
            onStop={stop}
            onTyping={voice.setPaused}
            listening={voice.phase === "listening"}
          />
        )}
      </div>}

      <InstanceModal opened={setupOpen} instance={hud.instance} onClose={() => setSetupOpen(false)} />
      <TodoModal opened={planner === "todo"} now={now} todos={todos} onClose={() => setPlanner(null)} onAdd={addTodo} onToggle={toggleTodo} />
      <MeetingsModal opened={planner === "meetings"} onClose={() => setPlanner(null)} />

      <NewWorkerModal
        opened={modal.opened}
        initialTask={modal.task}
        defaultCwd={hud.config?.defaultCwd ?? ""}
        recentCwds={recentCwds}
        permissionMode={hud.config?.permissionMode ?? "?"}
        onClose={() => setModal({ opened: false, task: "" })}
        onCreate={create}
      />

      {toast && (
        <Notification className="toast" color="red" onClose={() => setToast(null)} title={name}>
          {toast}
        </Notification>
      )}
    </div>
  );
}
