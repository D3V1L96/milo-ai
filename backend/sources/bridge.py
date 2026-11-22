"""Runs a PowerShell bridge script and forwards its JSON lines to the WebSocket hub."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Awaitable, Callable

from .runtime_paths import bridge_directory
from .hidden_process import hidden_process_options

from .notification_classification import classify_notification

Emit = Callable[[dict], Awaitable[None]]
BRIDGE = bridge_directory()


class BridgeSource:
    def __init__(self, script: str, emit: Emit) -> None:
        self.path = BRIDGE / script
        self.emit = emit
        self.available = False
        self.last_error = ""

    async def run(self) -> None:
        if not self.path.exists():
            self.last_error = f"missing {self.path.name}"
            print(f"[bridge] {self.last_error}")
            await self.emit({"notificationStatus": {
                "available": False, "error": self.last_error
            }})
            return

        proc = await asyncio.create_subprocess_exec(
            "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(self.path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            **hidden_process_options(),
        )
        assert proc.stdout is not None
        try:
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                text = line.decode("utf-8", errors="replace").strip()
                if not text:
                    continue
                try:
                    frame = json.loads(text)
                except json.JSONDecodeError:
                    continue

                kind = frame.pop("type", None)
                if kind == "ready":
                    self.available = True
                    print(f"[bridge] {frame.get('source')} live")
                    await self.emit({"notificationStatus": {"available": True}})
                elif kind == "error":
                    self.available = False
                    self.last_error = frame.get("reason", "unknown")
                    print(f"[bridge] {self.path.name}: {self.last_error}")
                    await self.emit({"notificationStatus": {
                        "available": False, "error": self.last_error
                    }})
                elif kind == "notification":
                    frame = classify_notification(frame)
                    await self.emit({"notification": frame})
                elif kind == "dismiss":
                    await self.emit({"dismiss": frame["id"]})
                elif kind == "media":
                    await self.emit({"media": frame})
                    if frame.get("playing") and frame.get("title"):
                        await self.emit({"state": "VIBING", "emotion": "vibing",
                                         "message": f"Playing {frame['title']}"})
        finally:
            if proc.returncode is None:
                proc.kill()
