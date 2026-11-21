"""Paths to packaged runtime assets and source checkout assets."""
from __future__ import annotations

import sys
from pathlib import Path


def bridge_directory() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS) / "bridge"
    return Path(__file__).resolve().parent.parent / "bridge"
