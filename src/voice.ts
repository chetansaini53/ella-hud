import { useCallback, useEffect, useRef, useState } from "react";

/** Minimal Web Speech API surface (not in lib.dom for every TS version; Chrome/Edge ship it prefixed). */
interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionCtor = new () => Recognition;

const RecognitionImpl: RecognitionCtor | undefined =
  (window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }).SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: RecognitionCtor }).webkitSpeechRecognition;

export const voiceSupport = { listen: RecognitionImpl !== undefined, speak: "speechSynthesis" in window };

export type VoicePhase = "off" | "listening" | "speaking";

interface Options {
  lang: string;
  listen: boolean;
  onFinal: (text: string) => void;
}

/** Markdown/code → something worth hearing. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " (code block) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/[*_#>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function chunks(text: string): string[] {
  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];
  const out: string[] = [];
  for (const s of sentences) {
    const last = out[out.length - 1];
    if (last !== undefined && last.length + s.length < 180) out[out.length - 1] = last + s;
    else out.push(s.trim());
  }
  return out.filter(Boolean);
}

export function useVoice({ lang, listen, onFinal }: Options) {
  const [phase, setPhase] = useState<VoicePhase>("off");
  const [interim, setInterim] = useState("");
  const [spoken, setSpoken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const levelRef = useRef(0);
  const onFinalRef = useRef(onFinal);
  const speakingRef = useRef(false);
  onFinalRef.current = onFinal;

  const wantListen = listen && !paused && phase !== "speaking" && voiceSupport.listen && error === null;

  useEffect(() => {
    if (!wantListen || !RecognitionImpl) {
      if (phase === "listening") setPhase("off");
      return;
    }
    let active = true;
    const rec = new RecognitionImpl();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    // Chrome ends recognition after silence; restart, but back off after errors so a dead network can't hot-loop.
    let failures = 0;
    let restartTimer = 0;
    rec.onresult = (e) => {
      failures = 0;
      let partial = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (!r) continue;
        const text = r[0].transcript.trim();
        if (r.isFinal && text) onFinalRef.current(text);
        else partial += `${text} `;
      }
      setInterim(partial.trim());
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") setError("Microphone blocked — allow it in the browser");
      else if (e.error === "network" && ++failures >= 5) setError("Speech recognition can't reach its service — check the network");
      else if (e.error !== "no-speech") failures++;
    };
    rec.onend = () => {
      if (active) restartTimer = window.setTimeout(() => active && rec.start(), Math.min(10_000, 250 * 2 ** failures));
    };
    rec.start();
    setPhase("listening");

    // Mic level for the orb.
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((s) => {
        if (!active) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(s).connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += ((v - 128) / 128) ** 2;
          levelRef.current = Math.min(1, Math.sqrt(sum / buf.length) * 4);
          raf = requestAnimationFrame(tick);
        };
        tick();
      })
      .catch(() => setError("Microphone blocked — allow it in the browser"));

    return () => {
      active = false;
      window.clearTimeout(restartTimer);
      rec.onend = null;
      rec.stop();
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
      levelRef.current = 0;
      setInterim("");
    };
    // phase intentionally excluded: listening restarts only when the wish to listen changes.
  }, [wantListen, lang]);

  const cancelSpeech = useCallback(() => {
    if (!voiceSupport.speak || !speakingRef.current) return;
    speakingRef.current = false;
    window.speechSynthesis.cancel();
    setSpoken("");
    // Only leave "speaking"; a live mic keeps its "listening" phase.
    setPhase((p) => (p === "speaking" ? "off" : p));
  }, []);

  const speak = useCallback(
    (text: string, onDone?: () => void) => {
      const clean = speakable(text);
      if (!voiceSupport.speak || !clean) return onDone?.();
      window.speechSynthesis.cancel();
      const voice = window.speechSynthesis.getVoices().find((v) => v.lang.replace("_", "-").startsWith(lang.slice(0, 2)));
      const parts = chunks(clean);
      speakingRef.current = true;
      parts.forEach((part, i) => {
        const u = new SpeechSynthesisUtterance(part);
        u.lang = lang;
        if (voice) u.voice = voice;
        u.onstart = () => {
          setPhase("speaking");
          setSpoken(part);
        };
        if (i === parts.length - 1) {
          u.onend = u.onerror = () => {
            if (!speakingRef.current) return;
            speakingRef.current = false;
            setSpoken("");
            setPhase("off");
            onDone?.();
          };
        }
        window.speechSynthesis.speak(u);
      });
    },
    [lang],
  );

  return { phase, interim, spoken, error, levelRef, speak, cancelSpeech, setPaused, clearError: () => setError(null) };
}
