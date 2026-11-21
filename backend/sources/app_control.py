"""Discover and control Windows applications through Start Menu shortcuts and windows."""
from __future__ import annotations

import ctypes
import json
import os
import re
import subprocess
from dataclasses import dataclass
from ctypes import wintypes
from pathlib import Path

import psutil


class AppControlError(Exception):
    pass


@dataclass(frozen=True)
class AppSpec:
    key: str
    label: str
    executable: str
    process_names: frozenset[str]
    shortcut: Path | None = None
    app_id: str | None = None


@dataclass(frozen=True)
class WindowInfo:
    hwnd: int
    title: str
    process_name: str


_APPS = {
    "notepad": AppSpec("notepad", "Notepad", "notepad.exe", frozenset({"notepad.exe"})),
    "calculator": AppSpec("calculator", "Calculator", "calc.exe", frozenset({"calculatorapp.exe", "calculator.exe", "calc.exe"})),
    "paint": AppSpec("paint", "Paint", "mspaint.exe", frozenset({"mspaint.exe", "paintstudio.view.exe"})),
    "file explorer": AppSpec("file explorer", "File Explorer", "explorer.exe", frozenset({"explorer.exe"})),
    "settings": AppSpec("settings", "Settings", "ms-settings:", frozenset({"systemsettings.exe"})),
    "edge": AppSpec("edge", "Microsoft Edge", "msedge.exe", frozenset({"msedge.exe"})),
    "chrome": AppSpec("chrome", "Google Chrome", "chrome.exe", frozenset({"chrome.exe"})),
    "firefox": AppSpec("firefox", "Firefox", "firefox.exe", frozenset({"firefox.exe"})),
    "spotify": AppSpec("spotify", "Spotify", "Spotify.exe", frozenset({"spotify.exe"})),
    "visual studio code": AppSpec("visual studio code", "Visual Studio Code", "Code.exe", frozenset({"code.exe"})),
    "whatsapp": AppSpec(
        "whatsapp",
        "WhatsApp",
        "",
        frozenset({"whatsapp.root.exe", "whatsapp.exe"}),
        app_id="5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App",
    ),
}

_ALIASES = {
    "calculator app": "calculator",
    "explorer": "file explorer",
    "file manager": "file explorer",
    "microsoft edge": "edge",
    "google chrome": "chrome",
    "vs code": "visual studio code",
    "vscode": "visual studio code",
    "code": "visual studio code",
}
_IGNORED_PROCESS_NAMES = frozenset({
    "applicationframehost.exe",
    "shellexperiencehost.exe",
    "searchhost.exe",
    "startmenuexperiencehost.exe",
    "textinputhost.exe",
})


def _normalize_name(name: str) -> str:
    return " ".join(name.casefold().split())


def _compact_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.casefold())


def _start_menu_roots() -> tuple[Path, ...]:
    roots: list[Path] = []
    roaming = os.environ.get("APPDATA")
    program_data = os.environ.get("PROGRAMDATA")
    if roaming:
        roots.append(Path(roaming) / "Microsoft" / "Windows" / "Start Menu" / "Programs")
    if program_data:
        roots.append(Path(program_data) / "Microsoft" / "Windows" / "Start Menu" / "Programs")
    return tuple(roots)


def _registered_start_apps() -> list[tuple[str, str]]:
    if os.name != "nt":
        return []
    try:
        completed = subprocess.run(
            [
                "powershell", "-NoProfile", "-Command",
                "Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress",
            ],
            capture_output=True,
            check=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise AppControlError(f"Could not scan registered Windows apps: {exc}") from exc
    try:
        parsed = json.loads(completed.stdout) if completed.stdout.strip() else []
    except json.JSONDecodeError as exc:
        raise AppControlError("Windows returned an invalid registered-app list.") from exc
    entries = parsed if isinstance(parsed, list) else [parsed]
    return [
        (entry["Name"].strip(), entry["AppID"].strip())
        for entry in entries
        if isinstance(entry, dict)
        and isinstance(entry.get("Name"), str) and entry["Name"].strip()
        and isinstance(entry.get("AppID"), str) and entry["AppID"].strip()
    ]


def _discover_installed_apps() -> list[AppSpec]:
    discovered: dict[str, AppSpec] = {}
    for root in _start_menu_roots():
        if not root.is_dir():
            continue
        try:
            for shortcut in root.rglob("*.lnk"):
                label = shortcut.stem.strip()
                normalized = _normalize_name(label)
                if normalized:
                    discovered.setdefault(
                        normalized,
                        AppSpec(normalized, label, "", frozenset(), shortcut),
                    )
        except OSError as exc:
            raise AppControlError(f"Could not scan installed apps in {root}: {exc}") from exc
    for label, app_id in _registered_start_apps():
        normalized = _normalize_name(label)
        existing = discovered.get(normalized)
        if existing:
            if existing.app_id is None:
                discovered[normalized] = AppSpec(
                    existing.key, existing.label, existing.executable,
                    existing.process_names, existing.shortcut, app_id,
                )
        else:
            discovered[normalized] = AppSpec(
                normalized, label, "", frozenset(), app_id=app_id,
            )
    return list(discovered.values())


def _find_executable(app: AppSpec) -> str | None:
    system_root = Path(os.environ.get("SystemRoot", r"C:\Windows"))
    program_files = Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
    program_files_x86 = Path(os.environ.get("ProgramFiles(x86)", str(program_files)))
    local_app_data = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local")))
    roaming_app_data = Path(os.environ.get("APPDATA", str(Path.home() / "AppData" / "Roaming")))
    candidates = [system_root / "System32" / app.executable]
    candidates.extend({
        "edge": [
            program_files_x86 / "Microsoft" / "Edge" / "Application" / app.executable,
            program_files / "Microsoft" / "Edge" / "Application" / app.executable,
        ],
        "chrome": [
            program_files / "Google" / "Chrome" / "Application" / app.executable,
            program_files_x86 / "Google" / "Chrome" / "Application" / app.executable,
            local_app_data / "Google" / "Chrome" / "Application" / app.executable,
        ],
        "firefox": [
            program_files / "Mozilla Firefox" / app.executable,
            program_files_x86 / "Mozilla Firefox" / app.executable,
        ],
        "spotify": [
            roaming_app_data / "Spotify" / app.executable,
            local_app_data / "Microsoft" / "WindowsApps" / app.executable,
        ],
        "visual studio code": [
            local_app_data / "Programs" / "Microsoft VS Code" / app.executable,
            program_files / "Microsoft VS Code" / app.executable,
        ],
    }.get(app.key, []))
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)

    import winreg

    registry_key = rf"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{app.executable}"
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        try:
            with winreg.OpenKey(hive, registry_key) as key:
                registered_path, _ = winreg.QueryValueEx(key, None)
        except OSError:
            continue
        path = Path(str(registered_path).strip('"'))
        if path.is_file():
            return str(path)
    return None


def _visible_windows() -> list[WindowInfo]:
    if os.name != "nt":
        raise AppControlError("App control is only supported on Windows.")

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    get_pid = user32.GetWindowThreadProcessId
    get_pid.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    get_pid.restype = wintypes.DWORD
    is_visible = user32.IsWindowVisible
    is_visible.argtypes = [wintypes.HWND]
    is_visible.restype = wintypes.BOOL
    get_title_length = user32.GetWindowTextLengthW
    get_title_length.argtypes = [wintypes.HWND]
    get_title_length.restype = ctypes.c_int
    get_title = user32.GetWindowTextW
    get_title.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    get_title.restype = ctypes.c_int
    get_class_name = user32.GetClassNameW
    get_class_name.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    get_class_name.restype = ctypes.c_int
    enum_windows = user32.EnumWindows
    enum_windows.argtypes = [callback_type, wintypes.LPARAM]
    enum_windows.restype = wintypes.BOOL

    process_names: dict[int, str] = {}
    for process in psutil.process_iter(["pid", "name"]):
        try:
            name = process.info.get("name") or ""
            if name.casefold() not in _IGNORED_PROCESS_NAMES:
                process_names[process.info["pid"]] = name.casefold()
        except (psutil.AccessDenied, psutil.NoSuchProcess):
            continue

    windows: list[WindowInfo] = []

    @callback_type
    def collect(hwnd: int, _parameter: int) -> bool:
        if not is_visible(hwnd):
            return True
        title_length = get_title_length(hwnd)
        if title_length <= 0:
            return True
        title = ctypes.create_unicode_buffer(title_length + 1)
        get_title(hwnd, title, len(title))
        process_id = wintypes.DWORD()
        get_pid(hwnd, ctypes.byref(process_id))
        process_name = process_names.get(process_id.value)
        if not process_name:
            return True
        if process_name == "explorer.exe":
            class_name = ctypes.create_unicode_buffer(128)
            get_class_name(hwnd, class_name, len(class_name))
            if class_name.value.casefold() not in ("cabinetwclass", "explorewclass"):
                return True
        windows.append(WindowInfo(int(hwnd), title.value, process_name))
        return True

    if not enum_windows(collect, 0):
        error = ctypes.get_last_error()
        if error:
            raise AppControlError(f"Could not inspect open windows (Windows error {error}).")
    return windows


def _process_label(process_name: str) -> str:
    return Path(process_name).stem.replace("_", " ").replace("-", " ").title()


def scan_apps() -> list[dict[str, str | bool | int]]:
    entries: dict[str, dict[str, str | bool | int]] = {}
    shortcuts = _discover_installed_apps() if os.name == "nt" else []
    for app in shortcuts:
        entries[_normalize_name(app.label)] = {
            "name": app.label,
            "installed": True,
            "running": False,
            "windows": 0,
        }

    windows = _visible_windows() if os.name == "nt" else []
    for app in _APPS.values():
        installed = app.key == "settings" or (
            os.name == "nt" and _find_executable(app) is not None
        )
        if installed:
            key = _normalize_name(app.label)
            entries.setdefault(key, {
                "name": app.label,
                "installed": True,
                "running": False,
                "windows": 0,
            })

    process_labels = {
        process_name: app.label
        for app in _APPS.values()
        for process_name in app.process_names
    }
    for window in windows:
        label = process_labels.get(window.process_name, _process_label(window.process_name))
        if window.process_name not in process_labels:
            process_name = _compact_name(Path(window.process_name).stem)
            for installed in shortcuts:
                installed_name = _compact_name(installed.label)
                if installed_name == process_name or (
                    " " in installed.label and installed_name in _compact_name(window.title)
                ):
                    label = installed.label
                    break
        key = _normalize_name(label)
        entry = entries.setdefault(key, {
            "name": label,
            "installed": False,
            "running": False,
            "windows": 0,
        })
        entry["running"] = True
        entry["windows"] = int(entry["windows"]) + 1

    return sorted(entries.values(), key=lambda entry: str(entry["name"]).casefold())


def available_apps() -> list[str]:
    return [str(app["name"]) for app in scan_apps()]


def _resolve_app(name: str) -> AppSpec:
    raw_name = _normalize_name(re.sub(r"\.exe$", "", name.strip(), flags=re.IGNORECASE))
    normalized = _ALIASES.get(raw_name, raw_name)
    installed_apps = _discover_installed_apps() if os.name == "nt" else []
    for installed in installed_apps:
        if raw_name == _normalize_name(installed.label) or normalized == _normalize_name(installed.label):
            known = _APPS.get(normalized)
            if known:
                return AppSpec(
                    known.key, installed.label, known.executable,
                    known.process_names, installed.shortcut, installed.app_id,
                )
            return installed
    app = _APPS.get(normalized)
    if app is not None and os.name != "nt":
        return app
    if os.name == "nt":
        if app is not None and app.key == "settings":
            return app
        if app is not None and not app.app_id and _find_executable(app):
            return app
        windows = _visible_windows()
        for window in windows:
            if app is not None and window.process_name in app.process_names:
                return app
            if normalized == _normalize_name(_process_label(window.process_name)):
                return AppSpec(
                    normalized,
                    _process_label(window.process_name),
                    "",
                    frozenset({window.process_name}),
                )
    choices = ", ".join(available_apps())
    raise AppControlError(
        f"Could not find an exact installed or open app named {name!r}."
        + (f" Available apps: {choices}." if choices else "")
    )


def app_name_was_explicitly_named(text: str, name: str) -> bool:
    try:
        app = _resolve_app(name)
    except AppControlError:
        return False
    candidates = {app.label, app.key}
    if app.executable:
        candidates.add(Path(app.executable).stem)
    for known in _APPS.values():
        if _normalize_name(known.label) == _normalize_name(app.label):
            candidates.update({known.label, known.key})
            candidates.update(Path(process_name).stem for process_name in known.process_names)
            candidates.update(alias for alias, key in _ALIASES.items() if key == known.key)
    candidates.update(alias for alias, key in _ALIASES.items() if key == app.key)
    normalized_text = " ".join(text.casefold().split())
    return any(
        re.search(rf"(?<![\w]){re.escape(candidate.casefold())}(?![\w])", normalized_text)
        for candidate in candidates
        if candidate
    )


def open_app(name: str) -> str:
    if os.name != "nt":
        raise AppControlError("App control is only supported on Windows.")
    app = _resolve_app(name)
    if app.app_id:
        try:
            os.startfile(f"shell:AppsFolder\\{app.app_id}")
        except OSError as exc:
            raise AppControlError(f"Could not open {app.label}: {exc}") from exc
        return f"Opened {app.label}."
    if app.shortcut is not None:
        try:
            os.startfile(str(app.shortcut))
        except OSError as exc:
            raise AppControlError(f"Could not open {app.label}: {exc}") from exc
        return f"Opened {app.label}."
    if app.executable.startswith("ms-settings:"):
        try:
            os.startfile(app.executable)
        except OSError as exc:
            raise AppControlError(f"Could not open {app.label}: {exc}") from exc
        return f"Opened {app.label}."

    executable = _find_executable(app)
    if not executable:
        raise AppControlError(f"{app.label} is not installed or could not be found.")
    try:
        subprocess.Popen([executable], close_fds=True)
    except OSError as exc:
        raise AppControlError(f"Could not open {app.label}: {exc}") from exc
    return f"Opened {app.label}."


def _matching_windows(app: AppSpec, windows: list[WindowInfo]) -> list[WindowInfo]:
    if app.process_names:
        matches = [window for window in windows if window.process_name in app.process_names]
        if matches:
            return matches

    label = _compact_name(app.label)
    if len(label) < 3:
        return []
    return [
        window
        for window in windows
        if label == _compact_name(Path(window.process_name).stem)
        or re.search(
            rf"(?<![\w]){re.escape(app.label.casefold())}(?![\w])",
            window.title.casefold(),
        ) is not None
    ]


def close_app(name: str) -> tuple[str, int]:
    app = _resolve_app(name)
    windows = _matching_windows(app, _visible_windows())
    if not windows:
        raise AppControlError(f"No visible {app.label} windows were found.")

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    post_message = user32.PostMessageW
    post_message.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    post_message.restype = wintypes.BOOL
    requested = sum(bool(post_message(window.hwnd, 0x0010, 0, 0)) for window in windows)
    if requested == 0:
        error = ctypes.get_last_error()
        raise AppControlError(f"Windows did not accept the close request (error {error}).")
    return app.label, requested
