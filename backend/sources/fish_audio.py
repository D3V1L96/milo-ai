"""Fish Audio speech synthesis and credential handling."""
from __future__ import annotations

import json
import os
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

TTS_URL = "https://api.fish.audio/v1/tts"
TTS_MODEL = "s2.1-pro-free"
# Young, warm, expressive bilingual (English/Hindi) voice selected for MILO's companion tone.
DEFAULT_REFERENCE_ID = "7e711cdecd1f4ba0b720c164148e29f6"


class FishAudioConfigurationError(Exception):
    pass


class FishAudioRequestError(Exception):
    pass


def synthesize(text: str) -> bytes:
    api_key = os.environ.get("FISH_API_KEY", "").strip()
    if not api_key:
        raise FishAudioConfigurationError(
            "Fish Audio is not configured. Set FISH_API_KEY in Windows environment variables, "
            "then restart MILO."
        )

    reference_id = os.environ.get("REFERENCE_ID", DEFAULT_REFERENCE_ID).strip()
    payload = json.dumps({
        "text": text,
        "reference_id": reference_id,
        "format": "mp3",
        "latency": "balanced",
    }).encode("utf-8")
    request = Request(
        TTS_URL,
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "model": TTS_MODEL,
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=90) as response:
            audio = response.read()
            if not response.headers.get("Content-Type", "").lower().startswith("audio/"):
                raise FishAudioRequestError(
                    "Fish Audio returned an unexpected response instead of audio."
                )
            return audio
    except HTTPError as exc:
        try:
            details = json.loads(exc.read().decode("utf-8", errors="replace"))
            message = details.get("message", "The speech request was rejected.")
        except (json.JSONDecodeError, AttributeError):
            message = "The speech request was rejected."
        raise FishAudioRequestError(
            f"Fish Audio TTS failed ({exc.code}): {message}"
        ) from exc
    except URLError as exc:
        raise FishAudioRequestError(
            f"Could not connect to Fish Audio TTS: {exc.reason}"
        ) from exc
