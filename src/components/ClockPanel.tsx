import { useEffect, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CalendarDays, Check, Clock3, ImagePlus, Palette, Trash2 } from "lucide-react";
import { loadClockFaceImage, saveClockFaceImage } from "../lib/clockFaceImage";

const CLOCK_PREFS_KEY = "milo-clock-face-v1";
const CLOCK_THEMES = [
  { id: "ocean", name: "Ocean", color: "#65c8ff" },
  { id: "neon", name: "Neon", color: "#9bff72" },
  { id: "sunset", name: "Sunset", color: "#ff9b73" },
  { id: "violet", name: "Violet", color: "#c6a2ff" },
];

interface ClockPreferences { theme: string; accent: string; hour12: boolean; seconds: boolean; wallpaper: boolean }
const DEFAULT_PREFS: ClockPreferences = { theme: "ocean", accent: "#65c8ff", hour12: true, seconds: true, wallpaper: false };

function readClockPreferences(): ClockPreferences {
  try {
    const value = JSON.parse(window.localStorage.getItem(CLOCK_PREFS_KEY) || "null") as Partial<ClockPreferences> | null;
    return {
      theme: CLOCK_THEMES.some((item) => item.id === value?.theme) ? value!.theme! : DEFAULT_PREFS.theme,
      accent: typeof value?.accent === "string" && /^#[\da-f]{6}$/i.test(value.accent) ? value.accent : DEFAULT_PREFS.accent,
      hour12: typeof value?.hour12 === "boolean" ? value.hour12 : DEFAULT_PREFS.hour12,
      seconds: typeof value?.seconds === "boolean" ? value.seconds : DEFAULT_PREFS.seconds,
      wallpaper: typeof value?.wallpaper === "boolean" ? value.wallpaper : DEFAULT_PREFS.wallpaper,
    };
  } catch { return DEFAULT_PREFS; }
}

const dateFormatter = new Intl.DateTimeFormat("en-IN", {
  weekday: "long",
  day: "2-digit",
  month: "long",
  year: "numeric",
});

export default function ClockPanel() {
  const [now, setNow] = useState(() => new Date());
  const [analog, setAnalog] = useState(false);
  const [preferences, setPreferences] = useState(readClockPreferences);
  const [customImage, setCustomImage] = useState("");
  const [imageError, setImageError] = useState("");
  const [showCustomize, setShowCustomize] = useState(false);
  const imageInput = useRef<HTMLInputElement | null>(null);

  const timeFormatter = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit", minute: "2-digit", ...(preferences.seconds ? { second: "2-digit" } : {}),
    hour12: preferences.hour12,
  });

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    try { window.localStorage.setItem(CLOCK_PREFS_KEY, JSON.stringify(preferences)); }
    catch { /* Keep the clock usable if browser storage is unavailable. */ }
  }, [preferences]);

  useEffect(() => {
    let active = true;
    let imageUrl = "";
    void loadClockFaceImage().then((image) => {
      if (!active || !image) return;
      imageUrl = URL.createObjectURL(image);
      setCustomImage(imageUrl);
    });
    return () => { active = false; if (imageUrl) URL.revokeObjectURL(imageUrl); };
  }, []);

  const chooseImage = async (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 8 * 1024 * 1024) {
      setImageError("Choose an image up to 8 MB.");
      return;
    }
    try {
      await saveClockFaceImage(file);
      if (customImage) URL.revokeObjectURL(customImage);
      setCustomImage(URL.createObjectURL(file));
      setImageError("");
    } catch {
      setImageError("Could not save this watch face image in the browser.");
    }
  };

  const removeImage = async () => {
    try {
      await saveClockFaceImage(null);
      if (customImage) URL.revokeObjectURL(customImage);
      setCustomImage("");
      setImageError("");
    } catch { setImageError("Could not remove the saved watch face image."); }
  };

  const parts = timeFormatter.formatToParts(now)
    .filter((part) => part.type !== "literal");

  return (
    <motion.section
      className={`clock-panel clock-theme-${preferences.theme}${preferences.wallpaper && customImage ? " wallpaper-applied" : ""}`}
      style={{
        "--clock-accent": preferences.accent,
        "--clock-image": customImage ? `url("${customImage}")` : "none",
      } as CSSProperties}
      aria-label="Current date and time"
      initial={{ opacity: 0, y: 7 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
    >
      <div className="clock-kicker"><Clock3 size={12} /> LOCAL TIME</div>
      <button
        type="button"
        className="clock-face-toggle"
        aria-label={analog ? "Analog clock face; double-click to customize" : "Digital clock face; click to apply wallpaper, double-click to customize"}
        title={customImage ? "Click to apply wallpaper · double-click to customize" : "Double-click to customize the watch face"}
        onClick={() => {
          if (!analog && customImage) setPreferences((current) => ({ ...current, wallpaper: true }));
        }}
        onDoubleClick={(event) => { event.preventDefault(); setShowCustomize(true); }}
      >
        <AnimatePresence mode="wait" initial={false}>
          {analog ? (
            <motion.span key="analog" className="analog-clock" aria-label={timeFormatter.format(now)}
              initial={{ opacity: 0, scale: 0.82, rotate: -18 }} animate={{ opacity: 1, scale: 1, rotate: 0 }}
              exit={{ opacity: 0, scale: 0.82, rotate: 18 }} transition={{ duration: 0.22 }}>
              {Array.from({ length: 12 }, (_, index) => <i key={index} style={{ transform: `rotate(${index * 30}deg)` }} />)}
              <i className="analog-hand analog-hour" style={{ transform: `translateX(-50%) rotate(${(now.getHours() % 12) * 30 + now.getMinutes() * 0.5}deg)` }} />
              <i className="analog-hand analog-minute" style={{ transform: `translateX(-50%) rotate(${now.getMinutes() * 6}deg)` }} />
              {preferences.seconds && <i className="analog-hand analog-second" style={{ transform: `translateX(-50%) rotate(${now.getSeconds() * 6}deg)` }} />}
              <i className="analog-pin" />
            </motion.span>
          ) : (
            <motion.span key="digital" className="clock-readout digital-watch-face" aria-label={timeFormatter.format(now)}
              initial={{ opacity: 0, scale: 0.9, y: 5 }} animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: -5 }} transition={{ duration: 0.18 }}>
              {parts.filter((part) => preferences.seconds || part.type !== "second").map((part, index, shownParts) => (
                <span className={"clock-part clock-" + part.type} key={part.type}>
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.span key={part.value} className="clock-digit"
                      initial={{ y: 12, opacity: 0, filter: "blur(4px)" }}
                      animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
                      exit={{ y: -12, opacity: 0, filter: "blur(4px)" }}
                      transition={{ duration: 0.18, ease: "easeOut" }}>
                      {part.value}
                    </motion.span>
                  </AnimatePresence>
                  {index < shownParts.length - 1 && (
                    <span className={part.type === "second" ? "clock-space" : "clock-separator"}>
                      {part.type === "hour" || part.type === "minute" ? ":" : ""}
                    </span>
                  )}
                </span>
              ))}
            </motion.span>
          )}
        </AnimatePresence>
      </button>
      <div className="clock-date">
        <CalendarDays size={13} />
        <span>{dateFormatter.format(now)}</span>
      </div>
      {!showCustomize && <span className="clock-customize-hint">Double-click the clock to customize</span>}
      {showCustomize && <div className="clock-customize" aria-label="Customize watch face">
        <div className="clock-image-controls">
          <label className="clock-image-upload">
            <ImagePlus size={12} /> {customImage ? "Change image" : "Add image"}
            <input ref={imageInput} type="file" accept="image/*" aria-label="Upload a custom watch face image"
              onChange={(event) => { void chooseImage(event.target.files?.[0]); event.target.value = ""; }} />
          </label>
          {customImage && <button type="button" className="clock-image-remove" onClick={() => { void removeImage(); }}
            aria-label="Remove custom watch face image" title="Remove image"><Trash2 size={12} /></button>}
        </div>
        {imageError && <span className="clock-image-error" role="alert">{imageError}</span>}
        <div className="clock-theme-options" role="group" aria-label="Watch face theme">
          {CLOCK_THEMES.map((theme) => (
            <button key={theme.id} type="button" className={`clock-theme-choice ${preferences.theme === theme.id ? "selected" : ""}`}
              aria-label={`${theme.name} watch face theme`} aria-pressed={preferences.theme === theme.id}
              style={{ "--swatch": theme.color } as CSSProperties}
              onClick={() => setPreferences((current) => ({ ...current, theme: theme.id, accent: theme.color }))} />
          ))}
          <label className="clock-custom-color" title="Choose a custom watch face color">
            <Palette size={12} />
            <input type="color" aria-label="Custom watch face color" value={preferences.accent}
              onChange={(event) => setPreferences((current) => ({ ...current, theme: "custom", accent: event.target.value }))} />
          </label>
        </div>
        <div className="clock-options">
          <button type="button" onClick={() => setAnalog((value) => !value)}>
            Switch to {analog ? "digital" : "analog"}
          </button>
          <button type="button" aria-pressed={preferences.hour12} onClick={() => setPreferences((current) => ({ ...current, hour12: !current.hour12 }))}>
            {preferences.hour12 ? "12 hour" : "24 hour"}
          </button>
          <button type="button" aria-pressed={preferences.seconds} onClick={() => setPreferences((current) => ({ ...current, seconds: !current.seconds }))}>
            {preferences.seconds ? "Seconds on" : "Seconds off"}
          </button>
          <button type="button" onClick={() => setPreferences((current) => ({ ...current, wallpaper: false }))}>
            Wallpaper off
          </button>
        </div>
        <button type="button" className="clock-done" onClick={() => setShowCustomize(false)}>
          <Check size={12} /> Done
        </button>
      </div>}
    </motion.section>
  );
}
