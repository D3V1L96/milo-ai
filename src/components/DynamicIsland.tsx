import { useEffect, useRef, useState, type CSSProperties } from "react";
import { motion, AnimatePresence, useDragControls } from "framer-motion";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ChevronDown, Minus, BellRing, LayoutGrid, ListTodo, Clock3, Music2, RefreshCw,
  MessageSquare, Pin, PinOff, Volume2, VolumeX, Settings, Lock, Unlock, Plus, X, Camera, CameraOff,
  PhoneIncoming, Headphones
} from "lucide-react";
import MiloEyes from "./MiloEyes";
import ClockPanel from "./ClockPanel";
import MusicPlayer from "./MusicPlayer";
import ChatPanel, { type ChatLine } from "./ChatPanel";
import TaskStatusPanel from "./TaskStatusPanel";
import NotificationCenter from "./NotificationCenter";
import { useMiloBackend, type Metrics } from "../hooks/useMiloBackend";
import { useNotifications } from "../hooks/useNotifications";
import { useVibeFrame } from "../hooks/useVibeFrame";
import {
  feedSession, setVibeMode, getVibeMode, playMiloCue, loadCustomMiloSound, saveCustomMiloSound, setCustomMiloSound,
  type MiloCue, type MiloSoundTheme
} from "../lib/audioEngine";
import {
  EMPTY_MEDIA,
  type AudioOutputDevice,
  type MediaState,
  type VolumeState
} from "../lib/mediaTypes";
import type {
  Emotion, LlmStatus, MiloState, Notification, ReminderItem, ResearchStatus, SpeechLanguage
} from "../lib/types";

const spring = { type: "spring" as const, stiffness: 520, damping: 38, mass: 0.72 };
const APP_USAGE_KEY = "milo-app-usage-v1";
const PINNED_APPS_KEY = "milo-pinned-apps-v1";
const APP_INVENTORY_REFRESH_MS = 30_000;
const ISLAND_PREFS_KEY = "milo-island-preferences-v1";
const CHAT_HISTORY_KEY = "milo-chat-history-v1";

interface ChatThread {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatLine[];
}

function newChatId() {
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function readChatHistory(): { threads: ChatThread[]; activeId: string } {
  try {
    const stored = JSON.parse(window.localStorage.getItem(CHAT_HISTORY_KEY) || "null") as {
      threads?: unknown; activeId?: unknown;
    } | null;
    const threads = Array.isArray(stored?.threads) ? stored.threads.flatMap((item): ChatThread[] => {
      if (!item || typeof item !== "object") return [];
      const thread = item as Partial<ChatThread>;
      if (typeof thread.id !== "string" || !Array.isArray(thread.messages)) return [];
      const messages = thread.messages.filter((message): message is ChatLine => !!message
        && typeof message === "object" && typeof message.id === "string"
        && (message.role === "user" || message.role === "assistant")
        && typeof message.content === "string");
      return [{
        id: thread.id,
        title: typeof thread.title === "string" ? thread.title : "Previous chat",
        updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt : 0,
        messages,
      }];
    }).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50) : [];
    const activeId = typeof stored?.activeId === "string" ? stored.activeId : "";
    return { threads, activeId: threads.some((thread) => thread.id === activeId) ? activeId : newChatId() };
  } catch { return { threads: [], activeId: newChatId() }; }
}

interface IslandTheme {
  id: string;
  name: string;
  accent: string;
  accent2: string;
}

interface IslandPreferences {
  opacity: number;
  themeId: string;
  customThemes: IslandTheme[];
  x: number;
  y: number;
  locked: boolean;
  soundTheme: MiloSoundTheme;
  customSoundName?: string;
  speechLanguage: SpeechLanguage;
}

const BUILTIN_THEMES: IslandTheme[] = [
  { id: "ocean", name: "Ocean", accent: "#2997ff", accent2: "#8bd1ff" },
  { id: "rose", name: "Rose", accent: "#ff5f87", accent2: "#ffb1c2" },
  { id: "mint", name: "Mint", accent: "#36c995", accent2: "#a7f3d0" },
  { id: "amber", name: "Amber", accent: "#f4ae45", accent2: "#ffe0a3" },
];

const DEFAULT_ISLAND_PREFS: IslandPreferences = {
  opacity: 90, themeId: "ocean", customThemes: [], x: 0, y: 0, locked: false,
  soundTheme: "cute", speechLanguage: "en-IN",
};

function readIslandPreferences(): IslandPreferences {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(ISLAND_PREFS_KEY) || "null");
    if (!stored || typeof stored !== "object") return DEFAULT_ISLAND_PREFS;
    const value = stored as Partial<IslandPreferences>;
    const customThemes = Array.isArray(value.customThemes)
      ? value.customThemes.filter((theme): theme is IslandTheme =>
        !!theme && typeof theme.id === "string" && typeof theme.name === "string"
        && /^#[\da-f]{6}$/i.test(theme.accent) && /^#[\da-f]{6}$/i.test(theme.accent2)
      )
      : [];
    const availableThemes = [...BUILTIN_THEMES, ...customThemes];
    return {
      opacity: typeof value.opacity === "number" ? Math.max(35, Math.min(98, value.opacity)) : 90,
      themeId: availableThemes.some((theme) => theme.id === value.themeId) ? value.themeId! : "ocean",
      customThemes,
      x: typeof value.x === "number" && Number.isFinite(value.x) ? value.x : 0,
      y: typeof value.y === "number" && Number.isFinite(value.y) ? value.y : 0,
      locked: value.locked === true,
      soundTheme: ["cute", "soft", "pixel", "chime", "bubble", "sparkle", "retro", "bell", "marimba", "pop", "arcade", "plucky", "custom"].includes(value.soundTheme || "")
        ? value.soundTheme as MiloSoundTheme : "cute",
      customSoundName: typeof value.customSoundName === "string" ? value.customSoundName : undefined,
      speechLanguage: ["en-IN", "hi-IN", "en-US"].includes(value.speechLanguage || "")
        ? value.speechLanguage as SpeechLanguage : "en-IN",
    };
  } catch {
    return DEFAULT_ISLAND_PREFS;
  }
}

interface InstalledApp {
  name: string;
  installed: boolean;
  running: boolean;
  windows: number;
}

function isInstalledApp(value: unknown): value is InstalledApp {
  if (!value || typeof value !== "object") return false;
  return "name" in value && typeof value.name === "string"
    && "installed" in value && typeof value.installed === "boolean"
    && "running" in value && typeof value.running === "boolean"
    && "windows" in value && typeof value.windows === "number";
}

function readAppUsage(): Record<string, number> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(APP_USAGE_KEY) || "{}");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    return Object.fromEntries(
      Object.entries(stored).filter(([name, count]) =>
        name.trim() && typeof count === "number" && Number.isFinite(count) && count > 0
      )
    );
  } catch {
    return {};
  }
}

function readPinnedApps(): string[] {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(PINNED_APPS_KEY) || "[]");
    return Array.isArray(stored)
      ? [...new Set(stored.filter((name): name is string =>
        typeof name === "string" && name.trim().length > 0
      ))]
      : [];
  } catch {
    return [];
  }
}

function requestsSearchResults(text: string): boolean {
  return /\bresults?\b/i.test(text) &&
    /\b(?:show|open|display|browser|dikha\w*|khol\w*)\b/i.test(text);
}

function requestedSearchQuery(text: string): string {
  const match = text.match(
    /\b(?:search|research|look up|find)\s+(?:for\s+)?(.+?)(?:\s+(?:(?:and|then)\s+)?(?:show|open|display|browser|dikha\w*|khol\w*).*)?$/i
  );
  const query = match?.[1]?.trim().replace(/\s+(?:search\s+)?results?$/i, "");
  if (!query || /^(?:search\s+)?results?$/i.test(query)) return "";
  return query;
}

function emotionFromText(text: string): Emotion | null {
  const value = text.toLowerCase().replace(/[’‘]/g, "'");
  // Match emotional moments first, before broad words like "happy" or "help".
  if (/\b(suicid\w*|kill myself|self harm|hopeless|depress\w*|heartbroken|grief|lonely|alone|sad|crying|dukhi|udaas|akela|pareshan|bura lag)\b/.test(value)) return "loving";
  if (/\b(anxious|anxiety|scared|afraid|worried|panic|nervous|dar lag|ghabra|tension)\b/.test(value)) return "worried";
  if (/\b(angry|furious|frustrated|annoyed|gussa|irritated|bakwas|bug|doesn't work|not working)\b/.test(value)) return "frustrated";
  if (/\b(congratulations|congrats|proud of you|you did it|i did it|got the job|passed|achieved|yay|woohoo|khushkhabri)\b/.test(value)) return "triumphant";
  if (/\b(excited|amazing|awesome|thrilled|yay|celebrate|proud|khush|happy|great news|bahut accha)\b/.test(value)) return "joyful";
  if (/\b(thankful|grateful|thanks|thank you|shukriya|dhanyavaad)\b/.test(value)) return "grateful";
  if (/\b(confused|don't understand|dunno|unsure|uljhan|kaise|what does|what is|why does|how do)\b/.test(value) || /\?$/.test(value)) return "curious";
  if (/\b(hello|hi|hey|good morning|good night|namaste|kaise ho|kya haal)\b/.test(value)) return "excited";
  if (/\b(love|miss you|care about|pyaar|best friend)\b/.test(value)) return "loving";
  if (/\b(sorry|understand|here for you|that sounds hard|i hear you|i'm listening|koi baat nahi|main hoon)\b/.test(value)) return "loving";
  if (/\b(haha|funny|joke|lol|mazak|hehe|😂|😄|😹)\b/.test(value)) return "playful";
  if (/\b(please help|help me|can you help|urgent|jaldi|emergency)\b/.test(value)) return "focused";
  return null;
}

export default function DynamicIsland() {
  const [initialChatHistory] = useState(readChatHistory);
  const [chatThreads, setChatThreads] = useState<ChatThread[]>(initialChatHistory.threads);
  const [activeChatId, setActiveChatId] = useState(initialChatHistory.activeId);
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [preferences, setPreferences] = useState(readIslandPreferences);
  const soundFileInput = useRef<HTMLInputElement | null>(null);
  const [themeName, setThemeName] = useState("");
  const [themeColor, setThemeColor] = useState("#58b9ff");
  const [showNotifs, setShowNotifs] = useState(true);
  const [panelMode, setPanelMode] = useState<
    "clock" | "music" | "chat" | "tasks" | "notifications" | "apps"
  >("clock");
  const [emotion, setEmotion] = useState<Emotion>("calm");
  const [state, setState] = useState<MiloState>("IDLE");
  const [message, setMessage] = useState("Ready when you are.");
  const [progress, setProgress] = useState(0);
  const [research, setResearch] = useState<ResearchStatus | null>(null);
  const [reminders, setReminders] = useState<ReminderItem[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatLine[]>(() =>
    initialChatHistory.threads.find((thread) => thread.id === initialChatHistory.activeId)?.messages || []
  );
  const [chatPending, setChatPending] = useState(false);
  const [pendingChatRequest, setPendingChatRequest] = useState("");
  const [appUsage, setAppUsage] = useState<Record<string, number>>(readAppUsage);
  const [pinnedApps, setPinnedApps] = useState<string[]>(readPinnedApps);
  const [appStorageError, setAppStorageError] = useState("");
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);
  const [appInventoryError, setAppInventoryError] = useState("");
  const [appInventoryLoading, setAppInventoryLoading] = useState(false);
  const [appInventoryRefresh, setAppInventoryRefresh] = useState(0);
  const [appFilter, setAppFilter] = useState("");
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [voiceMuted, setVoiceMuted] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [metrics, setMetrics] = useState<Metrics>({});
  const [media, setMedia] = useState<MediaState>(EMPTY_MEDIA);
  const [volume, setVolume] = useState<VolumeState>({ value: 0.5, muted: false });
  const [device, setDevice] = useState<AudioOutputDevice>({ name: "", connected: false });
  const [islandNotice, setIslandNotice] = useState<{
    kind: "device" | "call" | "battery"; title: string; detail: string; percent?: number
  } | null>(null);
  const [notificationStatus, setNotificationStatus] = useState<{
    available: boolean; error?: string
  } | null>(null);
  const [cameraTracking, setCameraTracking] = useState(false);
  const [gazeLook, setGazeLook] = useState<{ x: number; y: number } | null>(null);
  const [gazeStatus, setGazeStatus] = useState("");

  const cueTimer = useRef<number | null>(null);
  const dragControls = useDragControls();
  const dragEndedAt = useRef(0);
  const waveBars = useRef<(HTMLSpanElement | null)[]>([]);
  const gazeVideo = useRef<HTMLVideoElement | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const previousDevice = useRef<AudioOutputDevice | null>(null);
  const previousMetrics = useRef<Metrics | null>(null);
  const notif = useNotifications();
  const announce = (notice: { kind: "device" | "call" | "battery"; title: string; detail: string; percent?: number }, duration = 7000) => {
    setIslandNotice(notice);
    setOpen(true);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setIslandNotice(null), duration);
  };
  const activeTheme = [...BUILTIN_THEMES, ...preferences.customThemes]
    .find((theme) => theme.id === preferences.themeId) || BUILTIN_THEMES[0];
  const islandStyle = {
    "--island-opacity": preferences.opacity / 100,
    "--accent": activeTheme.accent,
    "--accent-2": activeTheme.accent2,
  } as CSSProperties;

  const playCue = (kind: MiloCue) => {
    if (voiceMuted) return;
    playMiloCue(kind, preferences.soundTheme);
    setSpeaking(true);
    if (cueTimer.current !== null) window.clearTimeout(cueTimer.current);
    cueTimer.current = window.setTimeout(() => {
      cueTimer.current = null;
      setSpeaking(false);
    }, 380);
  };

  useEffect(() => () => {
    if (cueTimer.current !== null) window.clearTimeout(cueTimer.current);
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    let saveTimer = 0;
    void getCurrentWindow().onMoved(({ payload }) => {
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        void invoke("save_window_position", { x: payload.x, y: payload.y }).catch(() => {});
      }, 250);
    }).then((stop) => { if (active) unlisten = stop; else stop(); });
    return () => { active = false; unlisten?.(); window.clearTimeout(saveTimer); };
  }, []);

  useEffect(() => {
    if (!cameraTracking) { setGazeLook(null); setGazeStatus(""); return; }
    let active = true;
    let stream: MediaStream | null = null;
    let timer = 0;
    let landmarker: { detectForVideo: (frame: HTMLVideoElement, timestamp: number) => { faceLandmarks: { x: number; y: number }[][] }; close: () => void } | null = null;
    const trackFace = async () => {
      if (!navigator.mediaDevices?.getUserMedia) { setGazeStatus("Camera access is not available here."); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
        if (!active || !gazeVideo.current) { stream.getTracks().forEach((track) => track.stop()); return; }
        gazeVideo.current.srcObject = stream;
        await gazeVideo.current.play();
        const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
        const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm", false);
        if (!active) return;
        landmarker = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: "/mediapipe/models/face_landmarker.task" },
          runningMode: "VIDEO",
          numFaces: 1,
        });
        if (!active) { landmarker.close(); return; }
        setGazeStatus("Looking locally for your face. Camera frames stay on this device.");
        const scan = async () => {
          if (!active || !gazeVideo.current) return;
          try {
            const [face] = landmarker!.detectForVideo(gazeVideo.current, performance.now()).faceLandmarks;
            if (face?.length) {
              const nose = face[1];
              setGazeLook({
                x: Math.max(-4, Math.min(4, (nose.x - 0.5) * 8)),
                y: Math.max(-3, Math.min(3, (nose.y - 0.5) * 6)),
              });
            } else setGazeLook(null);
          } catch { /* The camera may momentarily return no detectable frame. */ }
          if (active) timer = window.setTimeout(() => { void scan(); }, 220);
        };
        void scan();
      } catch {
        stream?.getTracks().forEach((track) => track.stop());
        stream = null;
        if (gazeVideo.current) gazeVideo.current.srcObject = null;
        if (active) setGazeStatus("Camera permission, connection, or face-tracking model is unavailable.");
      }
    };
    void trackFace();
    return () => {
      active = false;
      window.clearTimeout(timer);
      landmarker?.close();
      stream?.getTracks().forEach((track) => track.stop());
      if (gazeVideo.current) gazeVideo.current.srcObject = null;
    };
  }, [cameraTracking]);

  useEffect(() => {
    try {
      window.localStorage.setItem(ISLAND_PREFS_KEY, JSON.stringify(preferences));
    } catch { /* keep the current session usable when storage is unavailable */ }
  }, [preferences]);

  useEffect(() => {
    if (!chatMessages.length && !chatThreads.some((thread) => thread.id === activeChatId)) return;
    setChatThreads((threads) => {
      const firstUserMessage = chatMessages.find((item) => item.role === "user")?.content.trim();
      const title = firstUserMessage ? firstUserMessage.slice(0, 48) : "New chat";
      const updated: ChatThread = {
        id: activeChatId, title, updatedAt: Date.now(),
        messages: chatMessages.slice(-30).map((item) => ({ ...item, content: item.content.slice(0, 3000) })),
      };
      return [updated, ...threads.filter((thread) => thread.id !== activeChatId)]
        .slice(0, 20);
    });
  }, [chatMessages, activeChatId]);

  useEffect(() => {
    try {
      window.localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify({ threads: chatThreads, activeId: activeChatId }));
    } catch { /* A full or unavailable browser store should not interrupt the current chat. */ }
  }, [chatThreads, activeChatId]);

  useVibeFrame((frame) => {
    const bands = [frame.bass, frame.level, frame.treble, (frame.bass + frame.beat) / 2];
    waveBars.current.forEach((bar, index) => {
      if (!bar) return;
      bar.style.height = `${3 + bands[index] * 9 + frame.beat * 4}px`;
      bar.style.opacity = String(0.5 + frame.level * 0.5);
    });
  }, media.playing || speaking);

  const startDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (preferences.locked) return;
    if (event.target instanceof Element && event.target.closest("button,input")) return;
    if (isTauri()) return;
    dragControls.start(event);
  };

  const addCustomTheme = () => {
    const name = themeName.trim();
    if (!name) return;
    const id = `custom-${Date.now()}`;
    const theme = { id, name, accent: themeColor, accent2: themeColor };
    setPreferences((current) => ({
      ...current,
      customThemes: [...current.customThemes, theme],
      themeId: id,
    }));
    setThemeName("");
  };

  const removeCustomTheme = (id: string) => {
    setPreferences((current) => ({
      ...current,
      customThemes: current.customThemes.filter((theme) => theme.id !== id),
      themeId: current.themeId === id ? "ocean" : current.themeId,
    }));
  };

  const previewSound = () => playMiloCue("complete", preferences.soundTheme);

  useEffect(() => {
    void loadCustomMiloSound().then((blob) => setCustomMiloSound(blob));
  }, []);

  const chooseCustomSound = async (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("audio/") || file.size > 10 * 1024 * 1024) {
      window.alert("Choose an audio file up to 10 MB.");
      return;
    }
    try {
      await saveCustomMiloSound(file);
      setCustomMiloSound(file);
      setPreferences((current) => ({ ...current, soundTheme: "custom", customSoundName: file.name }));
    } catch {
      window.alert("MILO could not save that sound in this browser.");
    }
  };

  const { connected, send } = useMiloBackend({
    onEvent: (e) => {
      if (e.notification) {
        const knownNotification = notif.items.some((item) => item.id === e.notification!.id) ||
          notif.keptItems.some((item) => item.id === e.notification!.id);
        const n = notif.push(e.notification);
        if (n) {
          playCue(n.kind === "task" ? "complete" : "notification");
          setShowNotifs(true);
          setEmotion(n.priority === "high" ? "confused" : "curious");
          if (!knownNotification && n.kind === "call" && n.callDirection === "incoming") {
            announce({ kind: "call", title: n.title || "Incoming call", detail: n.app });
          }
        }
      }
      if (e.dismiss) notif.remove(e.dismiss);
      if (e.clearAll) notif.clearAll();
      if (e.notificationStatus) setNotificationStatus(e.notificationStatus);
      const assistantIsActive = [
        "LISTENING", "THINKING", "RESEARCH", "SPEAKING", "WORKING"
      ].includes(state);
      const mediaShouldYield = e.source === "media" && assistantIsActive;
      if (e.state && !mediaShouldYield) setState(e.state);
      if (e.emotion && !mediaShouldYield) setEmotion(e.emotion);
      if (e.message && !mediaShouldYield) setMessage(e.message);
      if (typeof e.progress === "number") setProgress(e.progress);
      if (e.research) setResearch(e.research);
      if (e.reminders) setReminders(e.reminders);
      if (e.llmStatus) setLlmStatus(e.llmStatus);
      if (e.chatMessage) {
        if (e.chatMessage.requestId !== pendingChatRequest) return;
        if (!e.chatMessage.error) playCue("reply");
        setEmotion(emotionFromText(e.chatMessage.content) || "thoughtful");
        setChatMessages((items) => [...items, {
          id: `assistant-${e.chatMessage!.requestId}-${items.length}`,
          role: "assistant",
          content: e.chatMessage!.content,
          error: e.chatMessage!.error,
        }]);
        if (e.chatMessage.requestId === pendingChatRequest) {
          setChatPending(false);
          setPendingChatRequest("");
        }
      }
      const openedApp = e.state === "SUCCESS" && e.message?.match(/^Opened (.+)\.$/i)?.[1];
      if (openedApp) {
        setAppUsage((usage) => ({
          ...usage,
          [openedApp]: (usage[openedApp] || 0) + 1,
        }));
      }
      if (e.chatStatus && e.chatStatus.requestId === pendingChatRequest) {
        setChatPending(true);
        setState("THINKING");
        setEmotion("focused");
        setMessage("Thinking through your request...");
      }
    },
    onMetrics: (nextMetrics) => {
      setMetrics(nextMetrics);
      if (typeof nextMetrics.battery === "number") {
        setIslandNotice((current) => current?.kind === "battery"
          ? { ...current, percent: Math.round(nextMetrics.battery!) }
          : current);
      }
      const previous = previousMetrics.current;
      const batteryLevel = nextMetrics.battery;
      if (typeof batteryLevel === "number" && batteryLevel >= 100) {
        if (previous?.battery !== 100) {
          announce({ kind: "battery", title: "Battery fully charged", detail: "100% · Ready to go", percent: 100 });
        }
      } else if (typeof batteryLevel === "number" && nextMetrics.charging && previous?.charging !== true) {
        announce({ kind: "battery", title: "Charging", detail: "Power connected", percent: Math.round(batteryLevel) });
      } else if (typeof batteryLevel === "number" && batteryLevel <= 20 && !nextMetrics.charging &&
          (previous === null || previous.battery === undefined || previous.battery > 20 || previous.charging)) {
        announce({ kind: "battery", title: "Low battery", detail: "Connect a charger", percent: Math.round(batteryLevel) }, 9000);
      }
      previousMetrics.current = nextMetrics;
    },
    onMedia: (m) => {
      setMedia(m);
      feedSession(m.playing, m.position, m.duration);
      if (getVibeMode() !== "audio") setVibeMode(m.playing ? "session" : "off");
      if (m.playing) {
        if (!["LISTENING", "THINKING", "RESEARCH", "SPEAKING", "WORKING"].includes(state)) {
          setEmotion("vibing");
          setState("VIBING");
        }
      } else if (m.available && state === "VIBING") {
        setEmotion("calm"); setState("IDLE");
      } else if (!m.available && state === "VIBING") {
        setEmotion("calm"); setState("IDLE"); setMessage("Nothing playing.");
      }
    },
    onDevice: (nextDevice) => {
      const previous = previousDevice.current;
      if (previous && nextDevice.connected && nextDevice.name !== previous.name) {
        const airPods = /airpods/i.test(nextDevice.name);
        announce({
          kind: "device",
          title: airPods ? "AirPods connected" : "Device connected",
          detail: nextDevice.name,
        });
      }
      previousDevice.current = nextDevice;
      setDevice(nextDevice);
    },
    onVolume: setVolume
  });

  useEffect(() => () => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
  }, []);

  useEffect(() => {
    if (!connected) {
      setChatPending(false);
      setPendingChatRequest("");
    }
  }, [connected]);

  useEffect(() => {
    try {
      window.localStorage.setItem(APP_USAGE_KEY, JSON.stringify(appUsage));
      window.localStorage.setItem(PINNED_APPS_KEY, JSON.stringify(pinnedApps));
      setAppStorageError("");
    } catch (error) {
      setAppStorageError(error instanceof Error ? error.message : "Could not save app suggestions.");
    }
  }, [appUsage, pinnedApps]);

  useEffect(() => {
    if (!connected || (panelMode !== "apps" && panelMode !== "music")) return;
    let active = true;
    let inFlight = false;
    const refreshInventory = async () => {
      if (inFlight) return;
      inFlight = true;
      if (active) setAppInventoryLoading(true);
      try {
        const response = await fetch("http://127.0.0.1:8765/apps");
      const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const detail = payload && typeof payload === "object" && "detail" in payload
            && typeof payload.detail === "string"
            ? payload.detail
            : `App scan failed (${response.status}).`;
          throw new Error(
            response.status === 404
              ? "Installed-app scanning is unavailable. Restart the MILO backend."
              : detail
          );
        }
        if (
          !payload || typeof payload !== "object" || !("apps" in payload)
          || !Array.isArray(payload.apps) || !payload.apps.every(isInstalledApp)
        ) {
          throw new Error("The backend returned an invalid installed-app list.");
        }
        if (active) {
          setInstalledApps(payload.apps.filter((app) => app.installed));
          setAppInventoryError("");
        }
      } catch (error) {
        if (active) {
          setAppInventoryError(
            error instanceof Error ? error.message : "Could not scan installed apps."
          );
        }
      } finally {
        inFlight = false;
        if (active) setAppInventoryLoading(false);
      }
    };
    void refreshInventory();
    const timer = window.setInterval(() => { void refreshInventory(); }, APP_INVENTORY_REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [connected, panelMode, appInventoryRefresh]);

  const suggestedApps = [...new Set([
    ...pinnedApps,
    ...Object.entries(appUsage)
      .sort((left, right) => right[1] - left[1])
      .map(([app]) => app),
  ])];
  const filteredInstalledApps = installedApps.filter((app) =>
    app.name.toLowerCase().includes(appFilter.trim().toLowerCase())
  );
  const showNotifications = () => {
    if (panelMode !== "notifications") {
      setPanelMode("notifications");
      setShowNotifs(true);
    } else {
      setShowNotifs((visible) => !visible);
    }
  };

  const sendChat = (text: string, fileId?: string) => {
    // React immediately while listening; the reply can then bring its own mood.
    setEmotion(emotionFromText(text) || "interested");
    setState("LISTENING");
    if (requestsSearchResults(text) && !requestedSearchQuery(text) && research?.query) {
      if (send({ action: "open_search_results", query: research.query })) {
        setState("SUCCESS");
        setEmotion("curious");
        setMessage(`Opening DuckDuckGo results for: ${research.query}`);
        return;
      }
    }
    const requestId = crypto.randomUUID();
    const history = chatMessages.slice(-12).map(({ role, content }) => ({ role, content }));
    const userMessage: ChatLine = { id: `user-${requestId}`, role: "user", content: text };
    interruptSpeech();
    setChatMessages((items) => [...items, userMessage]);
    if (send({ action: "chat", requestId, message: text, history, fileId })) {
      setPendingChatRequest(requestId);
      setChatPending(true);
    } else {
      setChatMessages((items) => [...items, {
        id: `offline-${requestId}`,
        role: "assistant",
        content: "MILO backend is offline.",
        error: true,
      }]);
    }
  };

  const clearChat = () => {
    interruptSpeech();
    if (pendingChatRequest) send({ action: "cancel_chat" });
    setChatMessages([]);
    setChatPending(false);
    setPendingChatRequest("");
  };

  const startNewChat = () => {
    interruptSpeech();
    if (pendingChatRequest) send({ action: "cancel_chat" });
    setChatPending(false);
    setPendingChatRequest("");
    setActiveChatId(newChatId());
    setChatMessages([]);
  };

  const switchChat = (threadId: string) => {
    const thread = chatThreads.find((item) => item.id === threadId);
    if (!thread) return;
    interruptSpeech();
    if (pendingChatRequest) send({ action: "cancel_chat" });
    setChatPending(false);
    setPendingChatRequest("");
    setActiveChatId(thread.id);
    setChatMessages(thread.messages);
  };

  const deleteChat = (threadId: string) => {
    setChatThreads((threads) => threads.filter((thread) => thread.id !== threadId));
    if (threadId === activeChatId) startNewChat();
  };

  const togglePinnedApp = (app: string) => {
    setPinnedApps((apps) => apps.includes(app)
      ? apps.filter((item) => item !== app)
      : [...apps, app]);
  };

  const removeAppSuggestion = (app: string) => {
    setPinnedApps((apps) => apps.filter((item) => item !== app));
    setAppUsage((usage) => {
      const next = { ...usage };
      delete next[app];
      return next;
    });
  };

  const resetSpeakingState = () => {
    setSpeaking(false);
    setState((current) => current === "SPEAKING" ? "IDLE" : current);
    setEmotion((current) => current === "content" ? "calm" : current);
    setMessage((current) => current === "Speaking..." ? "Ready when you are." : current);
  };

  const handleListeningChange = (listening: boolean, listeningMessage?: string) => {
    if (listening) {
      playCue(listeningMessage?.startsWith("MILO is active") ? "wake" : "listening");
      setState("LISTENING");
      setEmotion("interested");
      setMessage(listeningMessage || "Listening...");
    } else {
      setState((current) => current === "LISTENING" ? "IDLE" : current);
      setEmotion((current) => current === "interested" ? "calm" : current);
      setMessage((current) => current === "Listening..." ? "Ready when you are." : current);
    }
  };

  const toggleVoice = () => {
    if (!voiceMuted) {
      interruptSpeech();
    }
    setVoiceMuted((muted) => !muted);
  };

  const interruptSpeech = () => {
    if (cueTimer.current !== null) window.clearTimeout(cueTimer.current);
    cueTimer.current = null;
    resetSpeakingState();
  };

  const openNotificationApp = (notification: Notification) => {
    if (!send({
      action: "open_notification",
      app: notification.app,
      appId: notification.appId,
    })) {
      setState("ERROR");
      setEmotion("confused");
      setMessage("Backend offline. Could not open the notification app.");
    }
  };

  const deleteNotification = (id: string) => {
    notif.remove(id);
    send({ action: "dismiss", id });
  };

  const clearNotifications = () => {
    notif.clearAll();
    send({ action: "clear_notifications" });
  };

  return (
    <div className="island-wrap">
      <video ref={gazeVideo} className="gaze-video" muted playsInline aria-hidden="true" />
      <motion.div
        className={`island ${preferences.locked ? "locked" : ""}`}
        style={islandStyle}
        role="button" tabIndex={0} aria-expanded={open}
        aria-label={open ? "Collapse MILO" : "Expand MILO"}
        title={preferences.locked ? "MILO position locked · double-click to unlock" : "Drag to move · double-click to lock"}
        drag={!isTauri() && !preferences.locked}
        dragControls={dragControls}
        dragListener={false}
        dragMomentum={false}
        dragElastic={0.05}
        dragConstraints={{
          left: -Math.max(0, window.innerWidth / 2 - (open ? 193 : 66)),
          right: Math.max(0, window.innerWidth / 2 - (open ? 193 : 66)),
          top: -14,
          bottom: Math.max(-14, window.innerHeight - (open ? 514 : 48) - 14),
        }}
        onDragEnd={(_, info) => {
          dragEndedAt.current = Date.now();
          const xLimit = Math.max(0, window.innerWidth / 2 - (open ? 193 : 66));
          const yLimit = Math.max(-14, window.innerHeight - (open ? 514 : 48) - 14);
          setPreferences((current) => ({
            ...current,
            x: Math.max(-xLimit, Math.min(xLimit, current.x + info.offset.x)),
            y: Math.max(-14, Math.min(yLimit, current.y + info.offset.y)),
          }));
        }}
        onClick={(event) => {
          if (Date.now() - dragEndedAt.current < 250) return;
          if (event.target instanceof Element && event.target.closest("button,input")) return;
          setOpen((o) => !o);
        }}
        onDoubleClick={(event) => {
          if (event.target instanceof Element && event.target.closest("button,input")) return;
          event.preventDefault();
          event.stopPropagation();
          setPreferences((current) => ({ ...current, locked: !current.locked }));
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((o) => !o); }
        }}
        initial={{ width: 132, height: 34, borderRadius: 20, y: -40, opacity: 0 }}
        animate={{
          width: open ? 386 : 132,
          height: open
            ? settingsOpen ? 430 : panelMode === "notifications" && showNotifs ? 500 : islandNotice ? 410 : 360
            : 34,
          borderRadius: open ? 34 : 20, x: isTauri() ? 0 : preferences.x, y: isTauri() ? 0 : preferences.y, opacity: 1
        }}
        transition={spring}
        whileHover={open ? {} : { width: 152, height: 38 }}
        whileTap={{ scale: 0.985 }}
      >
        <AnimatePresence mode="wait" initial={false}>
          {!open ? (
            <motion.div key="compact" className={`compact ${media.playing || speaking ? "has-wave" : ""}`}
              data-tauri-drag-region="true"
              onPointerDown={startDrag}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.14 }}>
              <MiloEyes emotion={emotion} size={0.52} lookAt={gazeLook} />
              {(media.playing || speaking) && (
                <span
                  className={`mini-wave ${speaking ? "speaking" : ""}`}
                  role="img"
                  aria-label={speaking && media.playing
                    ? "MILO chime and music playing"
                    : speaking ? "MILO chime" : "Music playing"}
                >
                  {[0, 1, 2, 3].map((index) => (
                    <span key={index} ref={(bar) => { waveBars.current[index] = bar; }} />
                  ))}
                </span>
              )}
              {notif.unread > 0 && <span className="badge">{notif.unread}</span>}
              <ChevronDown size={13} color="var(--muted)" />
            </motion.div>
          ) : (
            <motion.div key="panel" className="panel"
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2, delay: 0.06 }}>

              <div className="head">
                <div className="head-left" data-tauri-drag-region="true" onPointerDown={startDrag}>
                  <MiloEyes emotion={emotion} size={0.72} lookAt={gazeLook} />
                  <div>
                    <div className={`state state-${state.toLowerCase()}`}>{state}</div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    className={`icon-btn ${settingsOpen ? "on" : ""}`}
                    aria-label={settingsOpen ? "Close MILO settings" : "Open MILO settings"}
                    aria-pressed={settingsOpen}
                    title="Customize MILO"
                    onClick={(e) => { e.stopPropagation(); setSettingsOpen((visible) => !visible); }}
                  >
                    <Settings size={14} />
                  </button>
                  <button
                    className={`icon-btn ${voiceMuted ? "" : "on"}${speaking ? " speaking" : ""}`}
                    aria-pressed={voiceMuted}
                    aria-label={voiceMuted ? "Unmute Milo sounds" : "Mute Milo sounds"}
                    title={voiceMuted ? "Unmute MILO sound cues" : "Mute MILO sound cues"}
                    onClick={(e) => { e.stopPropagation(); toggleVoice(); }}
                  >
                    {voiceMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                  </button>
                  <button className={`icon-btn ${panelMode === "notifications" && showNotifs ? "on" : ""}`}
                    aria-pressed={panelMode === "notifications" && showNotifs}
                    aria-label="Toggle notifications"
                    title={panelMode === "notifications" && showNotifs
                      ? "Hide notifications" : "Show notifications"}
                    onClick={(e) => { e.stopPropagation(); showNotifications(); }}>
                    <BellRing size={14} />
                  </button>
                  <button className="icon-btn" aria-label="Minimize"
                    onClick={(e) => { e.stopPropagation(); setOpen(false); }}>
                    <Minus size={14} />
                  </button>
                </div>
              </div>

              {connected && typeof metrics.cpu === "number" && (
                <div className="metrics" onClick={(e) => e.stopPropagation()}>
                  <span>CPU {metrics.cpu}%</span>
                  <span>RAM {metrics.ram}%</span>
                  {typeof metrics.battery === "number" && (
                    <span className="battery-chip" aria-label={"Battery " + Math.round(metrics.battery) + " percent"}>
                      Battery {Math.round(metrics.battery)}%
                    </span>
                  )}
                </div>
              )}

              <AnimatePresence initial={false}>
                {islandNotice && (
                  <motion.div
                    key={islandNotice.kind + islandNotice.title}
                    className={"island-event " + (islandNotice.kind === "call" ? "call-event"
                      : islandNotice.kind === "battery" ? islandNotice.title === "Low battery" ? "low-event"
                        : islandNotice.title === "Battery fully charged" ? "full-event" : "charging-event"
                      : "device-event")}
                    role="status"
                    aria-live={islandNotice.kind === "call" || islandNotice.title === "Low battery" ? "assertive" : "polite"}
                    initial={{ opacity: 0, height: 0, y: -5 }}
                    animate={{ opacity: 1, height: "auto", y: 0 }}
                    exit={{ opacity: 0, height: 0, y: -4 }}
                    transition={{ duration: 0.18, ease: "easeOut" }}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (islandNotice.kind === "call") {
                        setPanelMode("notifications");
                        setShowNotifs(true);
                      }
                    }}
                  >
                    {islandNotice.kind === "battery" ? (
                      <>
                        <strong className="charge-title">{islandNotice.title === "Battery fully charged" ? "Charged"
                          : islandNotice.title === "Low battery" ? "Low Battery" : "Charging"}</strong>
                        <span className="charge-readout">
                          <strong>{islandNotice.percent ?? 0}%</strong>
                          <span className="charge-gauge" aria-hidden="true">
                            <i style={{ width: String(Math.max(0, Math.min(100, islandNotice.percent ?? 0))) + "%" }} />
                          </span>
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="event-icon">
                          {islandNotice.kind === "call" ? <PhoneIncoming size={17} />
                            : /airpods/i.test(islandNotice.detail)
                              ? <span className="airpods-glyph" aria-hidden="true"><i /><i /></span>
                              : <Headphones size={16} />}
                          {islandNotice.kind === "call" && <span className="call-ripple" />}
                        </span>
                        <span className="notice-copy">
                          <strong>{islandNotice.title}</strong>
                          <small>{islandNotice.detail}</small>
                        </span>
                        {islandNotice.kind === "call" && <span className="notice-hint">View</span>}
                      </>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="panel-switch" role="tablist" aria-label="MILO panel" onClick={(e) => e.stopPropagation()}>
                <motion.span
                  className="panel-switch-thumb"
                  initial={false}
                  animate={{
                    x: panelMode === "apps" ? "500%" :
                      panelMode === "notifications" ? "400%" :
                        panelMode === "tasks" ? "300%" :
                          panelMode === "chat" ? "200%" :
                            panelMode === "music" ? "100%" : "0%"
                  }}
                  transition={{ type: "spring", stiffness: 500, damping: 34 }}
                />
                <button
                  type="button"
                  role="tab"
                  aria-selected={panelMode === "clock"}
                  className={panelMode === "clock" ? "selected" : ""}
                  onClick={() => setPanelMode("clock")}
                >
                  <Clock3 size={13} /> Time
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={panelMode === "music"}
                  className={panelMode === "music" ? "selected" : ""}
                  onClick={() => setPanelMode("music")}
                >
                  <Music2 size={13} /> Music
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={panelMode === "chat"}
                  className={panelMode === "chat" ? "selected" : ""}
                  onClick={() => setPanelMode("chat")}
                >
                  <MessageSquare size={13} /> Chat
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={panelMode === "tasks"}
                  className={panelMode === "tasks" ? "selected" : ""}
                  onClick={() => setPanelMode("tasks")}
                >
                  <ListTodo size={13} /> Tasks
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={panelMode === "notifications"}
                  onClick={() => { setPanelMode("notifications"); setShowNotifs(true); }}
                >
                  <BellRing size={13} /> Alerts
                  {notif.unread > 0 && <span className="panel-tab-count">{notif.unread}</span>}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={panelMode === "apps"}
                  onClick={() => setPanelMode("apps")}
                >
                  <LayoutGrid size={13} /> Apps
                </button>
              </div>

              <div className="panel-content" onClick={(e) => e.stopPropagation()}>
                <div className="panel-view settings-view" hidden={!settingsOpen}>
                  <div className="settings-heading">
                    <div><strong>Appearance</strong><span>Make MILO feel like yours</span></div>
                    <button
                      type="button"
                      className={`lock-control ${preferences.locked ? "selected" : ""}`}
                      aria-pressed={preferences.locked}
                      onClick={() => setPreferences((current) => ({ ...current, locked: !current.locked }))}
                    >
                      {preferences.locked ? <Lock size={13} /> : <Unlock size={13} />}
                      {preferences.locked ? "Locked" : "Lock position"}
                    </button>
                  </div>
                  <div className="setting-row gaze-setting">
                    <span><strong>Look at me</strong><small>{gazeStatus || "Camera tracking is optional and processed locally"}</small></span>
                    <button type="button" className={`icon-btn ${cameraTracking ? "on" : ""}`} aria-pressed={cameraTracking}
                      aria-label={cameraTracking ? "Turn off camera gaze tracking" : "Turn on camera gaze tracking"}
                      onClick={() => setCameraTracking((enabled) => !enabled)}>
                      {cameraTracking ? <CameraOff size={14} /> : <Camera size={14} />}
                    </button>
                  </div>
                  <label className="setting-row sound-setting" htmlFor="milo-sound-theme">
                    <span><strong>Companion sounds</strong><small>Choose and preview MILO's cues</small></span>
                    <div className="sound-setting-controls">
                      <select
                        id="milo-sound-theme"
                        className="setting-select"
                        value={preferences.soundTheme}
                        onChange={(event) => setPreferences((current) => ({
                          ...current, soundTheme: event.target.value as MiloSoundTheme,
                        }))}
                      >
                        <option value="cute">Cute</option>
                        <option value="soft">Soft</option>
                        <option value="pixel">Pixel</option>
                        <option value="chime">Chime</option>
                        <option value="bubble">Bubble</option>
                        <option value="sparkle">Sparkle</option>
                        <option value="retro">Retro</option>
                        <option value="bell">Bell</option>
                        <option value="marimba">Marimba</option>
                        <option value="pop">Pop</option>
                        <option value="arcade">Arcade</option>
                        <option value="plucky">Plucky</option>
                        <option value="custom">Custom sound</option>
                      </select>
                      <button type="button" className="icon-btn on" aria-label="Preview selected MILO sound"
                        title="Preview selected sound" onClick={previewSound}>
                        <Volume2 size={14} />
                      </button>
                    </div>
                  </label>
                  <div className="setting-row sound-setting">
                    <span><strong>Your sound</strong><small>{preferences.customSoundName || "Upload an audio file (up to 10 MB)"}</small></span>
                    <div className="sound-setting-controls">
                      <input ref={soundFileInput} type="file" accept="audio/*" hidden
                        onChange={(event) => { void chooseCustomSound(event.target.files?.[0]); event.target.value = ""; }} />
                      <button type="button" className="icon-btn" aria-label="Choose a custom MILO sound"
                        title="Choose custom sound" onClick={() => soundFileInput.current?.click()}><Plus size={14} /></button>
                    </div>
                  </div>
                  <label className="setting-row sound-setting" htmlFor="milo-speech-language">
                    <span><strong>Spoken commands</strong><small>PyAudio mic · audio sent to Google for transcription</small></span>
                    <select
                      id="milo-speech-language"
                      className="setting-select language-select"
                      value={preferences.speechLanguage}
                      onChange={(event) => setPreferences((current) => ({
                        ...current, speechLanguage: event.target.value as SpeechLanguage,
                      }))}
                    >
                      <option value="en-IN">English / Hinglish</option>
                      <option value="hi-IN">Hindi</option>
                      <option value="en-US">English (US)</option>
                    </select>
                  </label>
                  <label className="setting-row" htmlFor="island-opacity">
                    <span><strong>Glass transparency</strong><small>{preferences.opacity}% opacity</small></span>
                    <input
                      id="island-opacity"
                      className="settings-range"
                      type="range"
                      min="35"
                      max="98"
                      value={preferences.opacity}
                      style={{ background: `linear-gradient(to right, var(--accent) ${((preferences.opacity - 35) / 63) * 100}%, rgba(255,255,255,.16) ${((preferences.opacity - 35) / 63) * 100}%)` }}
                      onChange={(event) => setPreferences((current) => ({
                        ...current, opacity: Number(event.target.value),
                      }))}
                    />
                  </label>
                  <div className="theme-section">
                    <div className="setting-label"><strong>Color themes</strong><small>Choose a look</small></div>
                    <div className="theme-grid">
                      {[...BUILTIN_THEMES, ...preferences.customThemes].map((theme) => (
                        <div className="theme-choice-wrap" key={theme.id}>
                          <button
                            type="button"
                            className={`theme-choice ${preferences.themeId === theme.id ? "selected" : ""}`}
                            aria-pressed={preferences.themeId === theme.id}
                            onClick={() => setPreferences((current) => ({ ...current, themeId: theme.id }))}
                          >
                            <span className="theme-swatch" style={{ background: theme.accent }} />
                            <span>{theme.name}</span>
                          </button>
                          {theme.id.startsWith("custom-") && (
                            <button
                              type="button"
                              className="theme-remove"
                              aria-label={`Remove ${theme.name} theme`}
                              onClick={() => removeCustomTheme(theme.id)}
                            ><X size={11} /></button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                  <form className="theme-create" onSubmit={(event) => { event.preventDefault(); addCustomTheme(); }}>
                    <input
                      type="text"
                      aria-label="New theme name"
                      placeholder="New theme name"
                      maxLength={18}
                      value={themeName}
                      onChange={(event) => setThemeName(event.target.value)}
                    />
                    <input
                      type="color"
                      aria-label="New theme accent color"
                      value={themeColor}
                      onChange={(event) => setThemeColor(event.target.value)}
                    />
                    <button type="submit" aria-label="Add custom theme" title="Add custom theme" disabled={!themeName.trim()}>
                      <Plus size={14} />
                    </button>
                  </form>
                </div>
                <div className="panel-view clock-view" hidden={settingsOpen || panelMode !== "clock"}>
                  <ClockPanel />
                </div>
                <div className="panel-view" hidden={settingsOpen || panelMode !== "music"}>
                  <MusicPlayer
                    media={media}
                    volume={volume}
                    device={device}
                    connected={connected}
                    send={send}
                    installedApps={installedApps}
                    onPlayYouTube={(query) => sendChat("play " + query + " on YouTube")}
                  />
                </div>
                <div className="panel-view" hidden={settingsOpen || panelMode !== "chat"}>
                  <ChatPanel
                    messages={chatMessages}
                    conversations={chatThreads}
                    activeConversationId={activeChatId}
                    pending={chatPending}
                    assistantState={state}
                    connected={connected}
                    llm={llmStatus}
                    voiceMuted={voiceMuted}
                    speaking={speaking}
                    speechLanguage={preferences.speechLanguage}
                    send={send}
                    onSend={sendChat}
                    onClearChat={clearChat}
                    onNewChat={startNewChat}
                    onSelectConversation={switchChat}
                    onDeleteConversation={deleteChat}
                    onListeningChange={handleListeningChange}
                    onInterruptSpeech={interruptSpeech}
                  />
                </div>
                <div className="panel-view" hidden={settingsOpen || panelMode !== "tasks"}>
                  <TaskStatusPanel
                    state={state}
                    message={message}
                    progress={progress}
                    research={research}
                    reminders={reminders}
                    connected={connected}
                    send={send}
                  />
                </div>
                <div className="panel-view notification-view" hidden={settingsOpen || panelMode !== "notifications"}>
                  {showNotifs ? (
                    <NotificationCenter
                      items={notif.items}
                      keptItems={notif.keptItems}
                      unread={notif.unread}
                      storageError={notif.storageError}
                      status={notificationStatus}
                      onKeep={notif.keep}
                      onDelete={deleteNotification}
                      onRestore={notif.restore}
                      onRead={notif.markRead}
                      onOpen={openNotificationApp}
                      onReply={(notification, reply) => {
                        sendChat(`send whatsapp message to ${notification.title} saying ${reply}`);
                      }}
                      onClear={clearNotifications}
                    />
                  ) : (
                    <p className="nc-empty">Notifications are hidden. Use the bell to show them.</p>
                  )}
                </div>
                <div className="panel-view" hidden={settingsOpen || panelMode !== "apps"}>
                  <div className="apps-tray" aria-label="Pinned and frequently used apps">
                    <div className="apps-tray-heading">
                      <strong>Frequently used apps</strong>
                      <span>Top apps open from MILO</span>
                    </div>
                    {appStorageError && <p className="panel-error" role="alert">{appStorageError}</p>}
                    {suggestedApps.length ? (
                      <div className="apps-tray-list">
                        {suggestedApps.map((app) => {
                          const pinned = pinnedApps.includes(app);
                          return (
                            <div className="app-tray-card" key={app}>
                              <button
                                type="button"
                                className="app-tray-open"
                                onClick={() => sendChat(`open ${app}`)}
                              >
                                <LayoutGrid size={14} aria-hidden="true" />
                                <span>
                                  <strong>{app}</strong>
                                  <small>{appUsage[app] || 0} opens</small>
                                </span>
                              </button>
                              <button
                                type="button"
                                className="app-tray-pin"
                                onClick={() => removeAppSuggestion(app)}
                                aria-label={`Remove ${app} from frequently used apps`}
                                title={`Remove ${app} from frequently used apps`}
                              >
                                <X size={13} />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="apps-tray-empty">
                        Apps you open with MILO will show here. Pin one to keep it at the top.
                      </p>
                    )}
                    <div className="apps-tray-heading installed-apps-heading">
                      <strong>Installed apps</strong>
                      <span>Scanned when opened and refreshed every 30 seconds</span>
                    </div>
                    <div className="apps-inventory-controls">
                      <input
                        type="search"
                        aria-label="Filter installed apps"
                        placeholder="Find an installed app…"
                        value={appFilter}
                        onChange={(event) => setAppFilter(event.target.value)}
                      />
                      <button
                        type="button"
                        aria-label="Refresh installed apps"
                        title="Refresh installed apps"
                        disabled={!connected || appInventoryLoading}
                        onClick={() => setAppInventoryRefresh((value) => value + 1)}
                      >
                        <RefreshCw className={appInventoryLoading ? "spin" : ""} size={13} />
                      </button>
                    </div>
                    {appInventoryError && (
                      <p className="panel-error" role="alert">{appInventoryError}</p>
                    )}
                    {appInventoryLoading && installedApps.length === 0 && (
                      <p className="apps-tray-empty" role="status">Scanning installed apps…</p>
                    )}
                    {!appInventoryLoading && !appInventoryError && installedApps.length === 0 && (
                      <p className="apps-tray-empty">No installed apps were found.</p>
                    )}
                    {!appFilter.trim() && installedApps.length > 0 && (
                      <p className="apps-tray-empty">Search for an app to see matching results.</p>
                    )}
                    {appFilter.trim() && installedApps.length > 0 && (
                      <div className="apps-tray-list installed-apps-list">
                        {filteredInstalledApps.map((app) => {
                            const pinned = pinnedApps.includes(app.name);
                            return (
                              <div className="app-tray-card" key={`installed-${app.name}`}>
                                <button
                                  type="button"
                                  className="app-tray-open"
                                  onClick={() => sendChat(`open ${app.name}`)}
                                >
                                  <LayoutGrid size={14} aria-hidden="true" />
                                  <span>
                                    <strong>{app.name}</strong>
                                    <small>{app.running ? `Running · ${app.windows} window(s)` : "Installed"}</small>
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  className="app-tray-pin"
                                  onClick={() => togglePinnedApp(app.name)}
                                  aria-label={pinned ? `Unpin ${app.name}` : `Pin ${app.name}`}
                                  title={pinned ? `Unpin ${app.name}` : `Pin ${app.name}`}
                                >
                                  {pinned ? <PinOff size={13} /> : <Pin size={13} />}
                                </button>
                              </div>
                            );
                          })}
                      </div>
                    )}
                    {installedApps.length > 0 && filteredInstalledApps.length === 0 && (
                      <p className="apps-tray-empty">
                        No installed app matches “{appFilter.trim()}”.
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {!connected && (
                <p className="offline">Backend offline ? ws://127.0.0.1:8765/ws</p>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

    </div>
  );
}
