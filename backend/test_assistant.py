from __future__ import annotations

import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException, UploadFile
from sources.app_control import (
    AppControlError,
    AppSpec,
    WindowInfo,
    _APPS,
    _find_executable,
    _resolve_app,
    app_name_was_explicitly_named,
    open_app,
    scan_apps,
)
from sources.assistant import (
    AssistantService,
    _asks_to_open_search_results,
    _direct_app_request,
    _direct_browser_search_query,
    _direct_navigation_destination,
    _direct_whatsapp_request,
    _direct_youtube_query,
    _memory_fact_matches_request,
    _media_action_was_requested,
    _power_action_request,
    _whatsapp_file_intent,
    _whatsapp_message_intent,
    _youtube_play_was_requested,
    infer_user_emotion,
)
from sources.file_uploads import FileStore, FileUploadError, MAX_UPLOAD_BYTES
from sources.memory import MiloMemory


class AppControlTests(unittest.TestCase):
    def test_resolves_fixed_apps_and_rejects_arbitrary_commands(self) -> None:
        self.assertEqual(_resolve_app("VS Code").key, "visual studio code")
        with self.assertRaises(AppControlError):
            _resolve_app("cmd.exe")

    def test_resolves_installed_start_menu_shortcuts_by_exact_name(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            shortcut = root / "Photo Editor.lnk"
            shortcut.touch()
            with patch("sources.app_control._start_menu_roots", return_value=(root,)):
                app = _resolve_app("Photo Editor")
                self.assertEqual(app.shortcut, shortcut)
                self.assertTrue(app_name_was_explicitly_named(
                    "Milo, open Photo Editor", "Photo Editor"
                ))
                self.assertFalse(app_name_was_explicitly_named(
                    "Milo, open the editor", "Photo Editor"
                ))

    def test_opens_a_discovered_shortcut_without_running_it_in_tests(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            shortcut = root / "Photo Editor.lnk"
            shortcut.touch()
            with patch("sources.app_control._start_menu_roots", return_value=(root,)), \
                    patch("sources.app_control.os.startfile") as startfile:
                message = open_app("Photo Editor")

        self.assertEqual(message, "Opened Photo Editor.")
        startfile.assert_called_once_with(str(shortcut))

    def test_opens_a_registered_windows_app_using_its_app_id(self) -> None:
        with patch("sources.app_control.os.name", "nt"), \
                patch("sources.app_control._start_menu_roots", return_value=()), \
                patch(
                    "sources.app_control._registered_start_apps",
                    return_value=[("WhatsApp", "Vendor.WhatsApp!App")],
                ), \
                patch("sources.app_control.os.startfile") as startfile:
            message = open_app("WhatsApp")

        self.assertEqual(message, "Opened WhatsApp.")
        startfile.assert_called_once_with("shell:AppsFolder\\Vendor.WhatsApp!App")

    def test_scans_installed_apps_and_marks_visible_windows(self) -> None:
        app = AppSpec("photo editor", "Photo Editor", "", frozenset())
        with patch("sources.app_control._discover_installed_apps", return_value=[app]), \
                patch("sources.app_control._visible_windows", return_value=[
                    WindowInfo(10, "Photo Editor - Project", "photoeditor.exe")
                ]), \
                patch("sources.app_control._find_executable", return_value=None):
            entry = next(app for app in scan_apps() if app["name"] == "Photo Editor")

        self.assertTrue(entry["installed"])
        self.assertTrue(entry["running"])
        self.assertEqual(entry["windows"], 1)

    def test_installed_app_scans_pick_up_additions_and_removals(self) -> None:
        first = AppSpec("photo editor", "Photo Editor", "", frozenset())
        second = AppSpec("paint", "Paint", "", frozenset())
        with patch(
            "sources.app_control._discover_installed_apps",
            side_effect=[[first], [second]],
        ), patch("sources.app_control._visible_windows", return_value=[]), \
                patch("sources.app_control._find_executable", return_value=None):
            initial = scan_apps()
            refreshed = scan_apps()

        initial_names = {str(app["name"]) for app in initial}
        refreshed_names = {str(app["name"]) for app in refreshed}
        self.assertIn("Photo Editor", initial_names)
        self.assertNotIn("Paint", initial_names)
        self.assertIn("Paint", refreshed_names)
        self.assertNotIn("Photo Editor", refreshed_names)

    def test_resolves_a_fixed_system_app_without_launching_it(self) -> None:
        executable = _find_executable(_APPS["notepad"])
        self.assertIsNotNone(executable)
        self.assertEqual(Path(executable).name.casefold(), "notepad.exe")


class FileUploadTests(unittest.IsolatedAsyncioTestCase):
    def test_streamed_upload_enforces_two_gigabyte_limit_without_partial_files(self) -> None:
        self.assertEqual(MAX_UPLOAD_BYTES, 2 * 1024 * 1024 * 1024)
        with tempfile.TemporaryDirectory() as temporary_directory:
            store = FileStore(Path(temporary_directory))
            with patch("sources.file_uploads.MAX_UPLOAD_BYTES", 10), \
                    patch("sources.file_uploads.UPLOAD_CHUNK_BYTES", 3):
                accepted = store.save_stream(
                    "maximum.txt", "text/plain", BytesIO(b"0123456789")
                )
                self.assertEqual(accepted.size, 10)
                self.assertEqual(accepted.path.read_bytes(), b"0123456789")
                with self.assertRaises(FileUploadError):
                    store.save_stream(
                        "too-large.txt", "text/plain", BytesIO(b"01234567890")
                    )
            self.assertEqual(len(list(Path(temporary_directory).iterdir())), 1)

    def test_large_text_extraction_stays_within_context_limit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            store = FileStore(Path(temporary_directory))
            uploaded = store.save("large.txt", "text/plain", b"x" * 100)
            with patch("sources.file_uploads.MAX_EXTRACTED_CHARACTERS", 20):
                result = store.extract(uploaded.id)

        self.assertEqual(result["text"], "x" * 20)

    def test_large_binary_files_can_upload_but_analysis_is_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            store = FileStore(Path(temporary_directory))
            uploaded = store.save("large.pdf", "application/pdf", b"x" * 10)
            with patch("sources.file_uploads.MAX_ANALYSIS_FILE_BYTES", 5):
                with self.assertRaisesRegex(FileUploadError, "analysis is limited to 100 MB"):
                    store.extract(uploaded.id)

    async def test_upload_route_returns_a_reference_for_local_file_storage(self) -> None:
        import main

        original_store = main.file_store
        with tempfile.TemporaryDirectory() as temporary_directory:
            store = FileStore(Path(temporary_directory))
            main.file_store = store
            try:
                result = await main.upload_file(
                    UploadFile(filename="notes.txt", file=BytesIO(b"local notes"))
                )
                uploaded = store.get(result["id"])
                contents = uploaded.path.read_bytes()
            finally:
                main.file_store = original_store

        self.assertEqual(result["name"], "notes.txt")
        self.assertEqual(contents, b"local notes")

    async def test_installed_apps_route_returns_the_current_scan(self) -> None:
        import main

        inventory = [{
            "name": "Calculator", "installed": True, "running": False, "windows": 0
        }]
        with patch("main.app_control.scan_apps", return_value=inventory) as scan:
            result = await main.installed_apps()

        self.assertEqual(result["apps"], inventory)
        scan.assert_called_once_with()

    async def test_upload_route_returns_413_when_stream_exceeds_limit(self) -> None:
        import main

        original_store = main.file_store
        with tempfile.TemporaryDirectory() as temporary_directory:
            main.file_store = FileStore(Path(temporary_directory))
            try:
                with patch("sources.file_uploads.MAX_UPLOAD_BYTES", 10):
                    with self.assertRaises(HTTPException) as raised:
                        await main.upload_file(
                            UploadFile(filename="large.bin", file=BytesIO(b"x" * 11))
                        )
            finally:
                main.file_store = original_store

        self.assertEqual(raised.exception.status_code, 413)


class FishAudioTests(unittest.IsolatedAsyncioTestCase):
    async def test_tts_endpoint_returns_mp3_bytes(self) -> None:
        import main

        with patch("main.synthesize", return_value=b"test audio"):
            response = await main.text_to_speech(main.SpeechRequest(text="Hello"))

        self.assertEqual(response.media_type, "audio/mpeg")
        self.assertEqual(response.body, b"test audio")

    async def test_tts_endpoint_reports_missing_api_key(self) -> None:
        import main

        with patch.dict("os.environ", {"FISH_API_KEY": ""}), \
                self.assertRaises(HTTPException) as raised:
            await main.text_to_speech(main.SpeechRequest(text="Hello"))

        self.assertEqual(raised.exception.status_code, 503)
        self.assertIn("Set FISH_API_KEY", raised.exception.detail)

    async def test_realtime_voice_reports_missing_mic_dependencies(self) -> None:
        import main

        websocket = AsyncMock()
        websocket.headers = {
            "origin": "http://127.0.0.1:5173", "host": "127.0.0.1:8765"
        }
        websocket.client = type("Client", (), {"host": "127.0.0.1"})()
        with patch("main.importlib.import_module", side_effect=ImportError("missing audio package")):
            await main.realtime_voice(websocket)

        websocket.accept.assert_awaited_once()
        websocket.send_json.assert_awaited_once()
        self.assertIn("PyAudioWPatch", websocket.send_json.await_args.args[0]["message"])
        websocket.close.assert_awaited_once_with(code=1011)

    async def test_realtime_voice_hands_unentered_source_to_background_listener(self) -> None:
        import main

        class FakeMicrophone:
            entered = False

            def __enter__(self):
                if self.entered:
                    raise AssertionError("audio source was entered more than once")
                self.entered = True
                return self

            def __exit__(self, *_args) -> None:
                self.entered = False

        microphone = FakeMicrophone()
        recognizer = MagicMock()

        def calibrate(source, duration):
            self.assertIs(source, microphone)
            self.assertTrue(source.entered)
            self.assertEqual(duration, 0.6)

        def start_listener(source, _callback, phrase_time_limit):
            self.assertIs(source, microphone)
            self.assertFalse(source.entered)
            self.assertEqual(phrase_time_limit, 6)
            return MagicMock()

        recognizer.adjust_for_ambient_noise.side_effect = calibrate
        recognizer.listen_in_background.side_effect = start_listener
        speech_recognition = MagicMock(
            Recognizer=MagicMock(return_value=recognizer),
            Microphone=MagicMock(return_value=microphone),
            UnknownValueError=type("UnknownValueError", (Exception,), {}),
            RequestError=type("RequestError", (Exception,), {}),
        )
        websocket = AsyncMock()
        websocket.headers = {
            "origin": "http://127.0.0.1:5173", "host": "127.0.0.1:8765"
        }
        websocket.client = type("Client", (), {"host": "127.0.0.1"})()
        websocket.receive_text.side_effect = [
            '{"action":"start","language":"en-IN"}',
            '{"action":"stop"}',
        ]

        with patch(
            "main.importlib.import_module",
            side_effect=lambda name: (
                object() if name == "pyaudiowpatch" else speech_recognition
            ),
        ):
            await main.realtime_voice(websocket)

        self.assertTrue(recognizer.listen_in_background.called)
        self.assertTrue(any(
            call.args[0] == {"type": "ready", "engine": "pyaudio-google"}
            for call in websocket.send_json.await_args_list
        ))

    async def test_tts_uses_configured_voice_and_model(self) -> None:
        from sources.fish_audio import DEFAULT_REFERENCE_ID, synthesize

        response = MagicMock()
        response.__enter__.return_value = response
        response.headers = {"Content-Type": "audio/mpeg"}
        response.read.return_value = b"mp3 data"
        with patch.dict("os.environ", {"FISH_API_KEY": "test-key"}, clear=False), \
                patch("sources.fish_audio.urlopen", return_value=response) as urlopen:
            audio = synthesize("Hello MILO")

        request = urlopen.call_args.args[0]
        self.assertEqual(audio, b"mp3 data")
        self.assertEqual(request.get_header("Authorization"), "Bearer test-key")
        self.assertEqual(request.get_header("Model"), "s2.1-pro-free")
        self.assertEqual(request.data.decode(), (
            '{"text": "Hello MILO", "reference_id": '
            f'"{DEFAULT_REFERENCE_ID}", "format": "mp3", "latency": "balanced"}}'
        ))


class AssistantToolTests(unittest.IsolatedAsyncioTestCase):
    async def test_open_directions_request_uses_maps_not_open_app(self) -> None:
        websocket = AsyncMock()
        service = AssistantService(AsyncMock())
        service.ollama.chat = AsyncMock()
        url = (
            "https://www.google.com/maps/dir/?api=1&destination="
            "India+Gate%2C+New+Delhi&travelmode=driving"
        )
        with patch("sources.assistant.webbrowser.open", return_value=True) as open_browser:
            await service._respond(
                websocket, "navigate-1",
                "Please open live directions to India Gate, New Delhi in Google Maps.", [],
            )

        open_browser.assert_called_once_with(url, new=2)
        service.ollama.chat.assert_not_awaited()
        self.assertTrue(any(
            "Opened Google Maps directions to India Gate, New Delhi." in call.args[0]
            for call in websocket.send_text.await_args_list
        ))

    async def test_reminder_tool_failure_cannot_be_answered_as_success(self) -> None:
        websocket = AsyncMock()
        emit = AsyncMock()
        service = AssistantService(emit, reminder_setter=AsyncMock(
            side_effect=ValueError("That time has passed. Choose a future time.")
        ))
        service.ollama.chat = AsyncMock(side_effect=[
            {"message": {"role": "assistant", "tool_calls": [{
                "function": {"name": "set_reminder", "arguments": {
                    "title": "call Alex", "due_at": "2026-11-20T10:00:00+00:00"
                }}
            }] }},
            {"message": {"role": "assistant", "content": "Done, I set that reminder."}},
        ])

        await service._respond(
            websocket, "reminder-1", "Remind me to call Alex tomorrow at 10 AM", []
        )

        chat_frames = [call.args[0] for call in websocket.send_text.await_args_list]
        self.assertTrue(any("time has passed" in frame for frame in chat_frames))
        self.assertFalse(any("Done, I set that reminder" in frame for frame in chat_frames))
        self.assertFalse(any(call.args[0].get("state") == "SUCCESS" for call in emit.await_args_list))

    async def test_reminder_success_reply_comes_from_saved_reminder(self) -> None:
        websocket = AsyncMock()
        due_at = "2026-11-21T10:00:00+00:00"
        service = AssistantService(AsyncMock(), reminder_setter=AsyncMock(return_value={
            "id": "saved-id", "title": "call Alex", "dueAt": due_at,
        }))
        service.ollama.chat = AsyncMock(return_value={"message": {
            "role": "assistant", "tool_calls": [{"function": {
                "name": "set_reminder", "arguments": {
                    "title": "call Alex", "due_at": due_at,
                },
            }}],
        }})

        await service._respond(
            websocket, "reminder-2", "Remind me to call Alex tomorrow at 10 AM", []
        )

        chat_frames = [call.args[0] for call in websocket.send_text.await_args_list]
        self.assertTrue(any("remind you about call Alex" in frame for frame in chat_frames))
        self.assertEqual(service.ollama.chat.await_count, 1)

    async def test_explicit_app_command_executes_without_waiting_for_ollama(self) -> None:
        websocket = AsyncMock()
        emit = AsyncMock()
        service = AssistantService(emit)
        service.ollama.chat = AsyncMock()
        with patch(
            "sources.assistant.app_control.open_app", return_value="Opened Notepad."
        ) as open_app:
            await service._respond(websocket, "request-1", "MILO, open Notepad", [])

        open_app.assert_called_once_with("Notepad")
        service.ollama.chat.assert_not_awaited()
        self.assertTrue(any(
            '"content": "Opened Notepad."' in call.args[0]
            for call in websocket.send_text.await_args_list
        ))

    async def test_explicit_whatsapp_message_executes_without_waiting_for_ollama(self) -> None:
        websocket = AsyncMock()
        emit = AsyncMock()
        service = AssistantService(emit)
        service.ollama.chat = AsyncMock()
        service.whatsapp.send_message = AsyncMock()

        await service._respond(
            websocket,
            "request-2",
            "MILO, send a WhatsApp message to Alex: Running late",
            [],
        )

        service.whatsapp.send_message.assert_awaited_once_with("Alex", "Running late")
        service.ollama.chat.assert_not_awaited()
        self.assertTrue(any(
            '"content": "Submitted the WhatsApp message to Alex."' in call.args[0]
            for call in websocket.send_text.await_args_list
        ))

    async def test_explicit_whatsapp_file_request_opens_file_picker_path(self) -> None:
        websocket = AsyncMock()
        emit = AsyncMock()
        service = AssistantService(emit)
        service.ollama.chat = AsyncMock()
        service.whatsapp.send_file = AsyncMock(return_value="Submitted the selected file.")

        await service._respond(
            websocket, "request-3", "send file to Alex", []
        )

        service.whatsapp.send_file.assert_awaited_once_with("Alex")
        service.ollama.chat.assert_not_awaited()

    async def test_whatsapp_message_prompts_for_recipient_then_message(self) -> None:
        websocket = AsyncMock()
        service = AssistantService(AsyncMock())
        service.whatsapp.send_message = AsyncMock()

        await service._respond(websocket, "request-4", "send a WhatsApp message", [])
        self.assertIn(websocket, service._pending_whatsapp)
        await service._respond(websocket, "request-5", "Alex", [])
        await service._respond(websocket, "request-6", "Running late", [])

        service.whatsapp.send_message.assert_awaited_once_with("Alex", "Running late")
        self.assertNotIn(websocket, service._pending_whatsapp)

    async def test_whatsapp_keeps_message_while_prompting_for_missing_recipient(self) -> None:
        websocket = AsyncMock()
        service = AssistantService(AsyncMock())
        service.whatsapp.send_message = AsyncMock()

        await service._respond(
            websocket, "request-13", "send a WhatsApp message: Running late", []
        )
        await service._respond(websocket, "request-14", "Alex", [])

        service.whatsapp.send_message.assert_awaited_once_with("Alex", "Running late")

    async def test_uploaded_text_is_included_as_untrusted_local_context(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            store = FileStore(Path(temporary_directory))
            uploaded = store.save("notes.txt", "text/plain", b"Project notes")
            service = AssistantService(AsyncMock(), file_store=store)
            service.ollama.chat = AsyncMock(return_value={
                "message": {"content": "The notes describe a project."}
            })

            await service._respond(
                AsyncMock(), "request-7", "Summarize this file", [], uploaded.id
            )

        prompt = service.ollama.chat.await_args.args[0][-1]["content"]
        self.assertIn("Project notes", prompt)
        self.assertIn("untrusted data", prompt)

    async def test_uploaded_file_is_sent_only_for_explicit_whatsapp_request(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            store = FileStore(Path(temporary_directory))
            uploaded = store.save("notes.txt", "text/plain", b"Project notes")
            service = AssistantService(AsyncMock(), file_store=store)
            service.whatsapp.send_file = AsyncMock(return_value="sent")

            await service._respond(
                AsyncMock(), "request-8", "send file to Alex", [], uploaded.id
            )

        service.whatsapp.send_file.assert_awaited_once_with("Alex", str(uploaded.path))

    async def test_restart_requires_confirmation_and_sleep_stays_disabled(self) -> None:
        websocket = AsyncMock()
        service = AssistantService(AsyncMock())
        with patch("sources.assistant.system_control.schedule_power_action") as schedule:
            await service._respond(websocket, "request-9", "restart my computer", [])
            schedule.assert_not_called()
            await service._respond(websocket, "request-10", "yes", [])
            schedule.assert_called_once_with("restart")

        with patch("sources.assistant.system_control.cancel_scheduled_power_action") as cancel:
            await service._respond(websocket, "request-12", "cancel restart", [])
            cancel.assert_called_once_with()
        self.assertIsNone(service._scheduled_power_action)

        with patch("sources.assistant.system_control.schedule_power_action") as schedule:
            await service._respond(websocket, "request-11", "put my computer to sleep", [])
            schedule.assert_not_called()

    async def test_system_control_requires_explicit_wifi_request(self) -> None:
        service = AssistantService(AsyncMock())
        with patch("sources.assistant.system_control.set_network_adapter", return_value="Wi-Fi") as set_adapter:
            denied = await service._execute_tool(
                "system_control", {"action": "wifi_disable"}, "What is Wi-Fi?"
            )
            negated = await service._execute_tool(
                "system_control", {"action": "wifi_disable"}, "Do not turn off Wi-Fi"
            )
            question = await service._execute_tool(
                "system_control", {"action": "wifi_disable"}, "How can I turn off Wi-Fi?"
            )
            accepted = await service._execute_tool(
                "system_control", {"action": "wifi_disable"}, "Turn off Wi-Fi"
            )

        self.assertIn("did not clearly request", denied["error"])
        self.assertIn("did not clearly request", negated["error"])
        self.assertIn("did not clearly request", question["error"])
        self.assertEqual(accepted["status"], "completed")
        set_adapter.assert_called_once_with("wifi", False)

    async def test_brightness_queries_cannot_be_mistaken_for_changes(self) -> None:
        service = AssistantService(AsyncMock())
        with patch("sources.assistant.system_control.set_brightness", return_value=50) as set_brightness:
            denied = await service._execute_tool(
                "system_control", {"action": "set_brightness", "value": 50},
                "What is my brightness?",
            )
            accepted = await service._execute_tool(
                "system_control", {"action": "set_brightness", "value": 50},
                "Set brightness to 50",
            )

        self.assertIn("did not clearly request", denied["error"])
        self.assertEqual(accepted["status"], "completed")
        set_brightness.assert_called_once_with(50)

    async def test_list_apps_returns_the_scanned_inventory(self) -> None:
        service = AssistantService(AsyncMock())
        inventory = [{
            "name": "Photo Editor", "installed": True, "running": True, "windows": 1
        }]
        with patch("sources.assistant.app_control.scan_apps", return_value=inventory):
            result = await service._execute_tool("list_apps", {})

        self.assertEqual(result["apps"], inventory)

    async def test_close_app_runs_gracefully_for_an_explicit_named_request(self) -> None:
        service = AssistantService(AsyncMock())
        with patch("sources.assistant.app_control.close_app", return_value=("Notepad", 1)) as close_app:
            result = await service._execute_tool(
                "close_app", {"app": "Notepad"}, "Please close Notepad"
            )

        self.assertEqual(result["status"], "close_requested")
        close_app.assert_called_once_with("Notepad")

    async def test_close_app_requires_an_exact_app_name_in_the_request(self) -> None:
        service = AssistantService(AsyncMock())
        with patch("sources.assistant.app_control.close_app") as close_app:
            result = await service._execute_tool(
                "close_app", {"app": "Notepad"}, "Close it"
            )

        self.assertIn("exact app", result["error"])
        close_app.assert_not_called()

    async def test_ollama_tool_reply_uses_tool_name(self) -> None:
        service = AssistantService(AsyncMock())
        service.ollama.chat = AsyncMock(side_effect=[
            {
                "message": {
                    "role": "assistant",
                    "tool_calls": [{
                        "function": {
                            "name": "search_web",
                            "arguments": {"query": "local weather"},
                        }
                    }],
                }
            },
            {"message": {"role": "assistant", "content": "Here is the summary."}},
        ])
        with patch("sources.assistant.search_duckduckgo", return_value=[{
            "title": "Weather", "url": "https://example.com", "snippet": "Current forecast."
        }]):
            messages = [{"role": "user", "content": "Search the weather"}]
            answer = await service._tool_loop("Search the weather", messages)

        self.assertEqual(answer, "Here is the summary.")
        tool_reply = next(message for message in messages if message["role"] == "tool")
        self.assertEqual(tool_reply["tool_name"], "search_web")

    async def test_opens_browser_results_only_when_requested(self) -> None:
        service = AssistantService(AsyncMock())
        with patch("sources.assistant.search_duckduckgo", return_value=[]), \
                patch("sources.assistant.open_search_results") as open_results:
            await service._execute_tool(
                "search_web",
                {"query": "local weather"},
                "Search local weather and show results",
                open_results_requested=True,
            )

        open_results.assert_called_once_with("local weather")

    async def test_opens_brave_results_for_a_direct_search_command(self) -> None:
        service = AssistantService(AsyncMock())
        with patch("sources.assistant.open_search_results") as open_results:
            result = await service._execute_tool(
                "open_browser_search",
                {"query": "latest AI news"},
                "Search for latest AI news",
            )

        self.assertEqual(result, {"status": "opened", "query": "latest AI news"})
        open_results.assert_called_once_with("latest AI news")

    async def test_memory_is_saved_only_for_explicit_requests(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            service = AssistantService(
                AsyncMock(), memory=MiloMemory(Path(temporary_directory) / "memory.sqlite3")
            )
            result = await service._execute_tool(
                "remember_memory", {"fact": "I like chai"},
                "MILO, remember that I like chai",
            )
            denied = await service._execute_tool(
                "remember_memory", {"fact": "I like coffee"},
                "I like coffee",
            )
            hindi = await service._execute_tool(
                "remember_memory", {"fact": "मुझे चाय पसंद है"},
                "याद रखना कि मुझे चाय पसंद है",
            )

        self.assertEqual(result["status"], "saved")
        self.assertIn("explicitly say", denied["error"])
        self.assertEqual(hindi["status"], "saved")

    async def test_memory_rejects_sensitive_data_and_forgets_only_on_request(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            memory = MiloMemory(Path(temporary_directory) / "memory.sqlite3")
            service = AssistantService(AsyncMock(), memory=memory)
            saved = await service._execute_tool(
                "remember_memory", {"fact": "My favorite song is Shape of You"},
                "Remember my favorite song is Shape of You",
            )
            sensitive = await service._execute_tool(
                "remember_memory", {"fact": "My password is abc123"},
                "Remember my password is abc123",
            )
            denied = await service._execute_tool(
                "forget_memory", {"query": "Shape of You"}, "I like Shape of You"
            )
            forgotten = await service._execute_tool(
                "forget_memory", {"query": "Shape of You"}, "Forget my favorite song"
            )

        self.assertEqual(saved["status"], "saved")
        self.assertIn("can't save", sensitive["error"])
        self.assertIn("explicitly ask", denied["error"])
        self.assertTrue(forgotten["deleted"])
        self.assertEqual(memory.recall(), [])

    async def test_media_control_requires_an_explicit_command(self) -> None:
        media_command = AsyncMock(return_value=True)
        service = AssistantService(AsyncMock(), media_command=media_command)
        result = await service._execute_tool(
            "media_control", {"action": "next"}, "Please play the next track"
        )
        denied = await service._execute_tool(
            "media_control", {"action": "pause"}, "I enjoy music"
        )

        self.assertEqual(result["status"], "sent")
        self.assertEqual(media_command.call_args.args[0], {"action": "next"})
        self.assertIn("did not clearly ask", denied["error"])
        self.assertEqual(media_command.call_count, 1)

    async def test_youtube_tool_opens_best_video_for_explicit_song_request(self) -> None:
        service = AssistantService(AsyncMock())
        video = {
            "title": "Official video",
            "url": "https://www.youtube.com/watch?v=abcdefghijk&autoplay=1",
        }
        with patch("sources.assistant.open_youtube_video", return_value=video) as open_video:
            result = await service._execute_tool(
                "play_youtube",
                {"query": "Shape of You by Ed Sheeran"},
                "Play Shape of You on YouTube",
            )

        self.assertEqual(result["status"], "opened")
        open_video.assert_called_once_with("Shape of You by Ed Sheeran")


class AssistantIntentTests(unittest.TestCase):
    def test_detects_conversational_tone_conservatively(self) -> None:
        self.assertEqual(infer_user_emotion("I am frustrated"), "frustrated")
        self.assertEqual(infer_user_emotion("I am not happy today"), "sad")
        self.assertEqual(infer_user_emotion("I am not angry"), "calm")
        self.assertEqual(infer_user_emotion("Nothing works"), "frustrated")
        self.assertEqual(infer_user_emotion("मैं दुखी हूँ"), "sad")
        self.assertEqual(infer_user_emotion("मैं खुश हूँ"), "joyful")
        self.assertEqual(infer_user_emotion("Please open Notepad"), "calm")

    def test_detects_explicit_request_to_open_search_results(self) -> None:
        self.assertTrue(_asks_to_open_search_results("Search climate and show results"))
        self.assertTrue(_asks_to_open_search_results("search result dikhao"))
        self.assertTrue(_asks_to_open_search_results("Research climate change and open it in browser"))
        self.assertTrue(_asks_to_open_search_results("browser me khol do"))
        self.assertFalse(_asks_to_open_search_results("What is the weather?"))

    def test_understands_direct_browser_search_commands(self) -> None:
        self.assertEqual(_direct_browser_search_query("Search for latest AI news"), "latest AI news")
        self.assertEqual(_direct_browser_search_query("Brave par Taylor Swift songs search karo"), "Taylor Swift songs")
        self.assertEqual(_direct_browser_search_query("MILO, google best laptops under 50000"), "best laptops under 50000")
        self.assertIsNone(_direct_browser_search_query("Search results open nahi kar raha Brave par"))

    def test_extracts_navigation_destinations_from_english_and_hinglish(self) -> None:
        self.assertEqual(
            _direct_navigation_destination(
                "Please open live directions to India Gate, New Delhi in Google Maps."
            ),
            "India Gate, New Delhi",
        )
        self.assertEqual(
            _direct_navigation_destination("Google Maps pe India Gate ka rasta kholo"),
            "India Gate",
        )
        self.assertIsNone(_direct_navigation_destination("What are the directions on Google Maps?"))

    def test_requires_explicit_memory_media_and_youtube_intents(self) -> None:
        self.assertTrue(_memory_fact_matches_request(
            "Remember that I like chai", "I like chai"
        ))
        self.assertFalse(_memory_fact_matches_request("I like chai", "I like chai"))
        self.assertTrue(_media_action_was_requested("Next track", "next"))
        self.assertTrue(_media_action_was_requested("अगला गाना चलाओ", "next"))
        self.assertFalse(_media_action_was_requested("I like music", "pause"))
        self.assertTrue(_youtube_play_was_requested("Play Shape of You on YouTube"))
        self.assertTrue(_youtube_play_was_requested("Shape of You यूट्यूब पर चलाओ"))
        self.assertFalse(_youtube_play_was_requested("Show me Shape of You lyrics"))
        self.assertFalse(_youtube_play_was_requested("Play the next track"))
        self.assertEqual(_power_action_request("restart my computer"), "restart")
        self.assertIsNone(_power_action_request("Should I restart my computer?"))
        self.assertEqual(_power_action_request("put my computer to sleep"), "sleep")
        self.assertIsNone(_power_action_request("I need some sleep"))
        self.assertFalse(_whatsapp_message_intent("Don't send a WhatsApp message"))
        self.assertFalse(_whatsapp_file_intent("Don't send this file", True))

    def test_extracts_direct_app_and_youtube_commands(self) -> None:
        self.assertEqual(
            _direct_app_request("MILO, please open Notepad"),
            ("open_app", "Notepad"),
        )
        self.assertEqual(
            _direct_app_request("close Chrome please"),
            ("close_app", "Chrome"),
        )
        self.assertEqual(
            _direct_app_request("MILO, WhatsApp kholo"),
            ("open_app", "WhatsApp"),
        )
        self.assertEqual(
            _direct_app_request("Chrome band karo"),
            ("close_app", "Chrome"),
        )
        self.assertEqual(
            _direct_youtube_query("Play Shape of You on YouTube"),
            "Shape of You",
        )
        self.assertEqual(
            _direct_youtube_query("YouTube par Arijit Singh ka song chalao"),
            "Arijit Singh ka song",
        )
        self.assertEqual(
            _direct_youtube_query("Arijit ka gaana YouTube par chalao"),
            "Arijit ka gaana",
        )
        self.assertEqual(
            _direct_youtube_query("Shape of You यूट्यूब पर चलाओ"),
            "Shape of You",
        )
        self.assertIsNone(_direct_youtube_query("play some music"))
        self.assertEqual(
            _direct_whatsapp_request(
                "MILO send a WhatsApp message to Alex: Running late."
            ),
            ("message", "Alex", "Running late."),
        )
        self.assertEqual(
            _direct_whatsapp_request("send file to Alex"),
            ("file", "Alex", ""),
        )


if __name__ == "__main__":
    unittest.main()
