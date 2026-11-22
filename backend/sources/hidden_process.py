"""Process options for running Windows helpers without opening a console window."""
from __future__ import annotations

import os
import subprocess
from typing import Any


def hidden_process_options() -> dict[str, Any]:
    if os.name != "nt":
        return {}

    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = subprocess.SW_HIDE
    return {"creationflags": subprocess.CREATE_NO_WINDOW, "startupinfo": startup}
