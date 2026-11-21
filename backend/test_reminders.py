from __future__ import annotations

import asyncio
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from sources.reminders import ReminderService


class ReminderServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_due_reminder_survives_reload_then_emits_one_notification(self) -> None:
        frames: list[dict] = []
        fired = asyncio.Event()

        async def emit(frame: dict) -> None:
            frames.append(frame)
            if "notification" in frame:
                fired.set()

        with tempfile.TemporaryDirectory() as folder, patch.dict(
            os.environ, {"LOCALAPPDATA": folder}
        ):
            service = ReminderService(emit)
            reminder = await service.schedule(
                "Check the reminder", 
                (datetime.now(timezone.utc) + timedelta(seconds=6)).isoformat(),
            )
            restored = ReminderService(emit)
            self.assertEqual(restored.snapshot(), [reminder])

            worker = asyncio.create_task(service.run())
            try:
                await asyncio.wait_for(fired.wait(), timeout=9)
            finally:
                worker.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await worker

            notifications = [frame["notification"] for frame in frames if "notification" in frame]
            self.assertEqual(len(notifications), 1)
            self.assertEqual(notifications[0]["title"], "Check the reminder")
            self.assertEqual(service.snapshot(), [])
