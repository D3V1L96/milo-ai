import { useCallback, useEffect, useRef, useState } from "react";
import type { MiloEvent } from "../lib/types";
import {
  normalizeMediaState,
  type AudioOutputDevice,
  type MediaState,
  type VolumeState
} from "../lib/mediaTypes";

export interface Metrics {
  cpu?: number; ram?: number; battery?: number; charging?: boolean;
  ram_used_gb?: number; net_sent_mb?: number; net_recv_mb?: number;
}

interface Handlers {
  onEvent: (e: MiloEvent) => void;
  onMetrics?: (m: Metrics) => void;
  onMedia?: (m: MediaState) => void;
  onVolume?: (v: VolumeState) => void;
  onDevice?: (d: AudioOutputDevice) => void;
}

export function useMiloBackend(h: Handlers, url = "ws://127.0.0.1:8765/ws") {
  const [connected, setConnected] = useState(false);
  const sock = useRef<WebSocket | null>(null);
  const ref = useRef(h);
  ref.current = h;

  useEffect(() => {
    let retry: number | undefined;
    let dead = false;
    const schedule = () => { if (!dead) retry = window.setTimeout(open, 3000); };
    const open = () => {
      if (dead) return;
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch { schedule(); return; }
      sock.current = ws;
      ws.onopen = () => {
        if (sock.current === ws) setConnected(true);
      };
      ws.onmessage = (ev) => {
        if (sock.current !== ws) return;
        let d: any;
        try { d = JSON.parse(ev.data); } catch { return; }
        if (d.metrics) ref.current.onMetrics?.(d.metrics);
        if (d.media) ref.current.onMedia?.(normalizeMediaState(d.media));
        if (d.volume) ref.current.onVolume?.(d.volume);
        if (d.device && typeof d.device.name === "string") {
          ref.current.onDevice?.({
            name: d.device.name,
            connected: d.device.connected === true
          });
        }
        if (
          d.state || d.emotion || d.message || d.notification || d.dismiss || d.clearAll ||
          d.chatMessage || d.chatStatus || d.llmStatus || d.notificationStatus
        ) {
          ref.current.onEvent(d as MiloEvent);
        }
      };
      ws.onclose = () => {
        if (sock.current !== ws) return;
        sock.current = null;
        setConnected(false);
        schedule();
      };
      ws.onerror = () => {
        if (sock.current === ws) ws.close();
      };
    };
    open();
    return () => {
      dead = true;
      clearTimeout(retry);
      const current = sock.current;
      sock.current = null;
      current?.close();
    };
  }, [url]);

  const send = useCallback((cmd: Record<string, unknown>) => {
    if (sock.current?.readyState === WebSocket.OPEN) {
      sock.current.send(JSON.stringify(cmd));
      return true;
    }
    return false;
  }, []);

  return { connected, send };
}
