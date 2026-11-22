"""Bidirectional PowerShell bridge for real Windows media session + master volume."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Awaitable, Callable

from .runtime_paths import bridge_directory
from .hidden_process import hidden_process_options

Emit = Callable[[dict], Awaitable[None]]
BRIDGE = bridge_directory()


class MediaBridge:
    def __init__(self, emit: Emit) -> None:
        self.emit = emit
        self.available = False
        self.last_error = ""
        self._proc: asyncio.subprocess.Process | None = None
        self._last_thumb: str | None = None
        self._last_track = ""

    async def command(self, cmd: dict) -> bool:
        if not self._proc or self._proc.stdin is None or self._proc.returncode is not None:
            await self.emit({"state": "ERROR", "emotion": "confused",
                             "message": "Media bridge not running."})
            return False
        try:
            self._proc.stdin.write((json.dumps(cmd) + "\n").encode("utf-8"))
            await self._proc.stdin.drain()
        except (OSError, RuntimeError) as exc:
            await self.emit({"state": "ERROR", "emotion": "confused", "message": str(exc)})
            return False
        return True

    async def run(self) -> None:
        path = BRIDGE / "media_control.ps1"
        if not path.exists():
            self.last_error = "missing media_control.ps1"
            print(f"[media] {self.last_error}")
            return

        self._proc = await asyncio.create_subprocess_exec(
            "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(path),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            **hidden_process_options(),
        )
        assert self._proc.stdout is not None
        try:
            while True:
                line = await self._proc.stdout.readline()
                if not line:
                    break
                text = line.decode("utf-8", errors="replace").strip()
                if not text:
                    continue
                try:
                    f = json.loads(text)
                except json.JSONDecodeError:
                    continue

                kind = f.pop("type", None)
                if kind == "ready":
                    self.available = True
                    print("[media] real Windows session + volume control live")
                elif kind == "error":
                    self.last_error = f.get("reason", "unknown")
                    print(f"[media] {self.last_error}")
                    await self.emit({"state": "ERROR", "emotion": "confused",
                                     "message": f"Media control failed: {self.last_error}"})
                elif kind == "volume":
                    await self.emit({"volume": f})
                elif kind == "device":
                    name = f.get("name")
                    await self.emit({"device": {
                        "name": name if isinstance(name, str) else "",
                        "connected": isinstance(name, str) and bool(name.strip()),
                    }})
                elif kind == "media":
                    # thumbnail sirf track change par bhejo, har tick par nahi
                    track_key = f"{f.get('title')}|{f.get('artist')}"
                    if track_key != self._last_track:
                        self._last_track = track_key
                        self._last_thumb = f.get("thumbnail")
                    else:
                        f["thumbnail"] = self._last_thumb
                    await self.emit({"media": f})

                    if f.get("playing") and f.get("title"):
                        await self.emit({"source": "media", "state": "VIBING", "emotion": "vibing",
                                         "message": f"{f['title']} ? {f.get('artist','')}".strip(" ?")})
                    elif not f.get("playing") and f.get("available"):
                        await self.emit({"source": "media", "state": "IDLE",
                                         "emotion": "calm", "message": "Paused."})
        finally:
            if self._proc.returncode is None:
                self._proc.kill()
