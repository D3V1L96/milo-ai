import { useRef } from "react";
import { useVibeFrame } from "../hooks/useVibeFrame";

const BARS = 22;

export default function VibeMeter({ active, bpm }: { active: boolean; bpm: number }) {
  const bars = useRef<(HTMLDivElement | null)[]>([]);
  const ring = useRef<HTMLDivElement | null>(null);

  useVibeFrame((f) => {
    const t = performance.now() / 1000;
    bars.current.forEach((n, i) => {
      if (!n) return;
      const band = i < BARS / 3 ? f.bass : i < (BARS * 2) / 3 ? f.level : f.treble;
      const wobble = 0.55 + 0.45 * Math.sin(t * 6 + i * 0.7);
      n.style.height = `${Math.max(3, Math.min(30, band * 34 * wobble + f.beat * 8))}px`;
      n.style.opacity = String(0.45 + band * 0.55);
    });
    if (ring.current) ring.current.style.transform = `scale(${1 + f.beat * 0.22})`;
  }, active);

  return (
    <div className="vibe">
      <div className="spectrum" aria-hidden="true">
        {Array.from({ length: BARS }).map((_, i) => (
          <div key={i} ref={(n) => { bars.current[i] = n; }} className="vbar" />
        ))}
      </div>
      <div className="bpm">
        <div ref={ring} className="pulse-ring" />
        <span>{active ? (bpm ? `${bpm} BPM` : "listening") : "idle"}</span>
      </div>
    </div>
  );
}
