# MILO for Windows

MILO is a Windows desktop companion. Its UI runs in a Tauri window, and a bundled local API handles chat, voice, reminders, notifications and Windows controls. The API is intended to stay on this PC at `127.0.0.1:8765`.

## Build a Windows installer

The installer build needs Node.js/npm, Python 3.14, Rust with the MSVC toolchain, and the Visual Studio C++ Build Tools with a Windows SDK. Tauri also needs WebView2. Its normal installer mode downloads the WebView2 bootstrapper when the runtime is missing.

From the repository root in PowerShell:

```powershell
npm install
py -3.14 -m venv backend\.venv
backend\.venv\Scripts\python.exe -m pip install --upgrade pip
backend\.venv\Scripts\python.exe -m pip install -r backend\build-requirements.txt
npm run tauri:build
```

The NSIS installer is written under `src-tauri\target\release\bundle\nsis`. Give that installer to Windows users; they do not need Node, Rust or Python installed. MILO does not include Ollama or an LLM model, so AI chat needs Ollama and a supported model installed separately. Fish Audio voice synthesis is optional and needs a user-provided `FISH_API_KEY`; microphone recognition uses the bundled speech-recognition dependencies and Google's online speech service.

## Run from source

Set up the backend environment first:

```powershell
py -3.14 -m venv backend\.venv
backend\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
```

Then use two terminals:

```powershell
cd backend
.\.venv\Scripts\python.exe run.py
```

```powershell
npm run dev
```

For the desktop window in development, use `npm run tauri:dev`; this starts the frontend and the local backend from `backend\.venv`.

## Before publishing

- Build and install the NSIS package on a clean Windows 10/11 machine.
- Verify Windows microphone permission, notifications, app launch, reminders, voice, Ollama and optional Fish Audio setup.
- Sign the installer with the publisher certificate before public distribution.
- Publish the supported Windows version, required optional services, privacy details and a support contact with the download.

## Build a GitHub download draft

Push this source to a GitHub repository, then push a version tag such as `v0.1.0`. The Windows release workflow builds the NSIS installer on a Windows runner and creates a **draft prerelease** with the installer attached. Review the installer and release notes in GitHub, then publish the draft when ready. The app version in `src-tauri/tauri.conf.json` should match the tag. Public distribution should wait until the clean-machine checks above pass and the installer is signed.

MILO's operating-system integrations currently target Windows. Other operating systems need their own native bridge and installer before they are supported.
