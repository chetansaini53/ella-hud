import { ActionIcon, Indicator, Menu, Tooltip } from "@mantine/core";
import {
  IconAdjustmentsHorizontal,
  IconCalendarEvent,
  IconChecklist,
  IconFocus2,
  IconHeadphones,
  IconLanguage,
  IconLayoutSidebarRight,
  IconMaximize,
  IconMicrophone,
  IconMicrophoneOff,
  IconPlus,
  IconSun,
  IconVolume,
  IconVolumeOff,
} from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { AppConfig, Usage, UsageWindow } from "../../shared/types.ts";
import { resetsText } from "../format.ts";

export const VOICE_LANGS = [
  { value: "en-IN", label: "English (India)" },
  { value: "hi-IN", label: "Hindi" },
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
];

interface Props {
  now: number;
  connected: boolean;
  vpn: boolean;
  needsYou: number;
  usage: Usage;
  config: AppConfig | null;
  micOn: boolean;
  speakerOn: boolean;
  announceAll: boolean;
  rightOpen: boolean;
  controlOpen: boolean;
  openTodos: number;
  lang: string;
  onToggleMic: () => void;
  onToggleSpeaker: () => void;
  onToggleAnnounceAll: () => void;
  onToggleRight: () => void;
  onToggleControl: () => void;
  onMeetings: () => void;
  onTodos: () => void;
  onNewWorker: () => void;
  onNeedsYou: () => void;
  onLang: (lang: string) => void;
}

function Meter({ label, win, now }: { label: string; win: UsageWindow | null; now: number }) {
  return (
    <div className="meter" title={win ? undefined : "Fills in after a worker's first reply"}>
      <span className="meter-label">{label}</span>
      <div className="meter-track" role="progressbar" aria-label={`${label} usage`} aria-valuenow={win ? Math.round(win.pct) : undefined} aria-valuemin={0} aria-valuemax={100}>
        <div className="meter-fill" style={{ width: `${win?.pct ?? 0}%` }} />
      </div>
      <span className="meter-pct">{win ? `${Math.round(win.pct)}%` : "—"}</span>
      <span className="meter-sub">{win ? resetsText(win.resetsAt, now) : "waiting for first reply"}</span>
    </div>
  );
}

function IconButton({ label, className, onClick, children }: { label: string; className?: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip label={label}>
      <ActionIcon variant="transparent" className={`icon-btn ${className ?? ""}`} aria-label={label} onClick={onClick}>
        {children}
      </ActionIcon>
    </Tooltip>
  );
}

export function Header(p: Props) {
  const clock = new Date(p.now).toLocaleTimeString("en-GB");
  return (
    <header className="header">
      <div className="brand">
        <IconFocus2 size={20} stroke={1.6} aria-hidden />
        <span>Ella</span>
      </div>

      <Tooltip label={p.vpn ? "A VPN / tunnel adapter is up" : "No VPN adapter detected"}>
        <span className={`pill ${p.vpn ? "cyan" : "red"}`} role="status">
          <span className="dot" /> {p.vpn ? "VPN ON" : "VPN OFF"}
        </span>
      </Tooltip>
      <Tooltip label={p.connected ? `Server live · permission mode ${p.config?.permissionMode ?? "?"}` : "Server offline — reconnecting"}>
        <span className={`pill ${p.connected ? "cyan" : "red"}`} role="status">
          <span className="dot" /> STATUS
        </span>
      </Tooltip>
      <Tooltip label={p.needsYou ? "Jump to the worker that needs you" : "Nothing needs you"}>
        <button type="button" className={`pill ${p.needsYou ? "gold" : ""}`} onClick={p.onNeedsYou} disabled={!p.needsYou}>
          <span className="dot" /> NEEDS YOU{p.needsYou ? ` ${p.needsYou}` : ""}
        </button>
      </Tooltip>

      <Meter label="SESSION" win={p.usage.session} now={p.now} />
      <Meter label="WEEK" win={p.usage.week} now={p.now} />
      <span className="clock">{clock}</span>

      <IconButton label={p.micOn ? "Mute microphone" : "Unmute microphone"} className={p.micOn ? "on" : "alert"} onClick={p.onToggleMic}>
        {p.micOn ? <IconMicrophone size={16} /> : <IconMicrophoneOff size={16} />}
      </IconButton>
      <IconButton label={p.speakerOn ? "Mute Ella's voice" : "Let Ella speak"} className={p.speakerOn ? "on" : ""} onClick={p.onToggleSpeaker}>
        {p.speakerOn ? <IconVolume size={16} /> : <IconVolumeOff size={16} />}
      </IconButton>
      <IconButton label={p.announceAll ? "Announcing every worker that finishes" : "Announcing only the worker you talk to"} className={p.announceAll ? "on" : ""} onClick={p.onToggleAnnounceAll}>
        <IconHeadphones size={16} />
      </IconButton>
      <IconButton label="Meetings" onClick={p.onMeetings}>
        <IconCalendarEvent size={16} />
      </IconButton>
      <IconButton label={`To-do · ${p.openTodos} open`} onClick={p.onTodos}>
        <Indicator disabled={p.openTodos === 0} label={p.openTodos} size={14} color="yellow" offset={-2}>
          <IconChecklist size={16} />
        </Indicator>
      </IconButton>
      <IconButton label={p.controlOpen ? "Back to the HUD" : "Control center: projects, config, Docker, tasks"} className={p.controlOpen ? "on" : ""} onClick={p.onToggleControl}>
        <IconAdjustmentsHorizontal size={16} />
      </IconButton>
      <IconButton label="New worker" onClick={p.onNewWorker}>
        <IconPlus size={16} />
      </IconButton>
      <IconButton label={p.rightOpen ? "Hide side panel" : "Show side panel"} className={p.rightOpen ? "" : "on"} onClick={p.onToggleRight}>
        <IconLayoutSidebarRight size={16} />
      </IconButton>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <Tooltip label="Voice language">
            <ActionIcon variant="transparent" className="icon-btn" aria-label="Voice language">
              <IconSun size={16} />
            </ActionIcon>
          </Tooltip>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>Voice language</Menu.Label>
          {VOICE_LANGS.map((l) => (
            <Menu.Item key={l.value} leftSection={<IconLanguage size={14} />} onClick={() => p.onLang(l.value)} color={l.value === p.lang ? "hud" : undefined}>
              {l.label}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
      <IconButton label="Full screen" onClick={() => void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())}>
        <IconMaximize size={16} />
      </IconButton>
    </header>
  );
}
