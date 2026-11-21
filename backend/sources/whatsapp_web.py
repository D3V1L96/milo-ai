"""Use a private persistent Edge profile for explicit WhatsApp Web actions."""
from __future__ import annotations

import asyncio
import os
import re
import tkinter
from pathlib import Path
from tkinter import filedialog

from playwright.async_api import (
    BrowserContext,
    Error as PlaywrightError,
    Page,
    Playwright,
    TimeoutError as PlaywrightTimeoutError,
    async_playwright,
)


class WhatsAppError(Exception):
    pass


_WHATSAPP_URL = "https://web.whatsapp.com/"
_SEARCH_FALLBACK = 'div[contenteditable="true"][data-tab="3"]'
_MESSAGE_FALLBACK = 'footer [contenteditable="true"]'


def _profile_directory() -> Path:
    local_app_data = os.environ.get(
        "LOCALAPPDATA", str(Path.home() / "AppData" / "Local")
    )
    return Path(local_app_data) / "MILO" / "WhatsAppWebProfile"


def _select_file() -> str:
    root = tkinter.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        return filedialog.askopenfilename(title="Choose a file to send on WhatsApp")
    finally:
        root.destroy()


class WhatsAppWebClient:
    def __init__(self) -> None:
        self._playwright: Playwright | None = None
        self._context: BrowserContext | None = None
        self._page: Page | None = None
        self._lock = asyncio.Lock()
        self._action_lock = asyncio.Lock()

    async def _ready_page(self) -> Page:
        async with self._lock:
            if self._context is None:
                try:
                    self._playwright = await async_playwright().start()
                    profile = _profile_directory()
                    profile.mkdir(parents=True, exist_ok=True)
                    self._context = await self._playwright.chromium.launch_persistent_context(
                        str(profile),
                        channel="msedge",
                        headless=False,
                        args=["--no-first-run"],
                    )
                except (PlaywrightError, OSError) as exc:
                    raise WhatsAppError(
                        f"Could not open WhatsApp Web in Microsoft Edge: {exc}"
                    ) from exc

            if self._page is None or self._page.is_closed():
                pages = self._context.pages
                self._page = pages[0] if pages else await self._context.new_page()
            page = self._page
            page.set_default_timeout(12000)
            if not page.url.startswith(_WHATSAPP_URL):
                try:
                    await page.goto(_WHATSAPP_URL, wait_until="domcontentloaded")
                except PlaywrightError as exc:
                    raise WhatsAppError(f"Could not load WhatsApp Web: {exc}") from exc

            login_prompt = page.get_by_text(
                re.compile(
                    r"use whatsapp on your computer|scan to log in|scan the qr code",
                    re.I,
                )
            )
            try:
                await page.get_by_role(
                    "button", name=re.compile(r"new chat", re.I)
                ).wait_for(timeout=15000)
            except PlaywrightTimeoutError as exc:
                if await login_prompt.count() or await page.locator("canvas").count():
                    raise WhatsAppError(
                        "WhatsApp Web needs a one-time QR sign-in. Scan the code in the "
                        "opened Edge window, then repeat your request."
                    ) from exc
                raise WhatsAppError(
                    "WhatsApp Web did not finish loading its chat controls."
                ) from exc
            return page

    async def _open_contact(self, page: Page, contact: str) -> None:
        new_chat = page.get_by_role("button", name=re.compile(r"new chat", re.I))
        if await new_chat.count() != 1:
            raise WhatsAppError("Could not uniquely find WhatsApp Web's New chat control.")
        await new_chat.click()

        search = page.get_by_role("textbox", name=re.compile(r"search", re.I))
        if await search.count() != 1:
            search = page.locator(_SEARCH_FALLBACK)
        if await search.count() != 1:
            raise WhatsAppError("Could not find WhatsApp Web's contact search field.")
        await search.fill(contact)

        rows = page.get_by_role("listitem")
        matches = []
        for index in range(await rows.count()):
            row = rows.nth(index)
            exact_label = row.get_by_text(contact, exact=True)
            if await row.is_visible() and await exact_label.count():
                matches.append(row)
        if not matches:
            raise WhatsAppError(f"No exact WhatsApp contact named {contact!r} was found.")
        if len(matches) != 1:
            raise WhatsAppError(
                f"More than one WhatsApp result matches {contact!r}; use a more specific name."
            )
        await matches[0].click()

        chat_title = page.locator("header").get_by_text(contact, exact=True)
        try:
            await chat_title.wait_for(timeout=8000)
        except PlaywrightTimeoutError as exc:
            raise WhatsAppError(
                f"Could not verify that WhatsApp opened the chat for {contact!r}."
            ) from exc

    async def send_message(self, contact: str, message: str) -> None:
        async with self._action_lock:
            try:
                page = await self._ready_page()
                await self._open_contact(page, contact)
                composer = page.get_by_role(
                    "textbox", name=re.compile(r"type a message", re.I)
                )
                if await composer.count() != 1:
                    composer = page.locator(_MESSAGE_FALLBACK)
                if await composer.count() != 1:
                    raise WhatsAppError("Could not find WhatsApp Web's message composer.")
                await composer.fill(message)
                await composer.press("Enter")
            except WhatsAppError:
                raise
            except PlaywrightError as exc:
                raise WhatsAppError(
                    f"WhatsApp Web could not submit the message: {exc}"
                ) from exc

    async def send_file(self, contact: str, file_path: str | None = None) -> str:
        async with self._action_lock:
            try:
                page = await self._ready_page()
                await self._open_contact(page, contact)
                if file_path is None:
                    try:
                        path = await asyncio.to_thread(_select_file)
                    except tkinter.TclError as exc:
                        raise WhatsAppError(f"Could not open the file picker: {exc}") from exc
                    if not path:
                        raise WhatsAppError("File selection was cancelled; nothing was sent.")
                else:
                    path = str(Path(file_path).resolve())
                    if not Path(path).is_file():
                        raise WhatsAppError("The uploaded file is no longer available.")

                attach = page.get_by_role("button", name=re.compile(r"attach", re.I))
                if await attach.count() != 1:
                    raise WhatsAppError("Could not find WhatsApp Web's attachment control.")
                await attach.click()
                document = page.get_by_text("Document", exact=True)
                if await document.count() != 1:
                    raise WhatsAppError("Could not find WhatsApp Web's Document option.")
                try:
                    async with page.expect_file_chooser(timeout=10000) as chooser_info:
                        await document.click()
                    chooser = await chooser_info.value
                except PlaywrightTimeoutError as exc:
                    raise WhatsAppError(
                        "WhatsApp Web did not open its document picker."
                    ) from exc
                await chooser.set_files(path)

                send = page.get_by_role("button", name=re.compile(r"^send$", re.I))
                if await send.count() != 1:
                    raise WhatsAppError("The selected file is not ready to send.")
                await send.click()
                return "Submitted the selected file."
            except WhatsAppError:
                raise
            except PlaywrightError as exc:
                raise WhatsAppError(
                    f"WhatsApp Web could not submit the file: {exc}"
                ) from exc

    async def close(self) -> None:
        async with self._action_lock:
            if self._context is not None:
                await self._context.close()
                self._context = None
                self._page = None
            if self._playwright is not None:
                await self._playwright.stop()
                self._playwright = None
