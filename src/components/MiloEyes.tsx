import { useEffect, useRef, useState } from "react";
import { motion, useMotionValue } from "framer-motion";
import type { Emotion } from "../lib/types";
import { useVibeFrame } from "../hooks/useVibeFrame";

const shape: Record<Emotion, { w: number; h: number; r: number; tilt: number }> = {
  calm:        { w: 20, h: 28, r: 12, tilt: 0 },
  happy:       { w: 26, h: 13, r: 13, tilt: 0 },
  curious:     { w: 23, h: 33, r: 14, tilt: 9 },
  sleepy:      { w: 24, h: 7,  r: 7,  tilt: 0 },
  focused:     { w: 18, h: 22, r: 10, tilt: 0 },
  confused:    { w: 22, h: 24, r: 12, tilt: 14 },
  vibing:      { w: 25, h: 16, r: 13, tilt: 0 },
  joyful:      { w: 28, h: 17, r: 14, tilt: -3 },
  excited:     { w: 30, h: 26, r: 13, tilt: -2 },
  content:     { w: 21, h: 26, r: 14, tilt: 0 },
  relaxed:     { w: 23, h: 24, r: 13, tilt: -3 },
  hopeful:     { w: 24, h: 29, r: 12, tilt: -2 },
  grateful:    { w: 23, h: 22, r: 11, tilt: 4 },
  loving:      { w: 27, h: 21, r: 14, tilt: 4 },
  playful:     { w: 27, h: 18, r: 14, tilt: -6 },
  mischievous: { w: 26, h: 16, r: 12, tilt: 8 },
  proud:       { w: 22, h: 20, r: 10, tilt: -5 },
  confident:   { w: 19, h: 26, r: 10, tilt: -4 },
  determined:  { w: 18, h: 27, r: 8,  tilt: -2 },
  thoughtful:  { w: 22, h: 31, r: 11, tilt: 8 },
  interested:  { w: 24, h: 34, r: 11, tilt: -4 },
  surprised:   { w: 25, h: 36, r: 11, tilt: 0 },
  shocked:     { w: 29, h: 37, r: 10, tilt: 0 },
  amazed:      { w: 31, h: 32, r: 14, tilt: -5 },
  worried:     { w: 18, h: 24, r: 8,  tilt: 7 },
  anxious:     { w: 17, h: 22, r: 7,  tilt: 11 },
  nervous:     { w: 20, h: 21, r: 7,  tilt: -9 },
  scared:      { w: 21, h: 31, r: 9,  tilt: 10 },
  angry:       { w: 25, h: 12, r: 8,  tilt: -10 },
  annoyed:     { w: 23, h: 17, r: 8,  tilt: -8 },
  frustrated:  { w: 18, h: 14, r: 7,  tilt: -12 },
  disappointed:{ w: 21, h: 16, r: 12, tilt: 6 },
  sad:         { w: 22, h: 19, r: 12, tilt: 9 },
  lonely:      { w: 20, h: 23, r: 10, tilt: 8 },
  melancholy:  { w: 22, h: 20, r: 13, tilt: 11 },
  embarrassed:{ w: 24, h: 15, r: 10, tilt: 2 },
  shy:         { w: 20, h: 18, r: 13, tilt: 8 },
  guilty:      { w: 18, h: 16, r: 7,  tilt: 6 },
  jealous:     { w: 24, h: 22, r: 9,  tilt: 10 },
  skeptical:   { w: 22, h: 23, r: 7,  tilt: -14 },
  suspicious:  { w: 19, h: 19, r: 6,  tilt: -13 },
  bored:       { w: 23, h: 10, r: 10, tilt: 0 },
  tired:       { w: 25, h: 8,  r: 8,  tilt: 3 },
  exhausted:   { w: 26, h: 6,  r: 6,  tilt: -3 },
  sick:        { w: 16, h: 21, r: 6,  tilt: 5 },
  dreamy:      { w: 28, h: 25, r: 14, tilt: -7 },
  stern:       { w: 17, h: 17, r: 6,  tilt: 0 },
  triumphant:  { w: 28, h: 15, r: 13, tilt: -10 }
};

export default function MiloEyes({ emotion, size = 1, lookAt = null }: { emotion: Emotion; size?: number; lookAt?: { x: number; y: number } | null }) {
  const [look, setLook] = useState({ x: 0, y: 0 });
  const [blink, setBlink] = useState(false);
  const s = shape[emotion];
  const vibing = emotion === "vibing";

  const bob = useMotionValue(0);
  const squash = useMotionValue(1);
  const refs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    if (lookAt) {
      setLook(lookAt);
      return;
    }
    const move = (e: MouseEvent) => setLook({
      x: (e.clientX / window.innerWidth - 0.5) * 7,
      y: (e.clientY / window.innerHeight - 0.5) * 5
    });
    window.addEventListener("mousemove", move);
    return () => window.removeEventListener("mousemove", move);
  }, [lookAt]);

  useEffect(() => {
    if (vibing) return;
    let t: number;
    const loop = () => {
      t = window.setTimeout(() => {
        setBlink(true);
        window.setTimeout(() => setBlink(false), 105);
        loop();
      }, 2400 + Math.random() * 2800);
    };
    loop();
    return () => clearTimeout(t);
  }, [vibing]);

  useVibeFrame((f) => {
    const t = performance.now() / 1000;
    bob.set(Math.sin(t * 3.4) * (2 + f.level * 5) - f.beat * 3);
    squash.set(1 - f.beat * 0.28 + f.bass * 0.12);
    const glow = 14 + f.level * 34 + f.beat * 22;
    refs.current.forEach((n) => {
      if (n) n.style.boxShadow = `0 0 ${glow}px color-mix(in srgb,var(--accent) 90%,transparent), inset 0 -2px 4px rgba(0,0,0,.15)`;
    });
  }, vibing);

  useEffect(() => {
    if (vibing) return;
    refs.current.forEach((n) => {
      if (n) n.style.boxShadow = "0 0 16px color-mix(in srgb,var(--accent) 85%,transparent), inset 0 -2px 4px rgba(0,0,0,.15)";
    });
  }, [vibing]);

  return (
    <motion.div style={{ display: "flex", gap: 14 * size, alignItems: "center", y: vibing ? bob : 0 }}>
      {[0, 1].map((i) => (
        <motion.div
          key={i}
          ref={(n) => { refs.current[i] = n; }}
          animate={vibing
            ? { width: s.w * size, height: s.h * size, borderRadius: s.r * size, rotate: i === 0 ? -4 : 4 }
            : { width: s.w * size, height: s.h * size, borderRadius: s.r * size,
                x: look.x, y: look.y + (emotion === "happy" ? 2 : 0),
                rotate: i === 0 ? -s.tilt : s.tilt }}
          transition={{ type: "spring", stiffness: 280, damping: 17 }}
          style={{
            position: "relative", overflow: "hidden", flex: "none",
            background: "linear-gradient(180deg,var(--accent-2),var(--accent))",
            scaleY: vibing ? squash : 1,
            boxShadow: "0 0 16px color-mix(in srgb,var(--accent) 85%,transparent), inset 0 -2px 4px rgba(0,0,0,.15)"
          }}
        >
          <div style={{
            position: "absolute", top: 4 * size, left: 4 * size,
            width: 6 * size, height: 6 * size, borderRadius: "50%",
            background: "rgba(255,255,255,.92)"
          }} />
          <motion.div
            animate={{ scaleY: blink || emotion === "sleepy" ? 1 : 0 }}
            transition={{ duration: 0.09 }}
            style={{
              position: "absolute", inset: 0, background: "#0b0e14",
              transformOrigin: "top", borderRadius: "inherit"
            }}
          />
        </motion.div>
      ))}
    </motion.div>
  );
}
