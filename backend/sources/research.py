"""DuckDuckGo web search for MILO's research status panel."""
from __future__ import annotations

import asyncio
import re
import os
import shutil
import subprocess
import webbrowser
from html.parser import HTMLParser
from pathlib import Path
from typing import Awaitable, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urljoin, urlparse
from urllib.request import Request, urlopen

Emit = Callable[[dict], Awaitable[None]]


class ResearchError(Exception):
    pass


class _DuckDuckGoParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.titles: list[tuple[str, str]] = []
        self.snippets: list[str] = []
        self._capture: str | None = None
        self._capture_tag: str | None = None
        self._parts: list[str] = []
        self._href = ""

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        classes = set((attributes.get("class") or "").split())
        if self._capture is not None:
            return
        if tag == "a" and classes.intersection({"result__a", "result-link"}):
            self._capture = "title"
            self._capture_tag = tag
            self._href = attributes.get("href") or ""
            self._parts = []
        elif classes.intersection({"result__snippet", "result-snippet"}):
            self._capture = "snippet"
            self._capture_tag = tag
            self._parts = []

    def handle_data(self, data: str) -> None:
        if self._capture is not None:
            self._parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if self._capture is None or tag != self._capture_tag:
            return
        text = " ".join(" ".join(self._parts).split())
        if self._capture == "title":
            self.titles.append((self._href, text))
        elif text:
            self.snippets.append(text)
        self._capture = None
        self._capture_tag = None
        self._parts = []
        self._href = ""


def _result_url(raw_url: str) -> str | None:
    absolute = urljoin("https://html.duckduckgo.com", raw_url)
    parsed = urlparse(absolute)
    if parsed.path == "/l/":
        absolute = parse_qs(parsed.query).get("uddg", [""])[0]
        parsed = urlparse(absolute)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return None
    if parsed.hostname and parsed.hostname.lower().endswith("duckduckgo.com"):
        return None
    return absolute


def parse_search_results(html: str, limit: int = 5) -> list[dict[str, str]]:
    parser = _DuckDuckGoParser()
    parser.feed(html)
    results: list[dict[str, str]] = []
    for index, (raw_url, title) in enumerate(parser.titles):
        url = _result_url(raw_url)
        if not url or not title:
            continue
        results.append({
            "title": title,
            "url": url,
            "snippet": parser.snippets[index] if index < len(parser.snippets) else "",
        })
        if len(results) >= limit:
            break
    return results


def search_duckduckgo(query: str) -> list[dict[str, str]]:
    normalized = query.strip()
    if not normalized or len(normalized) > 200:
        raise ResearchError("Search queries must contain 1 to 200 characters.")

    url = "https://lite.duckduckgo.com/lite/?" + urlencode({"q": normalized})
    request = Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36"
            ),
            "Accept": "text/html",
        },
    )
    try:
        with urlopen(request, timeout=10) as response:
            html = response.read(1_500_000).decode("utf-8", errors="replace")
    except (HTTPError, URLError, TimeoutError) as exc:
        raise ResearchError(f"DuckDuckGo search failed: {exc}") from exc
    results = parse_search_results(html)
    lowered = html.lower()
    if not results and any(marker in lowered for marker in ("anomaly-modal", "captcha", "challenge")):
        raise ResearchError("DuckDuckGo could not complete the search right now. Try again shortly.")
    return results


def open_search_results(query: str) -> str:
    normalized = query.strip()
    if not normalized or len(normalized) > 200:
        raise ResearchError("Search queries must contain 1 to 200 characters.")
    url = "https://search.brave.com/search?" + urlencode({"q": normalized})
    executable = _brave_executable()
    if executable:
        try:
            subprocess.Popen([executable, url], close_fds=True)
        except OSError as exc:
            raise ResearchError(f"Could not open Brave search results: {exc}") from exc
    elif os.name == "nt":
        raise ResearchError("Brave is not installed or could not be found, so I couldn't open the results.")
    else:
        _open_browser_url(url, "Brave search results")
    return url


def _brave_executable() -> str | None:
    executable = shutil.which("brave.exe") or shutil.which("brave")
    if executable:
        return executable
    if os.name != "nt":
        return None

    local = Path(os.environ.get("LOCALAPPDATA", ""))
    program_files = Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
    program_files_x86 = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"))
    candidates = (
        local / "BraveSoftware" / "Brave-Browser" / "Application" / "brave.exe",
        program_files / "BraveSoftware" / "Brave-Browser" / "Application" / "brave.exe",
        program_files_x86 / "BraveSoftware" / "Brave-Browser" / "Application" / "brave.exe",
    )
    if path := next((str(candidate) for candidate in candidates if candidate.is_file()), None):
        return path
    try:
        import winreg

        key_path = r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\brave.exe"
        for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            try:
                with winreg.OpenKey(hive, key_path) as key:
                    path, _ = winreg.QueryValueEx(key, None)
            except OSError:
                continue
            if Path(str(path).strip('"')).is_file():
                return str(path).strip('"')
    except ImportError:
        pass
    return None


def _open_browser_url(url: str, description: str) -> None:
    try:
        opened = webbrowser.open(url, new=2)
    except (OSError, webbrowser.Error) as exc:
        raise ResearchError(f"Could not open {description} in the default browser: {exc}") from exc
    if not opened:
        raise ResearchError(f"Could not open {description} in the default browser.")


def open_youtube_video(query: str) -> dict[str, str]:
    normalized = query.strip()
    if not normalized or len(normalized) > 160:
        raise ResearchError("Song searches must contain 1 to 160 characters.")

    results = search_duckduckgo(f"site:youtube.com/watch {normalized}")
    candidates: list[tuple[int, int, str, str]] = []
    wants_lyrics = re.search(r"\blyrics?\b", normalized, re.IGNORECASE) is not None
    for index, result in enumerate(results):
        parsed = urlparse(result["url"])
        host = (parsed.hostname or "").casefold()
        if host not in {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}:
            continue
        path_parts = parsed.path.strip("/").split("/")
        if host == "youtu.be":
            video_id = path_parts[0]
        elif path_parts[0] == "watch":
            video_id = (
                path_parts[1]
                if len(path_parts) > 1
                else parse_qs(parsed.query).get("v", [""])[0]
            )
        else:
            continue
        if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
            continue
        title = result["title"]
        lowered_title = title.casefold()
        score = 1 if "official" in lowered_title else 0
        if "music video" in lowered_title:
            score += 3
        elif "official video" in lowered_title:
            score += 2
        if re.search(r"\blyrics?\b|\blyric video\b", lowered_title):
            score += 3 if wants_lyrics else -2
        candidates.append((score, index, title, video_id))

    if candidates:
        _, _, title, video_id = max(candidates, key=lambda candidate: (candidate[0], -candidate[1]))
        video_url = "https://www.youtube.com/watch?" + urlencode({
            "v": video_id,
            "autoplay": "1",
        })
        _open_browser_url(video_url, "the YouTube video")
        return {"title": title, "url": video_url}
    raise ResearchError("I couldn't find a matching YouTube video. Try a more specific song title.")


class ResearchRunner:
    def __init__(self, emit: Emit) -> None:
        self.emit = emit
        self._job: asyncio.Task[None] | None = None
        self._generation = 0

    async def start(self, query: str) -> None:
        normalized = query.strip()
        if not normalized or len(normalized) > 200:
            await self.emit({
                "state": "ERROR", "emotion": "confused",
                "message": "Search queries must contain 1 to 200 characters.",
                "research": {"query": normalized[:200], "status": "error", "results": []},
            })
            return
        if self._job and not self._job.done():
            self._job.cancel()
        self._generation += 1
        generation = self._generation
        self._job = asyncio.create_task(self._run(normalized, generation))

    async def _run(self, query: str, generation: int) -> None:
        await self.emit({
            "state": "RESEARCH", "emotion": "curious",
            "message": f"Researching: {query}", "progress": 5,
            "research": {"query": query, "status": "searching", "results": []},
        })
        try:
            results = await asyncio.to_thread(search_duckduckgo, query)
        except asyncio.CancelledError:
            return
        except ResearchError as exc:
            if generation == self._generation:
                await self.emit({
                    "state": "ERROR", "emotion": "confused",
                    "message": str(exc), "progress": 0,
                    "research": {
                        "query": query, "status": "error", "results": [], "error": str(exc)
                    },
                })
        else:
            if generation == self._generation:
                message = f"Found {len(results)} results for: {query}"
                await self.emit({
                    "state": "SUCCESS", "emotion": "curious",
                    "message": message, "progress": 100,
                    "research": {
                        "query": query, "status": "complete", "results": results
                    },
                })

    async def cancel(self) -> None:
        if self._job and not self._job.done():
            self._job.cancel()
            await self._job
