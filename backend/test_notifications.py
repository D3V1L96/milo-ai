from __future__ import annotations

import json
import unittest
from unittest.mock import AsyncMock, patch

from main import (
    Hub, _host_is_allowed, _open_notification_app, _origin_is_allowed,
    _peer_is_loopback, enforce_browser_origin, handle_command,
)
from sources.app_control import AppControlError


class FakeWebSocket:
    def __init__(self) -> None:
        self.frames: list[str] = []

    async def accept(self) -> None:
        pass

    async def send_text(self, frame: str) -> None:
        self.frames.append(frame)


class NotificationRoutingTests(unittest.IsolatedAsyncioTestCase):
    def test_browser_origins_must_match_the_configured_origin_exactly(self) -> None:
        self.assertTrue(_origin_is_allowed("http://127.0.0.1:5173"))
        self.assertFalse(_origin_is_allowed("http://127.0.0.1.evil.example:5173"))
        self.assertFalse(_origin_is_allowed("null"))
        self.assertFalse(_origin_is_allowed(None))

    def test_backend_accepts_only_loopback_clients_and_local_hosts(self) -> None:
        from types import SimpleNamespace

        self.assertTrue(_peer_is_loopback(SimpleNamespace(host="127.0.0.1")))
        self.assertTrue(_peer_is_loopback(SimpleNamespace(host="::1")))
        self.assertFalse(_peer_is_loopback(SimpleNamespace(host="192.0.2.10")))
        self.assertTrue(_host_is_allowed("127.0.0.1:8765"))
        self.assertFalse(_host_is_allowed("attacker.example:8765"))

    async def test_upload_route_rejects_missing_or_untrusted_browser_origins(self) -> None:
        from starlette.requests import Request

        async def downstream(_request):
            self.fail("Untrusted request reached the endpoint")

        for origin in (None, "https://attacker.example"):
            headers = [] if origin is None else [(b"origin", origin.encode())]
            request = Request({
                "type": "http", "method": "POST", "path": "/files",
                "headers": [(b"host", b"127.0.0.1:8765"), *headers],
                "query_string": b"", "server": ("127.0.0.1", 8765),
                "client": ("127.0.0.1", 50000), "scheme": "http", "http_version": "1.1",
            })
            response = await enforce_browser_origin(request, downstream)
            self.assertEqual(response.status_code, 403)

    async def test_upload_route_rejects_non_loopback_clients_even_with_allowed_headers(self) -> None:
        from starlette.requests import Request

        request = Request({
            "type": "http", "method": "POST", "path": "/files",
            "headers": [
                (b"host", b"127.0.0.1:8765"),
                (b"origin", b"http://127.0.0.1:5173"),
            ],
            "query_string": b"", "server": ("192.0.2.10", 8765),
            "client": ("192.0.2.20", 50000), "scheme": "http", "http_version": "1.1",
        })

        async def downstream(_request):
            self.fail("Remote client reached the endpoint")

        response = await enforce_browser_origin(request, downstream)
        self.assertEqual(response.status_code, 403)

    async def test_websocket_origin_is_checked_before_accepting_commands(self) -> None:
        import main

        websocket = AsyncMock()
        websocket.headers = {
            "origin": "https://attacker.example", "host": "127.0.0.1:8765"
        }
        websocket.client = type("Client", (), {"host": "127.0.0.1"})()
        await main.ws_endpoint(websocket)

        websocket.accept.assert_not_awaited()
        websocket.close.assert_awaited_once_with(code=1008)

    async def test_cancel_chat_cancels_the_active_assistant_request(self) -> None:
        websocket = FakeWebSocket()
        with patch("main.assistant.cancel_for", new_callable=AsyncMock) as cancel:
            await handle_command({"action": "cancel_chat"}, websocket)  # type: ignore[arg-type]

        cancel.assert_awaited_once_with(websocket)

    async def test_dismissed_notification_is_not_replayed_to_new_clients(self) -> None:
        hub = Hub()
        await hub.send({"notification": {"id": "keep-me"}})
        await hub.send({"notification": {"id": "remove-me"}})
        hub.remove_notification("remove-me")
        websocket = FakeWebSocket()

        await hub.join(websocket)  # type: ignore[arg-type]

        frames = [json.loads(frame) for frame in websocket.frames]
        self.assertIn({"notification": {"id": "keep-me"}}, frames)
        self.assertNotIn({"notification": {"id": "remove-me"}}, frames)

    async def test_clear_notifications_purges_only_notification_frames(self) -> None:
        hub = Hub()
        await hub.send({"notification": {"id": "remove-me"}})
        await hub.send({"notificationStatus": {"available": True}})
        hub.clear_notifications()
        websocket = FakeWebSocket()

        await hub.join(websocket)  # type: ignore[arg-type]

        frames = [json.loads(frame) for frame in websocket.frames]
        self.assertNotIn({"notification": {"id": "remove-me"}}, frames)
        self.assertIn({"notificationStatus": {"available": True}}, frames)

    async def test_hub_replays_notification_listener_status_to_new_clients(self) -> None:
        hub = Hub()
        await hub.send({
            "notificationStatus": {"available": False, "error": "notification access denied"}
        })
        websocket = FakeWebSocket()

        await hub.join(websocket)  # type: ignore[arg-type]

        frames = [json.loads(frame) for frame in websocket.frames]
        self.assertIn({
            "notificationStatus": {
                "available": False, "error": "notification access denied"
            }
        }, frames)

    async def test_notification_aumid_is_opened_as_a_windows_app_folder_target(self) -> None:
        with patch("main.os.name", "nt"), patch("main.os.startfile") as startfile:
            result = _open_notification_app("WhatsApp", "WhatsApp_123!App")

        self.assertEqual(result, "Opened WhatsApp.")
        startfile.assert_called_once_with("shell:AppsFolder\\WhatsApp_123!App")

    async def test_invalid_aumid_cannot_be_used_as_a_shell_target(self) -> None:
        with patch("main.os.name", "nt"), \
                patch("main.os.startfile") as startfile, \
                patch("main.app_control.open_app") as fallback:
            with self.assertRaises(AppControlError):
                _open_notification_app("System", "https://example.com")

        startfile.assert_not_called()
        fallback.assert_not_called()


if __name__ == "__main__":
    unittest.main()
