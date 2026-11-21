import { useEffect, useRef } from "react";
import { vibeFrame, type VibeFrame } from "../lib/audioEngine";

export function useVibeFrame(cb: (f: VibeFrame) => void, active: boolean) {
  const fn = useRef(cb);
  fn.current = cb;
  useEffect(() => {
    if (!active) return;
    let id = 0;
    const tick = () => { fn.current(vibeFrame); id = requestAnimationFrame(tick); };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [active]);
}
