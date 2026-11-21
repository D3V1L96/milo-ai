"""Classify call alerts mirrored into Windows notifications."""
from __future__ import annotations

import re


_CALL_APP = re.compile(
    r"whats\s*app|phone\s*link|your\s+phone|\bphone\b|teams|skype|zoom|"
    r"google\s+meet|messenger|discord|telegram|signal",
    re.IGNORECASE,
)
_CALL_ALERT = re.compile(
    r"\bincoming\s+(?:(?:whatsapp|audio|video|voice)\s+)*call\b|"
    r"\bmissed\s+(?:voice\s+|video\s+)?call\b|"
    r"\boutgoing\s+(?:voice\s+|video\s+)?call\b|"
    r"\b(?:audio|video|voice)\s+call\b|"
    r"\bcall\s+from\b|\b(?:is\s+)?calling\s+you\b|\bis\s+calling\b|"
    r"\bongoing\s+(?:audio\s+|video\s+|voice\s+)?call\b|"
    r"\bcall\s+(?:is\s+)?(?:ringing|in\s+progress|started|connected)\b|"
    r"^calling\b|\byou\s+are\s+calling\b",
    re.IGNORECASE,
)


def classify_notification(frame: dict) -> dict:
    """Return a notification frame with call kind/direction when its text is explicit."""
    app = str(frame.get("app") or "")
    title = str(frame.get("title") or "")
    body = str(frame.get("body") or "")
    combined = f"{title}\n{body}"
    if not _CALL_APP.search(app) or not _CALL_ALERT.search(combined):
        return frame

    text = combined.casefold()
    if re.search(r"\bmissed\b", text):
        direction = "missed"
    elif re.search(r"\bincoming\b|\bcall\s+from\b|\bcalling\s+you\b|\bis\s+calling\b", text):
        direction = "incoming"
    elif re.search(r"\boutgoing\b|\bdialling\b|\bdialing\b|^calling\b|\byou\s+are\s+calling\b", text):
        direction = "outgoing"
    else:
        direction = "active"

    return {
        **frame,
        "kind": "call",
        "callDirection": direction,
        "priority": "high",
    }
