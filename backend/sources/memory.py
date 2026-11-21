"""Explicit, local-only user memory for MILO."""
from __future__ import annotations

import os
import re
import sqlite3
from pathlib import Path
from typing import Any


class MemoryStoreError(Exception):
    pass


_SENSITIVE_PATTERNS = (
    r"\b(?:password|passcode|pin|otp|one[- ]time code|api key|secret)\b",
    r"\b(?:credit|debit)\b|\bcvv\b|\b(?:bank account|bank balance|routing number)\b",
    r"\b(?:salary|income|loan|account number|tax(?:payer)? id|investment|financial)\b",
    r"\b(?:aadhaar|aadhar|passport|social security|ssn)\b",
    r"\b(?:health|medical|diagnosis|prescription|medication|allergy|doctor|hospital|"
    r"condition|symptom|illness|disease|therapy|treatment|asthma|diabetes|depression|"
    r"anxiety|cancer|epilepsy|hypertension)\b",
    r"पासवर्ड|पिन|ओटीपी|क्रेडिट|डेबिट|बैंक|वेतन|तनख्वाह|आय|निवेश|खाता\s+संख्या|"
    r"आधार|पासपोर्ट|स्वास्थ्य|डॉक्टर|दवा|बीमारी|एलर्जी|अस्थमा|मधुमेह|अवसाद",
)


def _default_path() -> Path:
    override = os.environ.get("MILO_MEMORY_PATH")
    if override:
        return Path(override)
    local_app_data = os.environ.get("LOCALAPPDATA")
    base = Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
    return base / "Milo" / "memory.sqlite3"


def _normalize(value: str) -> str:
    return " ".join(value.casefold().split())


def _contains_sensitive_data(fact: str) -> bool:
    return any(re.search(pattern, fact, re.IGNORECASE) for pattern in _SENSITIVE_PATTERNS)


class MiloMemory:
    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path) if path is not None else _default_path()

    def _connect(self) -> sqlite3.Connection:
        connection: sqlite3.Connection | None = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            connection = sqlite3.connect(self.path, timeout=5)
            connection.row_factory = sqlite3.Row
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS memories (
                    id INTEGER PRIMARY KEY,
                    fact TEXT NOT NULL,
                    normalized TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            connection.commit()
            return connection
        except (OSError, sqlite3.Error) as exc:
            if connection is not None:
                connection.close()
            raise MemoryStoreError(f"Could not access MILO's local memory: {exc}") from exc

    def remember(self, fact: str) -> dict[str, Any]:
        normalized = _normalize(fact)
        if not normalized or len(fact) > 500:
            raise MemoryStoreError("A memory must contain 1 to 500 characters.")
        if _contains_sensitive_data(fact):
            raise MemoryStoreError(
                "I can't save passwords, financial details, or health information."
            )

        connection = self._connect()
        try:
            with connection:
                row = connection.execute(
                    "SELECT id, fact, created_at FROM memories WHERE normalized = ?",
                    (normalized,),
                ).fetchone()
                if row is not None:
                    return dict(row) | {"already_saved": True}
                cursor = connection.execute(
                    "INSERT INTO memories (fact, normalized) VALUES (?, ?)",
                    (fact.strip(), normalized),
                )
                row = connection.execute(
                    "SELECT id, fact, created_at FROM memories WHERE id = ?",
                    (cursor.lastrowid,),
                ).fetchone()
                if row is None:
                    raise MemoryStoreError("The memory could not be read after saving.")
                return dict(row) | {"already_saved": False}
        except sqlite3.Error as exc:
            raise MemoryStoreError(f"Could not save local memory: {exc}") from exc
        finally:
            connection.close()

    def recall(self, query: str = "", limit: int = 50) -> list[dict[str, Any]]:
        connection = self._connect()
        try:
            rows = connection.execute(
                "SELECT id, fact, created_at FROM memories ORDER BY id DESC LIMIT ?",
                (max(1, min(limit, 100)),),
            ).fetchall()
            normalized_query = _normalize(query)
            entries = [dict(row) for row in rows]
            if normalized_query:
                entries = [
                    entry for entry in entries
                    if normalized_query in _normalize(str(entry["fact"]))
                ]
            return entries
        except sqlite3.Error as exc:
            raise MemoryStoreError(f"Could not read local memory: {exc}") from exc
        finally:
            connection.close()

    def forget(self, query: str) -> dict[str, Any]:
        normalized_query = _normalize(query)
        if not normalized_query:
            raise MemoryStoreError("Name the exact memory you want MILO to forget.")
        matches = [
            entry for entry in self.recall()
            if normalized_query in _normalize(str(entry["fact"]))
        ]
        if not matches:
            return {"deleted": False, "message": "I couldn't find that saved memory."}
        if len(matches) > 1:
            return {
                "deleted": False,
                "matches": matches,
                "message": "More than one memory matched. Please be more specific.",
            }

        connection = self._connect()
        try:
            with connection:
                connection.execute("DELETE FROM memories WHERE id = ?", (matches[0]["id"],))
            return {
                "deleted": True,
                "fact": matches[0]["fact"],
                "message": "Forgotten. I removed that saved memory.",
            }
        except sqlite3.Error as exc:
            raise MemoryStoreError(f"Could not remove local memory: {exc}") from exc
        finally:
            connection.close()
