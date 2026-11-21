from __future__ import annotations

import asyncio
import time
from typing import Awaitable, Callable

import psutil

Emit = Callable[[dict], Awaitable[None]]


class SystemMonitor:
    def __init__(self) -> None:
        self.started = time.time()
        self._last_alert: dict[str, float] = {}
        self._battery_plugged: bool | None = None
        psutil.cpu_percent(interval=None)  # prime the counter

    def _cooldown_ok(self, key: str, seconds: int) -> bool:
        now = time.time()
        if now - self._last_alert.get(key, 0) < seconds:
            return False
        self._last_alert[key] = now
        return True

    async def run(self, emit: Emit, interval: float = 2.0) -> None:
        while True:
            cpu = psutil.cpu_percent(interval=None)
            mem = psutil.virtual_memory()
            frame: dict = {
                "metrics": {
                    "cpu": round(cpu, 1),
                    "ram": round(mem.percent, 1),
                    "ram_used_gb": round(mem.used / 1e9, 2),
                    "net_sent_mb": round(psutil.net_io_counters().bytes_sent / 1e6, 1),
                    "net_recv_mb": round(psutil.net_io_counters().bytes_recv / 1e6, 1),
                }
            }

            bat = psutil.sensors_battery()
            if bat is not None:
                frame["metrics"]["battery"] = round(bat.percent, 1)
                frame["metrics"]["charging"] = bool(bat.power_plugged)

                if self._battery_plugged is not None and self._battery_plugged != bat.power_plugged:
                    await emit({"notification": {
                        "id": f"power-{int(time.time())}", "kind": "system", "app": "Windows",
                        "title": "Charger connected" if bat.power_plugged else "Running on battery",
                        "body": f"Battery at {bat.percent:.0f}%.", "priority": "low"}})
                self._battery_plugged = bool(bat.power_plugged)

                if not bat.power_plugged and bat.percent <= 20 and self._cooldown_ok("battery", 600):
                    await emit({"notification": {
                        "id": f"battery-{int(time.time())}", "kind": "alert", "app": "Windows",
                        "title": f"Battery at {bat.percent:.0f}%",
                        "body": "Plug in your charger to avoid shutdown.", "priority": "high"}})
                    await emit({"state": "ERROR", "emotion": "confused",
                                "message": f"Battery low: {bat.percent:.0f}%"})

            if cpu > 90 and self._cooldown_ok("cpu", 300):
                top = sorted(psutil.process_iter(["name", "cpu_percent"]),
                             key=lambda p: p.info["cpu_percent"] or 0, reverse=True)[:3]
                names = ", ".join(p.info["name"] or "?" for p in top)
                await emit({"notification": {
                    "id": f"cpu-{int(time.time())}", "kind": "alert", "app": "System",
                    "title": f"CPU at {cpu:.0f}%", "body": f"Top processes: {names}",
                    "priority": "normal"}})

            if mem.percent > 90 and self._cooldown_ok("ram", 300):
                await emit({"notification": {
                    "id": f"ram-{int(time.time())}", "kind": "alert", "app": "System",
                    "title": f"Memory at {mem.percent:.0f}%",
                    "body": f"{mem.used / 1e9:.1f} GB of {mem.total / 1e9:.1f} GB in use.",
                    "priority": "normal"}})

            await emit(frame)
            await asyncio.sleep(interval)
