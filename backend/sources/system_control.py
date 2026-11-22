"""Narrow, explicit Windows system controls used by MILO."""
from __future__ import annotations

import ctypes
import os
import subprocess
from typing import Any

import psutil
from .hidden_process import hidden_process_options


class SystemControlError(Exception):
    pass


_SETTINGS_PAGES = {
    "display": "ms-settings:display",
    "network": "ms-settings:network",
    "bluetooth": "ms-settings:bluetooth",
    "apps": "ms-settings:appsfeatures",
    "updates": "ms-settings:windowsupdate",
    "sound": "ms-settings:sound",
}


def _require_windows() -> None:
    if os.name != "nt":
        raise SystemControlError("Windows system controls are only available on Windows.")


def system_status() -> dict[str, Any]:
    try:
        memory = psutil.virtual_memory()
        result: dict[str, Any] = {
            "cpu_percent": psutil.cpu_percent(interval=0.1),
            "ram_percent": memory.percent,
            "ram_used_gb": round(memory.used / 1_000_000_000, 2),
        }
        battery = psutil.sensors_battery()
    except (psutil.Error, OSError, NotImplementedError) as exc:
        raise SystemControlError(f"Could not read system status: {exc}") from exc
    if battery is not None:
        result["battery_percent"] = battery.percent
        result["charging"] = bool(battery.power_plugged)
    return result


def _run_powershell(script: str) -> str:
    _require_windows()
    try:
        completed = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            check=True,
            text=True,
            timeout=15,
            **hidden_process_options(),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        detail = getattr(exc, "stderr", None) or str(exc)
        raise SystemControlError(f"Windows could not complete the system action: {detail}") from exc
    return completed.stdout.strip()


def get_brightness() -> int:
    output = _run_powershell(
        "$brightness = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness "
        "-ErrorAction Stop | Select-Object -First 1 -ExpandProperty CurrentBrightness; "
        "if ($null -eq $brightness) { throw 'No brightness-capable display was found.' }; "
        "Write-Output $brightness"
    )
    try:
        return int(output)
    except ValueError as exc:
        raise SystemControlError("Windows returned an invalid brightness value.") from exc


def set_brightness(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 100:
        raise SystemControlError("Brightness must be a whole number between 0 and 100.")
    _run_powershell(
        "$brightness = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods "
        "-ErrorAction Stop | Select-Object -First 1; "
        "if ($null -eq $brightness) { throw 'No brightness-capable display was found.' }; "
        f"$brightness.WmiSetBrightness(1, {value}) | Out-Null"
    )
    return value


def set_network_adapter(kind: str, enabled: bool) -> str:
    if kind not in {"wifi", "bluetooth"}:
        raise SystemControlError("Only Wi-Fi and Bluetooth adapters can be changed.")
    if not isinstance(enabled, bool):
        raise SystemControlError("Network adapter state must be enabled or disabled.")
    expression = "Wi-Fi|Wireless|802\\.11" if kind == "wifi" else "Bluetooth"
    verb = "Enable" if enabled else "Disable"
    output = _run_powershell(
        "$adapter = Get-NetAdapter -Physical -ErrorAction Stop | "
        f"Where-Object {{ $_.InterfaceDescription -match '{expression}' }} | "
        "Select-Object -First 1; "
        "if ($null -eq $adapter) { throw 'No matching network adapter was found.' }; "
        f"{verb}-NetAdapter -Name $adapter.Name -Confirm:$false -ErrorAction Stop; "
        "Write-Output $adapter.Name"
    )
    if not output:
        raise SystemControlError(
            f"Windows did not report a {kind.upper()} adapter; check permissions and device status."
        )
    return output.splitlines()[-1].strip()


def lock_workstation() -> None:
    _require_windows()
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    if not user32.LockWorkStation():
        error = ctypes.get_last_error()
        raise SystemControlError(f"Windows could not lock the workstation (error {error}).")


def open_settings_page(page: str) -> str:
    _require_windows()
    uri = _SETTINGS_PAGES.get(page)
    if uri is None:
        raise SystemControlError(f"Unsupported Windows Settings page: {page}.")
    try:
        os.startfile(uri)
    except OSError as exc:
        raise SystemControlError(f"Could not open Windows Settings: {exc}") from exc
    return page


def schedule_power_action(action: str) -> None:
    _require_windows()
    if action not in {"shutdown", "restart"}:
        raise SystemControlError("Only shutdown and restart can be scheduled.")
    switch = "/s" if action == "shutdown" else "/r"
    try:
        subprocess.Popen(
            ["shutdown.exe", switch, "/t", "60", "/c", "MILO requested this action."],
            close_fds=True,
            **hidden_process_options(),
        )
    except OSError as exc:
        raise SystemControlError(f"Could not schedule {action}: {exc}") from exc


def cancel_scheduled_power_action() -> None:
    _require_windows()
    try:
        subprocess.run(
            ["shutdown.exe", "/a"],
            capture_output=True,
            check=True,
            text=True,
            timeout=15,
            **hidden_process_options(),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        detail = getattr(exc, "stderr", None) or str(exc)
        raise SystemControlError(f"Could not cancel the scheduled power action: {detail}") from exc
