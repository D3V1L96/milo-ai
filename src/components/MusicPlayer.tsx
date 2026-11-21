import { useEffect, useRef, useState } from "react";
import {
  Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, Music2, Radio, Headphones,
  Bluetooth, Plus, ExternalLink, Mic2
} from "lucide-react";
import type { AudioOutputDevice, MediaState, VolumeState } from "../lib/mediaTypes";

const platformSearch = (platform: string, query: string) => {
  const name = platform.trim().toLowerCase();
  const encoded = encodeURIComponent(query);
  if (/youtube music|yt music/.test(name)) return `https://music.youtube.com/search?q=${encoded}`;
  if (name.includes("youtube")) return `https://www.youtube.com/results?search_query=${encoded}`;
  if (name.includes("spotify")) return `https://open.spotify.com/search/${encoded}`;
  if (name.includes("apple music")) return `https://music.apple.com/search?term=${encoded}`;
  if (name.includes("amazon music")) return `https://music.amazon.com/search/${encoded}`;
  if (name.includes("soundcloud")) return `https://soundcloud.com/search?q=${encoded}`;
  return `https://www.google.com/search?q=${encodeURIComponent(`${platform} ${query} music`)}`;
};

interface LyricLine { time: number; text: string }
const parseSyncedLyrics = (lyrics: string): LyricLine[] => lyrics.split(/\r?\n/).flatMap((line) => {
  const match = line.match(/^\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\](.*)$/);
  return match ? [{ time: Number(match[1]) * 60 + Number(match[2]) + Number(`0.${match[3] || "0"}`), text: match[4].trim() }] : [];
});

const fmt = (s: number) => {
  if (!isFinite(s) || s < 0) return "0:00";
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

export default function MusicPlayer({ media, volume, device, connected, send, installedApps = [], onPlayYouTube = () => {} }: {
  media: MediaState;
  volume: VolumeState;
  device: AudioOutputDevice;
  connected: boolean;
  send: (cmd: Record<string, unknown>) => boolean;
  installedApps?: { name: string; installed: boolean }[];
  onPlayYouTube?: (query: string) => void;
}) {
  const [clock, setClock] = useState(() => performance.now());
  const [positionSyncedAt, setPositionSyncedAt] = useState(() => performance.now());
  const [dragVol, setDragVol] = useState<number | null>(null);
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
  const [musicPlatform, setMusicPlatform] = useState("");
  const [musicQuery, setMusicQuery] = useState("");
  const [lyrics, setLyrics] = useState<LyricLine[]>([]);
  const [plainLyrics, setPlainLyrics] = useState("");
  const [showLyrics, setShowLyrics] = useState(false);
  const [lyricsMessage, setLyricsMessage] = useState("Lyrics appear when a song is playing");
  const volumeReset = useRef<number | null>(null);

  useEffect(() => {
    setPositionSyncedAt(performance.now());
  }, [media.position, media.playing, media.title]);

  useEffect(() => {
    if (!media.playing) return;
    const id = window.setInterval(() => setClock(performance.now()), 100);
    return () => clearInterval(id);
  }, [media.playing]);

  useEffect(() => {
    if (dragVol === null || Math.abs(volume.value - dragVol) >= 0.02) return;
    if (volumeReset.current !== null) window.clearTimeout(volumeReset.current);
    volumeReset.current = null;
    setDragVol(null);
  }, [dragVol, volume.value]);

  useEffect(() => () => {
    if (volumeReset.current !== null) window.clearTimeout(volumeReset.current);
  }, []);

  const duration = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0;
  const elapsed = media.playing ? Math.max(0, (clock - positionSyncedAt) / 1000) : 0;
  const pos = Math.max(0, Math.min(duration || Infinity, media.position + elapsed));
  const progressPct = duration > 0 ? Math.min(100, (pos / duration) * 100) : 0;

  const volPct = Math.round((dragVol ?? volume.value) * 100);
  const isHeadphone = /airpods|headphones?|headsets?|earbuds?|earphones?/i.test(device.name);
  const DeviceIcon = isHeadphone ? Headphones : Volume2;
  const launchMusicSource = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = musicQuery.trim();
    if (!query) return;
    const platform = musicPlatform.trim();
    if (!platform) return;
    if (platform.toLowerCase() === "youtube") {
      onPlayYouTube(query);
      return;
    }
    const foundApp = installedApps.find((app) => app.installed && (app.name.toLowerCase().includes(platform.toLowerCase()) || platform.toLowerCase().includes(app.name.toLowerCase())));
    if (foundApp) send({ action: "open_app", app: foundApp.name });
    window.open(platformSearch(platform, query), "_blank", "noopener,noreferrer");
  };

  useEffect(() => {
    if (!media.available || !media.title.trim()) { setLyrics([]); return; }
    const controller = new AbortController();
    const params = new URLSearchParams({ track_name: media.title, artist_name: media.artist || "" });
    if (media.duration > 0) params.set("duration", String(Math.round(media.duration)));
    setLyrics([]);
    setPlainLyrics("");
    setLyricsMessage("Finding synced lyrics…");
    const getLyrics = async () => {
      try {
        const exactResponse = await fetch(`https://lrclib.net/api/get?${params}`, { signal: controller.signal });
        const exact = exactResponse.ok ? await exactResponse.json() : null;
        let synced = typeof exact?.syncedLyrics === "string" ? exact.syncedLyrics : "";
        let plain = typeof exact?.plainLyrics === "string" ? exact.plainLyrics : "";
        if (!synced && !plain) {
          const searchResponse = await fetch(`https://lrclib.net/api/search?${new URLSearchParams({ track_name: media.title, artist_name: media.artist || "" })}`, { signal: controller.signal });
          const results = searchResponse.ok ? await searchResponse.json() : [];
          const match = Array.isArray(results) ? results.find((item) => item.syncedLyrics || item.plainLyrics) : null;
          synced = typeof match?.syncedLyrics === "string" ? match.syncedLyrics : "";
          plain = typeof match?.plainLyrics === "string" ? match.plainLyrics : "";
        }
        if (!synced && !plain) {
          const fallbackResponse = await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(media.artist || "")}/${encodeURIComponent(media.title)}`, { signal: controller.signal });
          const fallback = fallbackResponse.ok ? await fallbackResponse.json() : null;
          plain = typeof fallback?.lyrics === "string" ? fallback.lyrics : "";
        }
        if (controller.signal.aborted) return;
        const lines = synced ? parseSyncedLyrics(synced) : [];
        setLyrics(lines);
        setPlainLyrics(plain);
        setLyricsMessage(lines.length || plain ? "" : "Lyrics weren’t found from available sources");
      } catch {
        if (!controller.signal.aborted) setLyricsMessage("Lyrics sources could not be reached");
      }
    };
    void getLyrics();
    return () => controller.abort();
  }, [media.available, media.title, media.artist, media.duration]);

  const activeLyric = lyrics.reduce((index, line, i) => line.time <= pos ? i : index, -1);

  if (!connected) {
    return (
      <div className="card" onClick={(e) => e.stopPropagation()}>
        <div className="mp-empty">
          <Radio size={16} />
          <div>
            <div className="title">Backend offline</div>
            <div className="artist">Start uvicorn on port 8765 to control real playback</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card" onClick={(e) => e.stopPropagation()}>
      <form className="music-launcher" onSubmit={launchMusicSource}>
        <div className="music-search-row">
          <input type="text" aria-label="Music streaming platform" placeholder="Platform (e.g. Spotify)" maxLength={80} value={musicPlatform} onChange={(event) => setMusicPlatform(event.target.value)} />
          <input
            type="search"
            aria-label="Search a song or artist"
            placeholder="Song or artist"
            maxLength={160}
            value={musicQuery}
            onChange={(event) => setMusicQuery(event.target.value)}
          />
          <button type="submit" aria-label="Open music platform" title="Open music platform" disabled={!musicQuery.trim() || !musicPlatform.trim()}>
            <ExternalLink size={14} />
          </button>
        </div>
      </form>
      {media.available ? (
        <>
          <div className="track">
            <div className="art" title={media.album || "Album artwork"}>
              {media.thumbnail
                ? <img src={media.thumbnail} alt="" />
                : <Music2 size={18} color="#04121a" />}
            </div>
            <div className="meta">
              <div className="title">{media.title || "Unknown"}</div>
              <div className="artist">{media.artist || "Artist unavailable"}</div>
              {media.album && <div className="album-name">{media.album}</div>}
            </div>
          </div>

          <div className="seek">
            <span>{fmt(pos)}</span>
            <input
              type="range" min={0} max={duration || 1} step={0.25}
              value={duration ? Math.min(pos, duration) : 0}
              disabled={!duration || media.canSeek === false}
              aria-label="Seek"
              style={{ background: `linear-gradient(to right, var(--accent) ${progressPct}%, rgba(255,255,255,.16) ${progressPct}%)` }}
              onChange={(e) => send({ action: "seek", seconds: Number(e.target.value) })}
            />
            <span>{duration ? fmt(duration) : "--:--"}</span>
          </div>
          <button type="button" className={`lyrics-toggle ${showLyrics ? "on" : ""}`} aria-expanded={showLyrics} onClick={() => setShowLyrics((visible) => !visible)}>
            <Mic2 size={13} /><span>Lyrics</span><span className="lyrics-toggle-state">{showLyrics ? "Hide" : "Show"}</span>
          </button>
          {showLyrics && <section className="synced-lyrics" aria-label="Lyrics">
            {lyrics.length ? <div className="lyrics-lines" aria-live="polite">
              {lyrics.slice(Math.max(0, activeLyric - 2), Math.max(0, activeLyric - 2) + 5).map((line, i) => {
                const index = Math.max(0, activeLyric - 2) + i;
                return <p key={`${line.time}-${index}`} className={index === activeLyric ? "active" : ""}>{line.text || "♪"}</p>;
              })}
            </div> : plainLyrics ? <pre className="lyrics-plain">{plainLyrics}</pre> : <p className="lyrics-message">{lyricsMessage}</p>}
          </section>}
        </>
      ) : (
        <div className="mp-empty">
          <Music2 size={16} />
          <div>
            <div className="title">Nothing playing</div>
            <div className="artist">Enter a streaming platform and a song to open it</div>
          </div>
        </div>
      )}

      <div className="row">
        <div className="ctrls">
          <button className="icon-btn" aria-label="Previous track"
                  disabled={!connected}
                  onClick={() => send({ action: "previous" })}><SkipBack size={14} /></button>
          <button className="play"
                  aria-label={media.playing ? "Pause" : media.available ? "Resume" : "Play"}
                  title={media.playing ? "Pause" : media.available ? "Resume" : "Play"}
                  disabled={!connected}
                  onClick={() => send({ action: "toggle" })}>
            {media.playing ? <Pause size={17} /> : <Play size={17} />}
          </button>
          <button className="icon-btn" aria-label="Next track"
                  disabled={!connected}
                  onClick={() => send({ action: "next" })}><SkipForward size={14} /></button>
        </div>
        <div className="vol">
          <button className="icon-btn bare" aria-label={volume.muted ? "Unmute" : "Mute"}
                  disabled={!connected}
                  onClick={() => send({ action: "mute", value: !volume.muted })}>
            {volume.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </button>
          <input
            type="range" min={0} max={1} step={0.01}
            value={dragVol ?? volume.value} disabled={!connected}
            aria-label="System volume"
            aria-valuetext={`${volPct}%`}
            style={{ background: `linear-gradient(to right, var(--accent) ${volPct}%, rgba(255,255,255,.16) ${volPct}%)` }}
            onChange={(e) => {
              const v = Number(e.target.value);
              setDragVol(v);
              send({ action: "volume", value: v });
            }}
            onPointerUp={() => {
              if (volumeReset.current !== null) window.clearTimeout(volumeReset.current);
              volumeReset.current = window.setTimeout(() => {
                volumeReset.current = null;
                setDragVol(null);
              }, 1500);
            }}
            onBlur={() => {
              if (volumeReset.current !== null) window.clearTimeout(volumeReset.current);
              volumeReset.current = null;
              setDragVol(null);
            }}
          />
          <span className="vol-num">{volPct}</span>
        </div>
      </div>

      <div className="output-device-wrap">
        <button
          type="button"
          className="output-device"
          title={device.name || "No output device detected"}
          aria-haspopup="menu"
          aria-expanded={deviceMenuOpen}
          aria-label={`Audio output: ${device.name || "detecting device"}`}
          onClick={() => setDeviceMenuOpen((isOpen) => !isOpen)}
        >
          <DeviceIcon size={14} aria-hidden="true" />
          <span className="output-label">Output</span>
          <span className="output-name">{device.name || "Detecting device..."}</span>
          <span className="output-status">{device.connected ? "Connected" : "Searching"}</span>
        </button>
        {deviceMenuOpen && (
          <div className="device-menu" role="menu" aria-label="Audio output options">
            <div className="device-menu-title">Current output</div>
            <div className="device-menu-current">
              <DeviceIcon size={14} aria-hidden="true" />
              <span>{device.name || "No output device detected"}</span>
            </div>
            <button
              type="button"
              className="device-add"
              role="menuitem"
              disabled={!connected}
              onClick={() => {
                send({ action: "add_audio_device" });
                setDeviceMenuOpen(false);
              }}
            >
              <Bluetooth size={14} aria-hidden="true" />
              <span>Add new device</span>
              <Plus size={14} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

    </div>
  );
}
