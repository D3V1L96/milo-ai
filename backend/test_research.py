from __future__ import annotations

import json
import unittest
from io import BytesIO
from urllib.parse import parse_qs, urlparse
from unittest.mock import patch

from sources.research import (
    ResearchError,
    open_search_results,
    open_youtube_video,
    parse_search_results,
    search_duckduckgo,
)
from sources.weather import fetch_current_weather


class ResearchTests(unittest.TestCase):
    def test_parses_search_results_and_unwraps_duckduckgo_links(self) -> None:
        html = """
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide">
          Example guide
        </a>
        <a class="result__snippet">A useful summary.</a>
        <a class="result__a" href="javascript:alert(1)">Unsafe result</a>
        """

        self.assertEqual(parse_search_results(html), [{
            "title": "Example guide",
            "url": "https://example.com/guide",
            "snippet": "A useful summary.",
        }])

    def test_parses_duckduckgo_lite_markup(self) -> None:
        html = """
        <a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fresult">
          Search result
        </a>
        <td class="result-snippet">Result description.</td>
        """

        self.assertEqual(parse_search_results(html), [{
            "title": "Search result",
            "url": "https://example.org/result",
            "snippet": "Result description.",
        }])

    def test_rejects_empty_query_without_network_request(self) -> None:
        with self.assertRaises(ResearchError):
            search_duckduckgo("  ")

    def test_opens_brave_search_url_in_brave(self) -> None:
        with patch("sources.research._brave_executable", return_value="brave.exe"), \
                patch("sources.research.subprocess.Popen") as launch_brave:
            url = open_search_results("latest technology")

        self.assertEqual(urlparse(url).hostname, "search.brave.com")
        self.assertEqual(parse_qs(urlparse(url).query)["q"], ["latest technology"])
        launch_brave.assert_called_once_with(["brave.exe", url], close_fds=True)

    def test_opens_only_a_validated_youtube_watch_result(self) -> None:
        results = [
            {
                "title": "Official Lyric Video",
                "url": "https://www.youtube.com/watch/?v=abcdefghijk",
            },
            {
                "title": "Official Music Video",
                "url": "https://www.youtube.com/watch/JGwWNGJdvx8",
            },
        ]
        with patch("sources.research.search_duckduckgo", return_value=results), \
                patch("sources.research.webbrowser.open", return_value=True) as open_browser:
            video = open_youtube_video("Shape of You")

        self.assertEqual(video["title"], "Official Music Video")
        self.assertEqual(urlparse(video["url"]).hostname, "www.youtube.com")
        self.assertEqual(parse_qs(urlparse(video["url"]).query), {
            "v": ["JGwWNGJdvx8"], "autoplay": ["1"]
        })
        open_browser.assert_called_once_with(video["url"], new=2)

    def test_does_not_open_non_video_search_results(self) -> None:
        results = [
            {"title": "Not a watch page", "url": "https://www.youtube.com/results?search_query=song"},
            {"title": "Not YouTube", "url": "https://example.com/watch?v=abcdefghijk"},
        ]
        with patch("sources.research.search_duckduckgo", return_value=results), \
                patch("sources.research.webbrowser.open") as open_browser:
            with self.assertRaises(ResearchError):
                open_youtube_video("a song")

        open_browser.assert_not_called()


class WeatherTests(unittest.TestCase):
    def test_maps_open_meteo_current_conditions(self) -> None:
        payload = {
            "current": {
                "temperature_2m": 22.4,
                "relative_humidity_2m": 58,
                "apparent_temperature": 23.1,
                "weather_code": 2,
                "wind_speed_10m": 8.2,
                "time": "2026-11-17T14:00",
            }
        }

        with patch("sources.weather.urlopen", return_value=BytesIO(json.dumps(payload).encode())):
            result = fetch_current_weather(28.6, 77.2)

        self.assertEqual(result["condition"], "Partly cloudy")
        self.assertEqual(result["temperature_c"], 22.4)
        self.assertEqual(result["humidity_percent"], 58)


if __name__ == "__main__":
    unittest.main()
