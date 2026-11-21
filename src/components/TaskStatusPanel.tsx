import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { BellRing, ExternalLink, Loader2, MapPin, RefreshCw, Search, Trash2 } from "lucide-react";
import TaskProgress from "./TaskProgress";
import type { MiloState, ReminderItem, ResearchStatus } from "../lib/types";

interface CurrentWeather {
  temperature_c: number;
  feels_like_c: number;
  humidity_percent: number;
  wind_kmh: number;
  condition: string;
  updated_at: string;
}

interface Coordinates {
  latitude: number;
  longitude: number;
}

function weatherSceneFor(condition: string): string {
  const value = condition.toLowerCase();
  if (/thunder|lightning|hail/.test(value)) return "storm";
  if (/snow|sleet|ice|freezing/.test(value)) return "snow";
  if (/fog|mist/.test(value)) return "fog";
  if (/rain|drizzle|shower/.test(value)) return "rain";
  if (/cloud|overcast/.test(value)) return "cloudy";
  return "clear";
}

interface Props {
  state: MiloState;
  message: string;
  progress: number;
  research: ResearchStatus | null;
  reminders: ReminderItem[];
  connected: boolean;
  send: (cmd: Record<string, unknown>) => boolean;
}

export default function TaskStatusPanel({
  state, message, progress, research, reminders, connected, send
}: Props) {
  const [query, setQuery] = useState("");
  const [coordinates, setCoordinates] = useState<Coordinates | null>(null);
  const [weather, setWeather] = useState<CurrentWeather | null>(null);
  const [weatherError, setWeatherError] = useState("");
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [weatherRefresh, setWeatherRefresh] = useState(0);
  const [searchError, setSearchError] = useState("");
  const [reminderTitle, setReminderTitle] = useState("");
  const [reminderTime, setReminderTime] = useState("");
  const [reminderError, setReminderError] = useState("");
  const locationRequested = useRef(false);

  const locateWeather = useCallback(() => {
    if (!navigator.geolocation) {
      setWeatherError("Location access is not available in this browser.");
      return;
    }
    setWeatherError("");
    setWeatherLoading(true);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setCoordinates({ latitude: coords.latitude, longitude: coords.longitude });
      },
      (error) => {
        setWeatherLoading(false);
        setWeatherError(error.message || "Location permission was not granted.");
      },
      { enableHighAccuracy: false, maximumAge: 10 * 60 * 1000, timeout: 15_000 }
    );
  }, []);

  useEffect(() => {
    if (!coordinates && !locationRequested.current) {
      locationRequested.current = true;
      locateWeather();
    }
  }, [coordinates, locateWeather]);

  const submitReminder = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = reminderTitle.trim();
    const due = new Date(reminderTime);
    if (!title || !reminderTime || Number.isNaN(due.getTime())) {
      setReminderError("Add a reminder and choose its date and time.");
      return;
    }
    if (!connected || !send({ action: "set_reminder", title, dueAt: due.toISOString() })) {
      setReminderError("MILO is offline. Reconnect and try again.");
      return;
    }
    setReminderTitle("");
    setReminderTime("");
    setReminderError("");
  };

  useEffect(() => {
    if (!coordinates) return;
    let active = true;

    const updateWeather = async () => {
      setWeatherLoading(true);
      try {
        const params = new URLSearchParams({
          latitude: String(coordinates.latitude),
          longitude: String(coordinates.longitude),
        });
        const response = await fetch(`http://127.0.0.1:8765/weather?${params}`);
        const body = await response.json();
        if (!response.ok) {
          throw new Error(typeof body.detail === "string" ? body.detail : "Weather update failed.");
        }
        if (active) {
          setWeather(body as CurrentWeather);
          setWeatherError("");
        }
      } catch (error) {
        if (active) {
          setWeatherError(error instanceof Error ? error.message : "Weather update failed.");
        }
      } finally {
        if (active) setWeatherLoading(false);
      }
    };

    void updateWeather();
    const interval = window.setInterval(updateWeather, 10 * 60 * 1000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [coordinates, weatherRefresh]);

  const requestWeather = () => {
    if (coordinates) {
      setWeatherRefresh((value) => value + 1);
      return;
    }
    locateWeather();
  };

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = query.trim();
    if (!normalized) return;
    if (!connected || !send({ action: "research_search", query: normalized })) {
      setSearchError("MILO backend is offline. Reconnect and try again.");
      return;
    }
    setSearchError("");
  };

  const researchProgressLabel = research?.status === "searching" ? "Research progress" : "Task progress";

  return (
    <div className="task-status-panel" onClick={(event) => event.stopPropagation()}>
      <section className="task-status-card" aria-label="Task status">
        <div className="status-card-heading">
          <span>Current status</span>
          <strong className={`status-pill status-${state.toLowerCase()}`}>{state}</strong>
        </div>
        <p className="status-message">{message}</p>
        <TaskProgress label={researchProgressLabel} value={progress} />
      </section>

      <section className="reminders-card" aria-label="Reminders">
        <div className="status-card-heading">
          <span><BellRing size={12} aria-hidden="true" /> Reminders</span>
          <span className="reminder-count">{reminders.length}</span>
        </div>
        <form className="reminder-form" onSubmit={submitReminder}>
          <input type="text" maxLength={200} value={reminderTitle}
            aria-label="Reminder text" placeholder="What should MILO remind you?"
            onChange={(event) => setReminderTitle(event.target.value)} />
          <input type="datetime-local" aria-label="Reminder date and time" value={reminderTime}
            onChange={(event) => setReminderTime(event.target.value)} />
          <button type="submit" disabled={!connected || !reminderTitle.trim() || !reminderTime}>Set</button>
        </form>
        {reminderError && <p className="panel-error" role="alert">{reminderError}</p>}
        {reminders.length ? (
          <div className="reminder-list">
            {reminders.map((item) => (
              <div className="reminder-item" key={item.id}>
                <span><strong>{item.title}</strong><small>{new Date(item.dueAt).toLocaleString()}</small></span>
                <button type="button" aria-label={`Cancel reminder: ${item.title}`}
                  title="Cancel reminder" onClick={() => send({ action: "cancel_reminder", id: item.id })}>
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : <p className="panel-empty">Ask MILO to remind you in chat, or set one here.</p>}
      </section>

      <section className="research-card" aria-label="Web research">
        <div className="status-card-heading">
          <span>Research · DuckDuckGo</span>
          {research?.status === "searching" && <Loader2 className="spin" size={13} aria-label="Searching" />}
        </div>
        <form className="research-form" onSubmit={submitSearch}>
          <input
            type="search"
            value={query}
            maxLength={200}
            aria-label="Research topic"
            placeholder="What should Milo research?"
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="submit" aria-label="Search the web" disabled={!connected || !query.trim()}>
            <Search size={14} />
          </button>
        </form>
        {searchError && <p className="panel-error" role="alert">{searchError}</p>}
        {research ? (
          <>
            <div className="research-query">
              <span>{research.status === "searching" ? "Searching for" : "Searched for"}</span>
              <strong>{research.query}</strong>
            </div>
            {research.error && <p className="panel-error" role="alert">{research.error}</p>}
            {research.status === "complete" && research.results.length === 0 && (
              <p className="panel-empty">No results found. Try a different phrase.</p>
            )}
            {research.results.length > 0 && (
              <div className="research-results">
                {research.results.map((result) => (
                  <a
                    className="research-result"
                    href={result.url}
                    key={result.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <span className="research-result-title">{result.title}</span>
                    <span className="research-result-snippet">{result.snippet || result.url}</span>
                    <ExternalLink size={11} aria-hidden="true" />
                  </a>
                ))}
              </div>
            )}
          </>
        ) : (
          <p className="panel-empty">Search a topic to see Milo’s live research and results.</p>
        )}
      </section>

      <section className="weather-card" aria-label="Local weather">
        {weather && (
          <div className={"weather-sky " + weatherSceneFor(weather.condition)} aria-hidden="true">
            <i className="weather-sun" />
            <i className="weather-cloud cloud-one" />
            <i className="weather-cloud cloud-two" />
            <span className="weather-lightning" />
            <div className="weather-precipitation">
              {Array.from({ length: 9 }, (_, index) => <i key={index} />)}
            </div>
          </div>
        )}
        <div className="status-card-heading">
          <span><MapPin size={12} aria-hidden="true" /> Local weather</span>
          <button
            className="weather-refresh"
            type="button"
            onClick={requestWeather}
            disabled={weatherLoading}
            aria-label={coordinates ? "Refresh local weather" : "Use my location for weather"}
          >
            {weatherLoading ? <Loader2 className="spin" size={13} /> : coordinates ? <RefreshCw size={13} /> : <MapPin size={13} />}
          </button>
        </div>
        {weather ? (
          <>
            <div className="weather-main">
              <strong>{Math.round(weather.temperature_c)}°</strong>
              <span>{weather.condition}</span>
            </div>
            <div className="weather-details">
              <span>Feels {Math.round(weather.feels_like_c)}°</span>
              <span>Humidity {weather.humidity_percent}%</span>
              <span>Wind {Math.round(weather.wind_kmh)} km/h</span>
            </div>
            <p className="weather-updated">
              Updated {new Date(weather.updated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · refreshes every 10 min
            </p>
          </>
        ) : (
          <p className="panel-empty">Allow location access once for local weather. MILO refreshes it automatically every 10 minutes.</p>
        )}
        {weatherError && <p className="panel-error" role="alert">{weatherError}</p>}
      </section>
    </div>
  );
}
