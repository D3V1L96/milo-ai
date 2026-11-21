export interface VibeFrame { level: number; bass: number; treble: number; beat: number; bpm: number }
export const vibeFrame: VibeFrame = { level: 0, bass: 0, treble: 0, beat: 0, bpm: 0 };

/** "audio" = real FFT from local file. "session" = pulse derived from playback clock. */
export type VibeMode = "off" | "audio" | "session";
let mode: VibeMode = "off";
export const setVibeMode = (m: VibeMode) => { mode = m; };
export const getVibeMode = () => mode;

let el: HTMLAudioElement | null = null;
let ctx: AudioContext | null = null;
let cueContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let data: Uint8Array<ArrayBuffer> | null = null;
let raf = 0;
let history: number[] = [];
let lastBeat = 0;
let gaps: number[] = [];

// session-mode clock, fed by the backend
let sess = { playing: false, position: 0, duration: 0, syncedAt: 0, bpmGuess: 100 };

export type MiloCue = "listening" | "wake" | "reply" | "notification" | "complete";
export type MiloSoundTheme = "cute" | "soft" | "pixel" | "chime" | "bubble" | "sparkle" | "retro" | "bell" | "marimba" | "pop" | "arcade" | "plucky" | "custom";

const SOUND_DB = "milo-custom-sound-v1";
let customSoundUrl = "";

export function saveCustomMiloSound(file: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SOUND_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("sounds");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const transaction = request.result.transaction("sounds", "readwrite");
      transaction.objectStore("sounds").put(file, "cue");
      transaction.oncomplete = () => { request.result.close(); resolve(); };
      transaction.onerror = () => { request.result.close(); reject(transaction.error); };
    };
  });
}

export function loadCustomMiloSound(): Promise<Blob | null> {
  return new Promise((resolve) => {
    const request = indexedDB.open(SOUND_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("sounds");
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      const get = request.result.transaction("sounds", "readonly").objectStore("sounds").get("cue");
      get.onsuccess = () => { request.result.close(); resolve(get.result instanceof Blob ? get.result : null); };
      get.onerror = () => { request.result.close(); resolve(null); };
    };
  });
}

export function setCustomMiloSound(blob: Blob | null) {
  if (customSoundUrl) URL.revokeObjectURL(customSoundUrl);
  customSoundUrl = blob ? URL.createObjectURL(blob) : "";
}

const CUE_THEMES: Record<MiloSoundTheme, {
  wave: OscillatorType;
  notes: Record<MiloCue, number[]>;
  volume: number;
}> = {
  cute: {
    wave: "sine", volume: 0.045,
    notes: { listening: [660], wake: [587, 784], reply: [784, 988], notification: [880, 659], complete: [523, 659, 784] },
  },
  soft: {
    wave: "sine", volume: 0.035,
    notes: { listening: [523], wake: [494, 659], reply: [659, 784], notification: [740, 587], complete: [440, 554, 659] },
  },
  pixel: {
    wave: "square", volume: 0.018,
    notes: { listening: [784], wake: [659, 988], reply: [988, 1318], notification: [1175, 784], complete: [523, 784, 1047] },
  },
  chime: {
    wave: "triangle", volume: 0.04,
    notes: { listening: [784], wake: [659, 880], reply: [880, 1175], notification: [1047, 698], complete: [587, 784, 988] },
  },
  bubble: { wave: "sine", volume: 0.045, notes: { listening: [740], wake: [523, 784], reply: [784, 1047], notification: [880, 587], complete: [523, 740, 988] } },
  sparkle: { wave: "sine", volume: 0.04, notes: { listening: [988], wake: [784, 1175], reply: [1047, 1397], notification: [1318, 988], complete: [659, 988, 1318] } },
  retro: { wave: "sawtooth", volume: 0.014, notes: { listening: [440], wake: [392, 587], reply: [587, 784], notification: [698, 440], complete: [392, 523, 784] } },
  bell: { wave: "triangle", volume: 0.04, notes: { listening: [880], wake: [659, 988], reply: [988, 1318], notification: [1175, 784], complete: [587, 880, 1175] } },
  marimba: { wave: "sine", volume: 0.05, notes: { listening: [587], wake: [523, 659], reply: [659, 880], notification: [784, 587], complete: [440, 587, 784] } },
  pop: { wave: "square", volume: 0.012, notes: { listening: [523], wake: [440, 660], reply: [660, 880], notification: [880, 523], complete: [523, 660, 880] } },
  arcade: { wave: "square", volume: 0.016, notes: { listening: [659], wake: [523, 784], reply: [784, 1047], notification: [988, 659], complete: [523, 784, 1047] } },
  plucky: { wave: "triangle", volume: 0.045, notes: { listening: [587], wake: [494, 740], reply: [740, 988], notification: [880, 587], complete: [494, 659, 880] } },
  custom: { wave: "sine", volume: 0.04, notes: { listening: [660], wake: [587, 784], reply: [784, 988], notification: [880, 659], complete: [523, 659, 784] } },
};

/** Short, friendly UI chimes; these never speak or send audio to a service. */
export function playMiloCue(kind: MiloCue, theme: MiloSoundTheme = "cute") {
  if (theme === "custom" && customSoundUrl) {
    const audio = new Audio(customSoundUrl);
    audio.volume = 0.7;
    void audio.play().catch(() => {});
    return;
  }
  if (typeof window === "undefined" || typeof window.AudioContext === "undefined") return;

  try {
    if (!cueContext || cueContext.state === "closed") cueContext = new AudioContext();
    const context = cueContext;
    const play = () => {
      const sound = CUE_THEMES[theme];
      const notes = sound.notes[kind];
      const start = context.currentTime;
      notes.forEach((frequency, index) => {
        const noteStart = start + index * 0.105;
        const duration = kind === "complete" && index === notes.length - 1 ? 0.2 : 0.12;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = sound.wave;
        oscillator.frequency.setValueAtTime(frequency, noteStart);
        gain.gain.setValueAtTime(0.0001, noteStart);
        gain.gain.exponentialRampToValueAtTime(sound.volume, noteStart + 0.018);
        gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + duration);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.onended = () => {
          oscillator.disconnect();
          gain.disconnect();
        };
        oscillator.start(noteStart);
        oscillator.stop(noteStart + duration + 0.01);
      });
    };

    if (context.state === "suspended") {
      void context.resume().then(play).catch((error: unknown) => {
        console.error("Could not resume MILO's sound cue.", error);
      });
      return;
    }
    play();
  } catch (error) {
    console.error("Could not play MILO's sound cue.", error);
  }
}

export function feedSession(playing: boolean, position: number, duration: number) {
  sess = { ...sess, playing, position, duration, syncedAt: performance.now() };
}

function ensure() { if (!el) { el = new Audio(); el.preload = "metadata"; } return el; }

function ensureGraph() {
  const a = ensure();
  if (ctx) { void ctx.resume(); return; }
  try {
    ctx = new AudioContext();
    const src = ctx.createMediaElementSource(a);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.75;
    data = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    src.connect(analyser);
    analyser.connect(ctx.destination);
  } catch { analyser = null; }
}

function audioTick() {
  if (!analyser || !data) return;
  analyser.getByteFrequencyData(data);
  const avg = (f: number, t: number) => { let s = 0; for (let i = f; i < t; i++) s += data![i]; return s / ((t - f) * 255); };
  const bass = avg(1, 12), mid = avg(12, 90), treble = avg(90, 220);
  const level = Math.min(1, bass * 0.6 + mid * 0.3 + treble * 0.1);

  history.push(bass); if (history.length > 45) history.shift();
  const mean = history.reduce((a, b) => a + b, 0) / history.length;
  const now = performance.now();
  if (bass > mean * 1.32 && bass > 0.16 && now - lastBeat > 240) {
    if (lastBeat) {
      gaps.push(now - lastBeat); if (gaps.length > 8) gaps.shift();
      const sorted = [...gaps].sort((a, b) => a - b);
      vibeFrame.bpm = Math.round(60000 / sorted[Math.floor(sorted.length / 2)]);
    }
    lastBeat = now; vibeFrame.beat = 1;
  }
  vibeFrame.beat *= 0.90;
  vibeFrame.level += (level - vibeFrame.level) * 0.25;
  vibeFrame.bass += (bass - vibeFrame.bass) * 0.3;
  vibeFrame.treble += (treble - vibeFrame.treble) * 0.2;
}

function sessionTick() {
  if (!sess.playing) {
    vibeFrame.level *= 0.9; vibeFrame.bass *= 0.9;
    vibeFrame.treble *= 0.9; vibeFrame.beat *= 0.9;
    return;
  }
  const elapsed = (performance.now() - sess.syncedAt) / 1000;
  const t = sess.position + elapsed;
  const period = 60 / sess.bpmGuess;
  const phase = (t % period) / period;
  const pulse = Math.pow(1 - phase, 3);          // decaying kick each beat
  const sway = 0.5 + 0.5 * Math.sin(t * 1.6);

  vibeFrame.beat = pulse;
  vibeFrame.bass = 0.35 + pulse * 0.45;
  vibeFrame.level = 0.3 + pulse * 0.3 + sway * 0.15;
  vibeFrame.treble = 0.25 + sway * 0.3;
  vibeFrame.bpm = sess.bpmGuess;
}

function loop() {
  raf = requestAnimationFrame(loop);
  if (mode === "audio") audioTick();
  else if (mode === "session") sessionTick();
  else {
    vibeFrame.level *= 0.9; vibeFrame.bass *= 0.9;
    vibeFrame.treble *= 0.9; vibeFrame.beat *= 0.9;
  }
}
if (typeof window !== "undefined") loop();

export const player = {
  get el() { return ensure(); },
  load(src: string) { const a = ensure(); a.src = src; a.load(); },
  async play() { ensureGraph(); setVibeMode("audio"); await ensure().play(); },
  pause() { ensure().pause(); },
  setVolume(v: number) { ensure().volume = v; },
  seek(t: number) { ensure().currentTime = t; },
  dispose() { cancelAnimationFrame(raf); }
};
