export interface MediaState {
  available: boolean;
  playing: boolean;
  title: string;
  artist: string;
  album?: string;
  source?: string;
  position: number;
  duration: number;
  thumbnail?: string | null;
  canSeek?: boolean;
  canNext?: boolean;
  canPrev?: boolean;
}

export interface VolumeState { value: number; muted: boolean }

export interface AudioOutputDevice { name: string; connected: boolean }

export const EMPTY_MEDIA: MediaState = {
  available: false, playing: false, title: "", artist: "",
  position: 0, duration: 0, thumbnail: null
};

export function normalizeMediaState(value: unknown): MediaState {
  if (typeof value !== "object" || value === null) return EMPTY_MEDIA;

  const raw = value as Record<string, unknown>;
  const title = typeof raw.title === "string" ? raw.title : "";
  const playing = raw.playing === true;
  const available = raw.available === true || playing || title.trim().length > 0;
  const numberOrZero = (input: unknown) =>
    typeof input === "number" && Number.isFinite(input) ? input : 0;

  return {
    available,
    playing,
    title,
    artist: typeof raw.artist === "string" ? raw.artist : "",
    album: typeof raw.album === "string" ? raw.album : undefined,
    source: typeof raw.source === "string" ? raw.source : undefined,
    position: numberOrZero(raw.position),
    duration: numberOrZero(raw.duration),
    thumbnail: typeof raw.thumbnail === "string" ? raw.thumbnail : null,
    canSeek: typeof raw.canSeek === "boolean" ? raw.canSeek : undefined,
    canNext: typeof raw.canNext === "boolean" ? raw.canNext : undefined,
    canPrev: typeof raw.canPrev === "boolean" ? raw.canPrev : undefined
  };
}
