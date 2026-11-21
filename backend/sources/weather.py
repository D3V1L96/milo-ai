"""Current weather lookup using the public Open-Meteo API."""
from __future__ import annotations

import json
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


class WeatherError(Exception):
    pass


_CONDITIONS = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Rime fog",
    51: "Light drizzle",
    53: "Drizzle",
    55: "Heavy drizzle",
    56: "Freezing drizzle",
    57: "Heavy freezing drizzle",
    61: "Light rain",
    63: "Rain",
    65: "Heavy rain",
    66: "Freezing rain",
    67: "Heavy freezing rain",
    71: "Light snow",
    73: "Snow",
    75: "Heavy snow",
    77: "Snow grains",
    80: "Light rain showers",
    81: "Rain showers",
    82: "Heavy rain showers",
    85: "Snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with hail",
    99: "Heavy thunderstorm with hail",
}


def fetch_current_weather(latitude: float, longitude: float) -> dict:
    params = urlencode({
        "latitude": latitude,
        "longitude": longitude,
        "current": (
            "temperature_2m,relative_humidity_2m,apparent_temperature,"
            "weather_code,wind_speed_10m"
        ),
        "timezone": "auto",
    })
    request = Request(
        f"https://api.open-meteo.com/v1/forecast?{params}",
        headers={"User-Agent": "MILO/1.0 (local desktop assistant)"},
    )
    try:
        with urlopen(request, timeout=10) as response:
            payload = json.loads(response.read(100_000).decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise WeatherError(f"Weather update failed: {exc}") from exc

    current = payload.get("current")
    if not isinstance(current, dict):
        raise WeatherError("Weather provider returned no current conditions.")
    try:
        code = int(current["weather_code"])
        return {
            "temperature_c": float(current["temperature_2m"]),
            "feels_like_c": float(current["apparent_temperature"]),
            "humidity_percent": int(current["relative_humidity_2m"]),
            "wind_kmh": float(current["wind_speed_10m"]),
            "condition": _CONDITIONS.get(code, "Unknown conditions"),
            "updated_at": str(current["time"]),
        }
    except (KeyError, TypeError, ValueError) as exc:
        raise WeatherError("Weather provider returned incomplete current conditions.") from exc
