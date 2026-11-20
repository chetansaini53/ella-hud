import { useEffect, useRef, type RefObject } from "react";

export type OrbPhase = "idle" | "listening" | "thinking" | "speaking";

const RINGS = 8;
const GOLD = [242, 208, 107];
const CORAL = [226, 122, 106];
const BASE_ENERGY: Record<OrbPhase, number> = { idle: 0.25, thinking: 0.55, listening: 0.35, speaking: 0.75 };

interface Props {
  phase: OrbPhase;
  levelRef: RefObject<number>;
}

/** Canvas orb: wobbling gold→coral rings around a glowing core; energy follows the voice phase and mic level. */
export function Orb({ phase, levelRef }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let energy = BASE_ENERGY.idle;
    let raf = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (reduced) draw(0);
    };

    const draw = (t: number) => {
      const p = phaseRef.current;
      let target = BASE_ENERGY[p];
      if (p === "listening") target += (levelRef.current ?? 0) * 0.9;
      if (p === "speaking") target += 0.2 * Math.sin(t * 0.009);
      energy += (target - energy) * 0.08;

      const { width: w, height: h } = canvas;
      const dpr = window.devicePixelRatio || 1;
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) * 0.34;
      ctx.clearRect(0, 0, w, h);

      // core glow
      const coreR = R * (0.5 + energy * 0.12);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      g.addColorStop(0, "rgba(255,253,241,1)");
      g.addColorStop(0.08, "rgba(255,230,160,0.95)");
      g.addColorStop(0.3, "rgba(214,168,82,0.4)");
      g.addColorStop(0.6, "rgba(150,115,55,0.12)");
      g.addColorStop(1, "rgba(120,90,40,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
      ctx.fill();

      // rings
      ctx.globalCompositeOperation = "lighter";
      const time = t * 0.001;
      for (let i = 0; i < RINGS; i++) {
        const mix = i / (RINGS - 1);
        const [r, gg, b] = GOLD.map((c, k) => Math.round(c + ((CORAL[k] ?? c) - c) * mix));
        const lobes = 5 + (i % 2);
        const speed = 0.25 + i * 0.07;
        const offset = i * 1.7;
        const amp = 0.06 + energy * 0.08;
        ctx.strokeStyle = `rgba(${r},${gg},${b},0.7)`;
        ctx.shadowColor = `rgba(${r},${gg},${b},0.9)`;
        ctx.shadowBlur = 10 * dpr;
        ctx.lineWidth = 1.6 * dpr;
        ctx.beginPath();
        for (let s = 0; s <= 180; s++) {
          const th = (s / 180) * Math.PI * 2;
          const wobble = Math.sin(lobes * th + time * speed * 3 + offset) * amp + Math.sin((lobes + 2) * th - time * speed * 2 + offset * 2) * amp * 0.45;
          const rad = R * (0.9 + mix * 0.2 + wobble);
          const x = cx + Math.cos(th) * rad;
          const y = cy + Math.sin(th) * rad;
          if (s === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      ctx.globalCompositeOperation = "source-over";
    };

    const loop = (t: number) => {
      draw(t);
      raf = requestAnimationFrame(loop);
    };

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();
    if (!reduced) raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [levelRef]);

  return <canvas ref={canvasRef} role="img" aria-label={`Claudia is ${phase}`} />;
}
