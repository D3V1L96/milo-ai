"""Persistent local reminders delivered as MILO notifications."""
from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

Emit = Callable[[dict[str, Any]], Awaitable[None]]


class ReminderError(ValueError):
    pass


class ReminderService:
    def __init__(self, emit: Emit) -> None:
        self.emit = emit
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
        self._path = base / "MILO" / "reminders.json"
        self._items: list[dict[str, str]] = []
        self._load()

    def _load(self) -> None:
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                self._items = [
                    item for item in data
                    if isinstance(item, dict)
                    and isinstance(item.get("id"), str)
                    and isinstance(item.get("title"), str)
                    and isinstance(item.get("dueAt"), str)
                ]
        except (OSError, json.JSONDecodeError):
            self._items = []

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_suffix(".tmp")
        temporary.write_text(json.dumps(self._items, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(self._path)

    def snapshot(self) -> list[dict[str, str]]:
        return sorted(self._items, key=lambda item: item["dueAt"])

    async def schedule(self, title: str, due_at: str) -> dict[str, Any]:
        title = title.strip() if isinstance(title, str) else ""
        if not title or len(title) > 200:
            raise ReminderError("Reminder text must contain 1 to 200 characters.")
        if not isinstance(due_at, str) or len(due_at) > 80:
            raise ReminderError("Please choose a valid reminder date and time.")
        try:
            due = datetime.fromisoformat(due_at.replace("Z", "+00:00"))
            if due.tzinfo is None:
                due = due.astimezone()
            due = due.astimezone(timezone.utc)
        except ValueError as exc:
            raise ReminderError("Please choose a valid reminder date and time.") from exc
        if due.timestamp() <= time.time() + 5:
            raise ReminderError("That time has passed. Choose a future time.")
        reminder = {"id": uuid.uuid4().hex, "title": title, "dueAt": due.isoformat()}
        self._items.append(reminder)
        await asyncio.to_thread(self._save)
        await self.emit({"reminders": self.snapshot()})
        return reminder

    async def cancel(self, reminder_id: str) -> bool:
        before = len(self._items)
        self._items = [item for item in self._items if item["id"] != reminder_id]
        if len(self._items) == before:
            return False
        await asyncio.to_thread(self._save)
        await self.emit({"reminders": self.snapshot()})
        return True

    async def run(self) -> None:
        while True:
            now = datetime.now(timezone.utc)
            due_items: list[dict[str, str]] = []
            pending: list[dict[str, str]] = []
            for item in self._items:
                try:
                    due = datetime.fromisoformat(item["dueAt"])
                except ValueError:
                    continue
                (due_items if due <= now else pending).append(item)
            if due_items:
                self._items = pending
                await asyncio.to_thread(self._save)
                await self.emit({"reminders": self.snapshot()})
                for item in due_items:
                    await self.emit({"notification": {
                        "id": f"reminder-{item['id']}", "kind": "task", "app": "MILO",
                        "title": item["title"], "body": "Your reminder is due.",
                        "priority": "high",
                    }})
            await asyncio.sleep(2)
