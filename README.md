<div align="center">

<img src="assets/icon.png" width="120" alt="OI Desktop icon" />

# OI Desktop

**A polished macOS & Windows desktop wrapper for your [Open WebUI](https://github.com/open-webui/open-webui) instance.**

[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey?style=flat-square)](https://github.com/IcedTea363/OI-Desktop/releases)
[![Release](https://img.shields.io/github/v/release/IcedTea363/OI-Desktop?style=flat-square&color=4f46e5)](https://github.com/IcedTea363/OI-Desktop/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

[**Download**](https://github.com/IcedTea363/OI-Desktop/releases/latest) · [Report a bug](https://github.com/IcedTea363/OI-Desktop/issues) · [Request a feature](https://github.com/IcedTea363/OI-Desktop/issues)

</div>

---

## Overview

OI Desktop wraps any Open WebUI instance in a native app experience — with a system-wide quick-search hotkey, menu-bar tray icon, and a built-in local MCP tool server that gives your AI assistant direct access to your Mac's terminal, filesystem, and iTerm2.

No cloud dependency. No subscription. Connect it to your own Open WebUI and go.

---

## Screenshots

> **macOS — Main Window**

<!-- Replace with: assets/screenshots/main-window.png -->
> *Screenshot coming soon — run `screencapture -x assets/screenshots/main-window.png` after granting Terminal screen recording access in System Settings → Privacy & Security.*

---

> **Menu-bar Quick Search**

<!-- Replace with: assets/screenshots/quick-search.png -->
> *Single-click the tray icon (or press ⌘⇧Space from anywhere) to open the quick-search popover.*

---

> **Setup Wizard**

<!-- Replace with: assets/screenshots/wizard.png -->
> *On first launch, a setup wizard guides you to connect your Open WebUI URL.*

---

> **Preferences**

<!-- Replace with: assets/screenshots/preferences.png -->
> *Preferences panel — change URL, theme, and view your local MCP server address.*

---

## Features

| | Feature |
|---|---|
| 🖥️ | **Native app wrapper** — Open WebUI lives in its own window, separate from your browser |
| ⌨️ | **Global hotkey** — `⌘⇧Space` opens the quick-search popover from anywhere on your Mac |
| 🔍 | **Menu-bar tray** — single-click for quick search, double-click to bring up the full window |
| 🤖 | **Local MCP server** — gives your AI direct access to your Mac (shell, files, iTerm2) |
| 🌙 | **Theme support** — System, Light, or Dark mode, synced into the webview |
| 💾 | **Window state persistence** — remembers your window size and position |
| 🔒 | **Security-hardened** — MCP server bound to loopback only, CORS origin validated |

---

## Download

Head to the [**Releases page**](https://github.com/IcedTea363/OI-Desktop/releases/latest) and grab the right file for your platform:

| Platform | File |
|----------|------|
| macOS Apple Silicon (M1/M2/M3/M4) | `OI Desktop-x.x.x-arm64.dmg` |
| macOS Intel | `OI Desktop-x.x.x.dmg` |
| Windows 10/11 (64-bit) | `OI Desktop Setup x.x.x.exe` |

### macOS

1. Open the `.dmg` file
2. Drag **OI Desktop** into your **Applications** folder
3. Launch it — macOS may show a Gatekeeper warning on first open since the app is unsigned. Right-click the app → **Open** → **Open** to bypass it once.

### Windows

1. Run `OI Desktop Setup x.x.x.exe`
2. Follow the installer steps — it creates Start Menu and Desktop shortcuts
3. Windows SmartScreen may warn the app is unsigned. Click **More info → Run anyway**.

---

## First Launch

On first launch, the **Setup Wizard** will appear:

1. **Enter your Open WebUI URL** — e.g. `https://ai.example.com` or `http://localhost:3000`
2. Click **Test Connection** to verify it's reachable
3. Click **Continue** → **Launch Open WebUI**

You can change the URL and other settings any time via the tray icon right-click menu → **Preferences**.

---

## MCP Tool Server

OI Desktop runs a local [MCP](https://modelcontextprotocol.io) tool server at `http://127.0.0.1:27124`. Add this URL to your Open WebUI instance under **Settings → Tools → Tool Servers** and your AI will gain access to the following tools:

| Tool | Description |
|------|-------------|
| `run_shell_command` | Execute a bash command and return stdout/stderr/exit code to the AI |
| `run_in_iterm2` | Send a command to iTerm2 (or Terminal.app) — visible and interactive |
| `read_file` | Read any file on your Mac |
| `write_file` | Write content to any file (creates parent directories as needed) |
| `list_directory` | List files and folders in a directory |
| `get_system_info` | Return username, hostname, OS version, date/time |

The MCP server URL is shown in **Preferences → Terminal Integration**.

> **Security note:** The MCP server binds exclusively to `127.0.0.1` and validates CORS origins against your configured Open WebUI URL. It is not accessible from other devices on your network.

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘⇧Space` | Open / close the quick-search popover (global, works from any app) |
| `Esc` | Close the quick-search popover |
| `↵ Enter` | Send the quick-search query to Open WebUI |
| Tray single-click | Open quick-search popover |
| Tray double-click | Bring the main window to focus |
| Tray right-click | Context menu (Open, Preferences, Quit) |
| `⌘,` | Open Preferences |

---

## Development

### Prerequisites

- [Node.js](https://nodejs.org) 18+
- [npm](https://npmjs.com)

### Run locally

```bash
git clone https://github.com/IcedTea363/OI-Desktop.git
cd OI-Desktop
npm install
npm start
```

Logs are written to `/tmp/nailai.log`.

### Build installers

```bash
# macOS DMGs (arm64 + x64)
npm run build

# macOS + Windows
npm run build -- --win
```

Output lands in the `build/` directory.

### Project structure

```
oi-desktop/
├── main.js              # Electron main process — windows, tray, IPC, hotkey
├── mcp-server.js        # Local MCP/OpenAPI tool server (port 27124)
├── config.js            # JSON config persistence
├── preload.js           # Popover window IPC bridge
├── preload-ui.js        # Settings/Wizard IPC bridge
├── preload-main.js      # Main window iTerm2 IPC bridge
├── popover.html         # Quick-search popover UI
├── settings.html        # Preferences panel UI
├── wizard.html          # First-run setup wizard UI
├── assets/
│   ├── icon.png         # 512×512 app icon
│   └── tray-iconTemplate.png  # 22×22 macOS menu-bar icon
└── scripts/
    └── generate-icon.js # Fetches & generates icons from Open WebUI source
```

---

## Releasing a new version

```bash
# 1. Bump version in package.json
# 2. Rebuild
npm run build -- --win

# 3. Commit & push
git add -A && git commit -m "Release vX.X.X"
git push

# 4. Publish GitHub release with installers
gh release create vX.X.X \
  "build/OI Desktop-X.X.X-arm64.dmg" \
  "build/OI Desktop-X.X.X.dmg" \
  "build/OI Desktop Setup X.X.X.exe" \
  --title "OI Desktop vX.X.X" \
  --generate-notes
```

---

## Security

- MCP server binds to `127.0.0.1` only — not accessible from the local network
- CORS origin is validated against your configured Open WebUI URL — no arbitrary site can call the tool server
- All Electron windows use `nodeIntegration: false` + `contextIsolation: true`
- URL inputs are validated to `http://` and `https://` schemes only

---

## License

MIT — see [LICENSE](LICENSE) for details.
