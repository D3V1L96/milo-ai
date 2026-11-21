"""MILO backend: real system telemetry, Windows notifications, media control, tasks."""
from __future__ import annotations

import asyncio
import importlib
import ipaddress
import json
import os
import re
import sys
import time
from contextlib import suppress
from typing import Any

from fastapi import (
    File, FastAPI, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from sources.system import SystemMonitor
from sources.tasks import TaskRunner
from sources.reminders import ReminderService, ReminderError
from sources.assistant import AssistantService
from sources.research import ResearchError, ResearchRunner, open_search_results
from sources.weather import WeatherError, fetch_current_weather
from sources.bridge import BridgeSource
from sources.media import MediaBridge          # <-- naya
from sources import app_control
from sources.app_control import AppControlError
from sources.file_uploads import FileStore, FileTooLargeError, FileUploadError
from sources.fish_audio import (
    FishAudioConfigurationError, FishAudioRequestError, synthesize,
)

DEFAULT_ALLOWED_ORIGINS = {
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    # Tauri v2 webview origins used by packaged MILO builds.
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
}
_configured_origins = os.environ.get("MILO_ALLOWED_ORIGINS", "").strip()
ALLOWED_ORIGINS = frozenset(
    origin.strip().rstrip("/")
    for origin in (_configured_origins.split(",") if _configured_origins else DEFAULT_ALLOWED_ORIGINS)
    if origin.strip()
)
_configured_hosts = os.environ.get("MILO_ALLOWED_HOSTS", "").strip()
ALLOWED_HOSTS = frozenset(
    host.strip().casefold()
    for host in (_configured_hosts.split(",") if _configured_hosts else {
        "127.0.0.1:8765", "localhost:8765", "[::1]:8765",
    })
    if host.strip()
)


def _origin_is_allowed(origin: str | None) -> bool:
    return bool(origin) and origin.strip().rstrip("/") in ALLOWED_ORIGINS


def _host_is_allowed(host: str | None) -> bool:
    return bool(host) and host.strip().casefold() in ALLOWED_HOSTS


def _peer_is_loopback(peer: Any) -> bool:
    address = getattr(peer, "host", None)
    if not isinstance(address, str):
        return False
    try:
        return ipaddress.ip_address(address).is_loopback
    except ValueError:
        return False


app = FastAPI(title="MILO Backend", docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(ALLOWED_ORIGINS),
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)


@app.middleware("http")
async def enforce_browser_origin(request, call_next):
    if not _peer_is_loopback(request.client) or not _host_is_allowed(request.headers.get("host")):
        return JSONResponse({"detail": "MILO is available only through its local loopback service."}, status_code=403)
    origin = request.headers.get("origin")
    if origin and not _origin_is_allowed(origin):
        return JSONResponse({"detail": "This origin is not allowed to access MILO."}, status_code=403)
    if request.url.path in {"/files", "/tts"} and request.method == "POST" and not origin:
        return JSONResponse({"detail": "A trusted MILO app origin is required."}, status_code=403)
    return await call_next(request)


class Hub:
    """Fan-out to every connected frontend. Slow clients dropped, never block the loop."""

    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()
        self._recent: list[dict] = []
        self._latest_media: dict | None = None
        self._latest_volume: dict | None = None
        self._latest_device: dict | None = None
        self._latest_research: dict | None = None
        self._latest_notification_status: dict | None = None

    async def join(self, ws: WebSocket) -> None:
        await ws.accept()
        self.clients.add(ws)
        await ws.send_text(json.dumps({
            "state": "IDLE", "emotion": "calm",
            "message": "Backend connected.", "progress": 0
        }))
        for frame in self._recent[-20:]:
            await ws.send_text(json.dumps(frame))
        if self._latest_volume is not None:
            await ws.send_text(json.dumps(self._latest_volume))
        if self._latest_device is not None:
            await ws.send_text(json.dumps(self._latest_device))
        if self._latest_research is not None:
            await ws.send_text(json.dumps(self._latest_research, ensure_ascii=False))
        if self._latest_notification_status is not None:
            await ws.send_text(json.dumps(self._latest_notification_status, ensure_ascii=False))
        await ws.send_text(json.dumps({"reminders": reminders.snapshot()}, ensure_ascii=False))
        if self._latest_media is not None:
            await ws.send_text(json.dumps(self._latest_media))

    def leave(self, ws: WebSocket) -> None:
        self.clients.discard(ws)

    def remove_notification(self, notification_id: str) -> None:
        self._recent = [
            frame for frame in self._recent
            if not (
                isinstance(frame.get("notification"), dict)
                and frame["notification"].get("id") == notification_id
            )
        ]

    def clear_notifications(self) -> None:
        self._recent = [
            frame for frame in self._recent if "notification" not in frame
        ]

    async def send(self, frame: dict[str, Any]) -> None:
        if "notification" in frame:
            self._recent.append(frame)
            self._recent = self._recent[-50:]
        if "media" in frame:
            self._latest_media = {"media": frame["media"]}
        if "volume" in frame:
            self._latest_volume = {"volume": frame["volume"]}
        if "device" in frame:
            self._latest_device = {"device": frame["device"]}
        if "research" in frame:
            self._latest_research = {"research": frame["research"]}
        if "notificationStatus" in frame:
            self._latest_notification_status = {
                "notificationStatus": frame["notificationStatus"]
            }
        payload = json.dumps(frame, ensure_ascii=False)
        dead: list[WebSocket] = []
        for ws in list(self.clients):
            try:
                await asyncio.wait_for(ws.send_text(payload), timeout=2.0)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.leave(ws)


hub = Hub()


async def emit(frame: dict) -> None:
    await hub.send(frame)


reminders = ReminderService(emit)
monitor = SystemMonitor()
tasks = TaskRunner(emit)
research = ResearchRunner(emit)
notifs = BridgeSource("notifications.ps1", emit)
media = MediaBridge(emit)                      # <-- pehle BridgeSource tha, ab bidirectional
file_store = FileStore()
assistant = AssistantService(
    emit, media_command=media.command, file_store=file_store,
    reminder_setter=reminders.schedule,
)


class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


@app.get("/health")
async def health() -> dict:
    return {
        "ok": True,
        "clients": len(hub.clients),
        "notifications_api": notifs.available,
        "notifications_error": notifs.last_error,
        "media_api": media.available,
        "media_error": media.last_error,
        "uptime_s": round(time.time() - monitor.started, 1),
    }


@app.get("/apps")
async def installed_apps() -> dict:
    try:
        return {"apps": await asyncio.to_thread(app_control.scan_apps)}
    except AppControlError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/files", status_code=201)
async def upload_file(file: UploadFile = File(...)) -> dict:
    try:
        try:
            uploaded = await asyncio.to_thread(
                file_store.save_stream,
                file.filename or "",
                file.content_type or "",
                file.file,
            )
        except FileTooLargeError as exc:
            raise HTTPException(status_code=413, detail=str(exc)) from exc
        except FileUploadError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return uploaded.public_data()
    finally:
        await file.close()


@app.post("/tts")
async def text_to_speech(request: SpeechRequest) -> Response:
    try:
        audio = await asyncio.to_thread(synthesize, request.text)
    except FishAudioConfigurationError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except FishAudioRequestError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return Response(content=audio, media_type="audio/mpeg")


@app.websocket("/voice")
async def realtime_voice(ws: WebSocket) -> None:
    if (
        not _peer_is_loopback(ws.client)
        or not _host_is_allowed(ws.headers.get("host"))
        or not _origin_is_allowed(ws.headers.get("origin"))
    ):
        await ws.close(code=1008)
        return
    await ws.accept()
    try:
        # PyAudioWPatch keeps the PyAudio API available on this Python 3.14 Windows setup.
        pyaudio = importlib.import_module("pyaudiowpatch")
        sys.modules.setdefault("pyaudio", pyaudio)
        sr = importlib.import_module("speech_recognition")
    except ImportError as exc:
        await ws.send_json({
            "type": "error",
            "message": (
                "Local microphone recognition needs SpeechRecognition and PyAudioWPatch. "
                "Install backend requirements, then restart MILO."
            ),
        })
        await ws.close(code=1011)
        return

    recognizer = sr.Recognizer()
    recognizer.dynamic_energy_threshold = True
    recognizer.operation_timeout = 8
    loop = asyncio.get_running_loop()

    async def send_transcript(text: str) -> None:
        try:
            await ws.send_json({"type": "committed", "text": text, "user_turn": True})
        except (WebSocketDisconnect, RuntimeError):
            pass

    async def send_error(message: str) -> None:
        try:
            await ws.send_json({"type": "error", "message": message})
        except (WebSocketDisconnect, RuntimeError):
            pass

    async def send_unrecognized() -> None:
        try:
            await ws.send_json({"type": "unrecognized"})
        except (WebSocketDisconnect, RuntimeError):
            pass

    try:
        start_message = await asyncio.wait_for(ws.receive_text(), timeout=10)
        start_command = json.loads(start_message)
        if not isinstance(start_command, dict) or start_command.get("action") != "start":
            raise ValueError("Start command was missing.")
        language = start_command.get("language", "en-IN")
        if language not in {"en-IN", "hi-IN", "en-US"}:
            language = "en-IN"

        # listen_in_background() opens and closes the source itself. Keeping an
        # outer Microphone context here makes its listener thread crash on re-entry.
        microphone = sr.Microphone()
        # Calibrate against this room and microphone before waiting for speech.
        # Without this, the default 300 energy threshold can miss quiet commands.
        with microphone as calibration_source:
            recognizer.adjust_for_ambient_noise(calibration_source, duration=0.6)

        def on_phrase(_recognizer, audio) -> None:
            try:
                text = recognizer.recognize_google(audio, language=language).strip()
                if text:
                    asyncio.run_coroutine_threadsafe(send_transcript(text), loop)
            except sr.UnknownValueError:
                asyncio.run_coroutine_threadsafe(send_unrecognized(), loop)
            except sr.RequestError as exc:
                asyncio.run_coroutine_threadsafe(
                    send_error(f"Speech recognition service could not process audio: {exc}"),
                    loop,
                )

        stop_listening = recognizer.listen_in_background(
            microphone, on_phrase, phrase_time_limit=6
        )
        await ws.send_json({"type": "ready", "engine": "pyaudio-google"})
        try:
            while True:
                command = json.loads(await ws.receive_text())
                if isinstance(command, dict) and command.get("action") == "stop":
                    break
        finally:
            stop_listening(wait_for_stop=False)
    except WebSocketDisconnect:
        pass
    except (OSError, RuntimeError) as exc:
        await send_error(
            "MILO could not open the microphone. Check Windows microphone permission "
            f"and the default input device: {exc}"
        )
    except (ValueError, json.JSONDecodeError, asyncio.TimeoutError):
        await send_error("MILO did not receive a valid microphone start request.")
    except Exception as exc:
        await send_error(f"PyAudio speech recognition could not start: {exc}")
    finally:
        with suppress(WebSocketDisconnect, RuntimeError):
            await ws.close()


@app.get("/weather")
async def weather(
    latitude: float = Query(..., ge=-90, le=90),
    longitude: float = Query(..., ge=-180, le=180),
) -> dict:
    try:
        return await asyncio.to_thread(fetch_current_weather, latitude, longitude)
    except WeatherError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    if (
        not _peer_is_loopback(ws.client)
        or not _host_is_allowed(ws.headers.get("host"))
        or not _origin_is_allowed(ws.headers.get("origin"))
    ):
        await ws.close(code=1008)
        return
    await hub.join(ws)
    try:
        while True:
            raw = await ws.receive_text()
            if len(raw.encode("utf-8")) > 256 * 1024:
                await ws.close(code=1009, reason="Command payload is too large.")
                break
            try:
                cmd = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_text(json.dumps({
                    "state": "ERROR", "emotion": "confused",
                    "message": "Invalid JSON command."
                }))
                continue
            if not isinstance(cmd, dict):
                await ws.send_text(json.dumps({
                    "state": "ERROR", "emotion": "confused",
                    "message": "Commands must be JSON objects.",
                }))
                continue
            await handle_command(cmd, ws)
    except WebSocketDisconnect:
        pass
    finally:
        await assistant.cancel_for(ws)
        hub.leave(ws)


async def handle_command(cmd: dict, ws: WebSocket) -> None:
    action = cmd.get("action")

    # ---- tasks ----
    if action == "run_task":
        await tasks.start(cmd.get("task", ""), cmd.get("args", {}))
    elif action == "cancel_task":
        await tasks.cancel()
    elif action == "set_reminder":
        try:
            reminder = await reminders.schedule(cmd.get("title", ""), cmd.get("dueAt", ""))
        except (ReminderError, OSError) as exc:
            await ws.send_text(json.dumps({"state": "ERROR", "emotion": "confused", "message": str(exc)}))
        else:
            await ws.send_text(json.dumps({"state": "SUCCESS", "emotion": "happy", "message": f"Reminder set: {reminder['title']}"}))
    elif action == "cancel_reminder":
        cancelled = await reminders.cancel(cmd.get("id", ""))
        if not cancelled:
            await ws.send_text(json.dumps({"state": "ERROR", "emotion": "confused", "message": "That reminder is no longer active."}))
    elif action == "research_search":
        query = cmd.get("query", "")
        if not isinstance(query, str):
            await ws.send_text(json.dumps({
                "state": "ERROR", "emotion": "confused",
                "message": "Search query must be text.",
            }))
        else:
            await research.start(query)
    elif action == "llm_status":
        await ws.send_text(json.dumps({"llmStatus": await assistant.ollama.status()}))
    elif action == "open_search_results":
        query = cmd.get("query")
        if not isinstance(query, str) or not query.strip() or len(query) > 200:
            await ws.send_text(json.dumps({
                "state": "ERROR", "emotion": "confused",
                "message": "Search query must contain 1 to 200 characters.",
            }))
        else:
            try:
                await asyncio.to_thread(open_search_results, query)
            except ResearchError as exc:
                await ws.send_text(json.dumps({
                    "state": "ERROR", "emotion": "confused", "message": str(exc),
                }))
            else:
                await ws.send_text(json.dumps({
                    "state": "SUCCESS", "emotion": "curious",
                    "message": f"Opened DuckDuckGo results for: {query.strip()}",
                }))
    elif action == "chat":
        request_id = cmd.get("requestId")
        message = cmd.get("message")
        history = cmd.get("history", [])
        if not isinstance(request_id, str) or not request_id or len(request_id) > 80:
            request_id = str(time.time_ns())
        if not isinstance(message, str) or not isinstance(history, list):
            await ws.send_text(json.dumps({
                "chatMessage": {
                    "requestId": request_id,
                    "role": "assistant",
                    "content": "Chat message or history has an invalid format.",
                    "error": True,
                }
            }))
        else:
            file_id = cmd.get("fileId")
            if file_id is not None and not isinstance(file_id, str):
                await ws.send_text(json.dumps({
                    "chatMessage": {
                        "requestId": request_id,
                        "role": "assistant",
                        "content": "The attached file reference is invalid. Please attach it again.",
                        "error": True,
                    }
                }))
            else:
                await assistant.start(ws, request_id, message, history, file_id)
    elif action == "cancel_chat":
        await assistant.cancel_for(ws)
    # ---- notifications ----
    elif action == "dismiss":
        notification_id = cmd.get("id")
        if isinstance(notification_id, str) and notification_id:
            hub.remove_notification(notification_id)
            await emit({"dismiss": notification_id})
    elif action == "clear_notifications":
        hub.clear_notifications()
        await emit({"clearAll": True})
    elif action == "open_notification":
        app = cmd.get("app")
        app_id = cmd.get("appId")
        if app is not None and not isinstance(app, str):
            app = None
        if app_id is not None and not isinstance(app_id, str):
            app_id = None
        try:
            message = await asyncio.to_thread(_open_notification_app, app, app_id)
        except (AppControlError, OSError) as exc:
            await ws.send_text(json.dumps({
                "state": "ERROR", "emotion": "confused",
                "message": f"Could not open the notification app: {exc}",
            }, ensure_ascii=False))
        else:
            await ws.send_text(json.dumps({
                "state": "SUCCESS", "emotion": "curious", "message": message,
            }, ensure_ascii=False))

    # ==== TERA SNIPPET YAHAN ====
    elif action in ("play", "pause", "toggle", "next", "previous"):
        await media.command({"action": action})
    elif action == "seek":
        await media.command({"action": "seek", "seconds": cmd.get("seconds", 0)})
    elif action == "volume":
        await media.command({"action": "volume", "value": cmd.get("value", 0.5)})
    elif action == "mute":
        await media.command({"action": "mute", "value": cmd.get("value", False)})
    elif action == "add_audio_device":
        try:
            if os.name != "nt":
                raise OSError("Adding audio devices is only supported on Windows.")
            os.startfile("ms-settings:bluetooth")
        except OSError as exc:
            await ws.send_text(json.dumps({
                "state": "ERROR", "emotion": "confused",
                "message": f"Could not open Bluetooth settings: {exc}"
            }))
        else:
            await ws.send_text(json.dumps({
                "message": "Bluetooth settings opened. Choose Add device to pair your headphones."
            }))
    # ===========================

    elif action == "ping":
        await ws.send_text(json.dumps({
            "state": "IDLE", "emotion": "calm", "message": "pong"
        }))
    else:
        await ws.send_text(json.dumps({
            "state": "ERROR", "emotion": "confused",
            "message": f"Unknown action: {action}"
        }))


def _open_notification_app(app: str | None, app_id: str | None) -> str:
    if os.name != "nt":
        raise AppControlError("Opening notification apps is only supported on Windows.")

    if app_id and re.fullmatch(r"[A-Za-z0-9._-]+![A-Za-z0-9._-]+", app_id):
        try:
            os.startfile(f"shell:AppsFolder\\{app_id}")
        except OSError as app_id_error:
            if not app or app.casefold() in {"system", "windows", "milo"}:
                raise AppControlError(f"Windows could not open {app_id}: {app_id_error}") from app_id_error
            try:
                return app_control.open_app(app)
            except AppControlError as app_error:
                raise AppControlError(
                    f"Windows could not open {app_id}; app-name fallback failed: {app_error}"
                ) from app_error
        return f"Opened {app or 'notification'}."

    if app and app.casefold() not in {"system", "windows", "milo"}:
        return app_control.open_app(app)
    raise AppControlError("This notification has no launchable app.")


@app.on_event("startup")
async def startup() -> None:
    loop = asyncio.get_running_loop()
    app.state.bg = [
        loop.create_task(monitor.run(emit)),
        loop.create_task(notifs.run()),
        loop.create_task(media.run()),
        loop.create_task(reminders.run()),
    ]


@app.on_event("shutdown")
async def shutdown() -> None:
    await research.cancel()
    for ws in list(hub.clients):
        await assistant.cancel_for(ws)
    await assistant.close()
    for t in getattr(app.state, "bg", []):
        t.cancel()
        with suppress(asyncio.CancelledError):
            await t
