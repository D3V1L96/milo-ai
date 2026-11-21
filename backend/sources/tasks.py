"""Executes whitelisted real tasks and streams genuine progress.

Only predefined task types run. No arbitrary shell strings from the client.
"""
from __future__ import annotations

import asyncio
import hashlib
import time
from pathlib import Path
from typing import Awaitable, Callable

Emit = Callable[[dict], Awaitable[None]]

ALLOWED_ROOTS = [Path.home() / "Downloads", Path.home() / "Documents", Path.home() / "Desktop"]


class TaskRunner:
    def __init__(self, emit: Emit) -> None:
        self.emit = emit
        self._job: asyncio.Task | None = None

    async def start(self, task: str, args: dict) -> None:
        if self._job and not self._job.done():
            await self.emit({"state": "ERROR", "emotion": "confused",
                             "message": "A task is already running."})
            return
        handler = {"hash_file": self._hash_file, "count_files": self._count_files}.get(task)
        if handler is None:
            await self.emit({"state": "ERROR", "emotion": "confused",
                             "message": f"Task not allowed: {task}"})
            return
        self._job = asyncio.create_task(self._guard(handler(args)))

    async def _guard(self, coro) -> None:
        try:
            await coro
        except asyncio.CancelledError:
            await self.emit({"state": "IDLE", "emotion": "calm", "message": "Task cancelled.", "progress": 0})
        except Exception as exc:
            await self.emit({"state": "ERROR", "emotion": "confused", "message": str(exc), "progress": 0})

    async def cancel(self) -> None:
        if self._job and not self._job.done():
            self._job.cancel()

    def _resolve(self, raw: str) -> Path:
        p = Path(raw).expanduser().resolve()
        if not any(p.is_relative_to(root.resolve()) for root in ALLOWED_ROOTS):
            raise ValueError("Path outside allowed folders (Downloads, Documents, Desktop).")
        if not p.exists():
            raise FileNotFoundError(str(p))
        return p

    async def _hash_file(self, args: dict) -> None:
        path = self._resolve(args.get("path", ""))
        if not path.is_file():
            raise ValueError("Not a file.")
        total = path.stat().st_size or 1
        done = 0
        digest = hashlib.sha256()
        started = time.time()

        await self.emit({"state": "WORKING", "emotion": "focused",
                         "message": f"Hashing {path.name}", "progress": 0})
        with path.open("rb") as fh:
            while chunk := await asyncio.to_thread(fh.read, 1024 * 1024):
                digest.update(chunk)
                done += len(chunk)
                pct = min(100, done / total * 100)
                await self.emit({"state": "WORKING", "emotion": "focused",
                                 "message": f"Hashing {path.name}", "progress": round(pct, 1)})
                await asyncio.sleep(0)  # yield so the socket stays responsive

        took = time.time() - started
        short = digest.hexdigest()[:16]
        await self.emit({"state": "SUCCESS", "emotion": "happy",
                         "message": f"SHA-256 {short}... in {took:.1f}s", "progress": 100})
        await self.emit({"notification": {
            "id": f"hash-{int(time.time())}", "kind": "task", "app": "MILO",
            "title": f"{path.name} hashed",
            "body": f"SHA-256 {digest.hexdigest()}", "priority": "normal"}})

    async def _count_files(self, args: dict) -> None:
        root = self._resolve(args.get("path", str(Path.home() / "Downloads")))
        await self.emit({"state": "WORKING", "emotion": "focused",
                         "message": f"Scanning {root.name}", "progress": 0})
        count = 0
        size = 0
        for i, p in enumerate(await asyncio.to_thread(lambda: list(root.rglob("*")))):
            if p.is_file():
                count += 1
                size += p.stat().st_size
            if i % 200 == 0:
                await self.emit({"state": "WORKING", "emotion": "focused",
                                 "message": f"{count} files found", "progress": min(95, i / 20)})
                await asyncio.sleep(0)
        await self.emit({"state": "SUCCESS", "emotion": "happy",
                         "message": f"{count} files, {size / 1e6:.1f} MB", "progress": 100})
        await self.emit({"notification": {
            "id": f"scan-{int(time.time())}", "kind": "task", "app": "MILO",
            "title": f"{root.name} scanned",
            "body": f"{count} files ? {size / 1e6:.1f} MB", "priority": "normal"}})
