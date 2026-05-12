'use strict';

const {
  app, BrowserWindow, Tray, Menu, globalShortcut,
  ipcMain, screen, nativeImage, nativeTheme, net, session,
} = require('electron');
const path = require('path');
const fs   = require('fs');

// Disable Chromium's Private Network Access preflight enforcement so the
// embedded Open WebUI page can POST to our local MCP server without the
// second (PNA) CORS preflight being blocked by Chromium's network stack.
// This is safe for a desktop app — we're not a web browser.
app.commandLine.appendSwitch(
  'disable-features',
  'BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights'
);

const config    = require('./config');
const mcpServer = require('./mcp-server');

// ── Paths ──────────────────────────────────────────────────────────────────────
const ICON_PATH      = path.join(__dirname, 'assets', 'icon.png');
const TRAY_ICON_PATH = path.join(__dirname, 'assets', 'tray-iconTemplate.png');
const SETTINGS_FILE  = path.join(app.getPath('userData'), 'window-settings.json');

// ── State ──────────────────────────────────────────────────────────────────────
let mainWindow     = null;
let tray           = null;
let popoverWindow  = null;
let settingsWindow = null;
let wizardWindow   = null;
let isQuitting     = false;
let currentHotkey  = '';

// ── Window bounds persistence ──────────────────────────────────────────────────
function loadBounds() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
function saveBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(mainWindow.getBounds())); } catch {}
}

// ── Theme ──────────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  nativeTheme.themeSource = theme || 'system';
}

// ── Main window ────────────────────────────────────────────────────────────────
function createMainWindow() {
  const saved  = loadBounds();
  const bounds = { width: 1280, height: 860, ...saved };

  const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
    bounds.x >= a.x && bounds.y >= a.y &&
    bounds.x < a.x + a.width && bounds.y < a.y + a.height
  );
  if (!onScreen) { delete bounds.x; delete bounds.y; }

  // On macOS: hide the title bar so Open WebUI's own header fills edge-to-edge.
  // 'customButtonsOnHover' keeps traffic lights invisible until you hover the
  // top-left corner — same pattern Perplexity and Notion use.
  // On Windows/Linux: keep the native frame.
  const macOSTitleBar = process.platform === 'darwin'
    ? { titleBarStyle: 'customButtonsOnHover', trafficLightPosition: { x: 12, y: 18 } }
    : {};

  mainWindow = new BrowserWindow({
    ...bounds,
    title: config.get('appName') || 'Open WebUI',
    icon: ICON_PATH,
    ...macOSTitleBar,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: 'persist:owui',
      preload: path.join(__dirname, 'preload-main.js'),
    },
  });

  const url = config.get('url');
  if (url) mainWindow.loadURL(url);
  else     mainWindow.loadURL('about:blank');

  mainWindow.on('resize', saveBounds);
  mainWindow.on('move',   saveBounds);

  // Forward [OI Desktop] console messages from the webview to the main log
  mainWindow.webContents.on('console-message', (_e, _level, message) => {
    if (message.includes('[OI Desktop')) console.log(message);
  });

  // Inject "⌨ iTerm2" run-buttons on every page load
  mainWindow.webContents.on('did-finish-load', () => {
    injectTerminalButtons();
    injectTopInsetCSS();
    setDockIcon();
  });

  // macOS resets the dock icon to the app-bundle icon whenever the app
  // activates or a window is shown. Re-apply at every opportunity.
  mainWindow.on('show',  setDockIcon);
  mainWindow.on('focus', setDockIcon);

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      if (app.dock) app.dock.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function setDockIcon() {
  if (!app.dock) return;
  app.dock.setIcon(nativeImage.createFromPath(ICON_PATH));
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  if (app.dock) {
    setDockIcon();
    app.dock.show();
    // macOS resets the dock icon to the bundle icon during app activation.
    // Fire multiple times to reliably win the race.
    setTimeout(setDockIcon, 100);
    setTimeout(setDockIcon, 300);
    setTimeout(setDockIcon, 600);
  }
}

// ── Wizard window ──────────────────────────────────────────────────────────────
function openWizard() {
  if (wizardWindow && !wizardWindow.isDestroyed()) {
    wizardWindow.focus(); return;
  }
  wizardWindow = new BrowserWindow({
    width: 480, height: 540,
    resizable: false, maximizable: false,
    title: 'Setup',
    icon: ICON_PATH,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-ui.js'),
    },
  });
  wizardWindow.setMenu(null);
  wizardWindow.loadFile('wizard.html');
  wizardWindow.on('closed', () => { wizardWindow = null; });
}

// ── Settings window ────────────────────────────────────────────────────────────
function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus(); return;
  }
  settingsWindow = new BrowserWindow({
    width: 500, height: 460,
    resizable: false, maximizable: false,
    titleBarStyle: 'hidden',
    icon: ICON_PATH,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-ui.js'),
    },
  });
  settingsWindow.setMenu(null);
  settingsWindow.loadFile('settings.html');
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ── Tray ───────────────────────────────────────────────────────────────────────
function createTray() {
  const icon = nativeImage.createFromPath(TRAY_ICON_PATH);
  tray = new Tray(icon);
  tray.setToolTip(config.get('appName') || 'Open WebUI');

  // Single click → popover; double-click → main window.
  // Electron fires 'double-click' as a distinct tray event on macOS.
  // We use a short timer on 'click' so that the first click of a double-click
  // doesn't open the popover before 'double-click' fires and cancels it.
  let clickTimer = null;
  tray.on('click', (_e, bounds) => {
    clickTimer = setTimeout(() => {
      clickTimer = null;
      togglePopover(bounds);
    }, 250);
  });
  tray.on('double-click', () => {
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    closePopover();
    focusMainWindow();
  });

  tray.on('right-click', () => {
    tray.popUpContextMenu(Menu.buildFromTemplate([
      { label: `Open ${config.get('appName') || 'Open WebUI'}`, click: focusMainWindow },
      { label: 'Preferences…', click: openSettings },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
    ]));
  });
}

// ── Popover ────────────────────────────────────────────────────────────────────
const POPOVER_W = 420, POPOVER_H = 52;

function popoverPosition(trayBounds) {
  const display = screen.getDisplayMatching(trayBounds);
  const wa = display.workArea;
  let x = Math.round(trayBounds.x + trayBounds.width  / 2 - POPOVER_W / 2);
  let y = Math.round(trayBounds.y + trayBounds.height + 4);
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width  - POPOVER_W));
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - POPOVER_H));
  return { x, y };
}

function createPopover(trayBounds) {
  const { x, y } = popoverPosition(trayBounds);

  popoverWindow = new BrowserWindow({
    x, y, width: POPOVER_W, height: POPOVER_H,
    frame: false, resizable: false, movable: false,
    transparent: true, hasShadow: true,
    alwaysOnTop: true, skipTaskbar: true, show: false,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  popoverWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  popoverWindow.setAlwaysOnTop(true, 'screen-saver');
  popoverWindow.loadFile('popover.html');
  popoverWindow.once('ready-to-show', () => { popoverWindow.show(); popoverWindow.focus(); });
  popoverWindow.on('blur',   closePopover);
  popoverWindow.on('closed', () => { popoverWindow = null; });
}

function closePopover() {
  if (popoverWindow && !popoverWindow.isDestroyed()) popoverWindow.close();
}

function togglePopover(trayBounds) {
  if (popoverWindow && !popoverWindow.isDestroyed()) closePopover();
  else createPopover(trayBounds);
}

function showPopoverFromHotkey() {
  if (popoverWindow && !popoverWindow.isDestroyed()) { closePopover(); return; }
  createPopover(tray.getBounds());
}

// ── Hotkey ─────────────────────────────────────────────────────────────────────
function registerHotkey(hotkey) {
  if (currentHotkey) globalShortcut.unregister(currentHotkey);
  const ok = globalShortcut.register(hotkey, showPopoverFromHotkey);
  if (ok) currentHotkey = hotkey;
  return ok;
}

// ── Application menu (macOS) ───────────────────────────────────────────────────
function buildAppMenu() {
  const name = config.get('appName') || 'Open WebUI';
  const template = [
    {
      label: name,
      submenu: [
        { label: `About ${name}`, role: 'about' },
        { type: 'separator' },
        { label: 'Preferences…', accelerator: 'Cmd+,', click: openSettings },
        { type: 'separator' },
        { label: `Hide ${name}`, role: 'hide' },
        { label: 'Hide Others',  role: 'hideOthers' },
        { type: 'separator' },
        { label: `Quit ${name}`, role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' }, { role: 'zoom' },
        { type: 'separator' }, { role: 'front' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Terminal button injection ──────────────────────────────────────────────────
// Injected into Open WebUI after every page load. Adds "⌨ iTerm2" buttons
// to shell code blocks; clicks go through window.oidTerminal (IPC bridge).
const TERMINAL_INJECT = `(function() {
  if (window.__oidTermInjected) return;
  window.__oidTermInjected = true;

  // On macOS with hiddenInset title bar the very top strip of the window is
  // the drag region. Inject a transparent overlay so the user can drag the
  // window by clicking anywhere on Open WebUI's top nav bar.
  if (navigator.platform.startsWith('Mac')) {
    const drag = document.createElement('div');
    drag.id = 'oid-drag-region';
    Object.assign(drag.style, {
      position:  'fixed',
      top:       '0',
      left:      '80px',   // leave room for traffic-light buttons (≈76px wide)
      right:     '0',
      height:    '40px',
      zIndex:    '9999',
      webkitAppRegion: 'drag',
      pointerEvents: 'none',  // let clicks fall through to Open WebUI
    });
    document.documentElement.appendChild(drag);
  }

  const SHELL = new Set(['bash','shell','sh','zsh','fish','console','terminal','ps1','powershell']);

  const style = document.createElement('style');
  style.textContent = \`
    .oid-iterm-btn {
      position: absolute !important;
      top: 7px !important;
      right: 44px !important;
      padding: 3px 9px !important;
      background: rgba(20,20,30,0.82) !important;
      color: rgba(255,255,255,0.65) !important;
      border: 1px solid rgba(255,255,255,0.1) !important;
      border-radius: 6px !important;
      font-size: 11px !important;
      font-family: -apple-system, ui-monospace, monospace !important;
      cursor: pointer !important;
      z-index: 50 !important;
      white-space: nowrap !important;
      opacity: 0 !important;
      transition: opacity .15s, background .15s, color .15s !important;
      backdrop-filter: blur(6px) !important;
      line-height: 1.4 !important;
    }
    pre:hover .oid-iterm-btn { opacity: 1 !important; }
    .oid-iterm-btn:hover {
      background: rgba(79,70,229,0.9) !important;
      color: #fff !important;
      border-color: rgba(99,102,241,.4) !important;
    }
    .oid-iterm-btn.ok  { background: rgba(34,197,94,.85)  !important; color:#fff !important; opacity:1 !important; }
    .oid-iterm-btn.err { background: rgba(239,68,68,.85)   !important; color:#fff !important; opacity:1 !important; }
  \`;
  document.head.appendChild(style);

  function addButtons() {
    document.querySelectorAll('pre code:not([data-oid-term])').forEach(code => {
      code.setAttribute('data-oid-term', '1');

      const lang = ([...code.classList].find(c => c.startsWith('language-')) || '')
                    .replace('language-', '').toLowerCase();
      const looksLikeShell = SHELL.has(lang) ||
        (!lang && /^\\s*[$#>]\\s/m.test(code.innerText.slice(0, 300)));
      if (!looksLikeShell) return;

      const pre = code.closest('pre');
      if (!pre || pre.querySelector('.oid-iterm-btn')) return;
      pre.style.position = 'relative';

      const btn = document.createElement('button');
      btn.className = 'oid-iterm-btn';
      btn.title     = 'Run in iTerm2';
      btn.textContent = '⌨ iTerm2';

      btn.onclick = async e => {
        e.stopPropagation(); e.preventDefault();
        let cmd = code.innerText.trim()
          .split('\\n').map(l => l.replace(/^[$#>]\\s+/, '')).join('\\n').trim();
        btn.textContent = '⏳';
        try {
          await window.oidTerminal.runInITerm2(cmd, false);
          btn.textContent = '✓ Sent';
          btn.classList.add('ok');
          setTimeout(() => { btn.textContent = '⌨ iTerm2'; btn.classList.remove('ok'); }, 2000);
        } catch {
          btn.textContent = '✗ Error';
          btn.classList.add('err');
          setTimeout(() => { btn.textContent = '⌨ iTerm2'; btn.classList.remove('err'); }, 2000);
        }
      };

      pre.appendChild(btn);
    });
  }

  addButtons();
  new MutationObserver(addButtons).observe(document.body, { childList: true, subtree: true });
})();`;

function injectTerminalButtons() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.executeJavaScript(TERMINAL_INJECT).catch(() => {});
}

// On macOS with no title bar, push Open WebUI's sidebar content down so the
// logo clears the invisible traffic-light zone. We constrain the sidebar to
// 100vh with box-sizing:border-box so the padding is absorbed *inside* the
// existing height rather than growing the scrollable area and hiding the
// user-profile button at the bottom.
function injectTopInsetCSS() {
  if (process.platform !== 'darwin' || !mainWindow || mainWindow.isDestroyed()) return;
  const css = `
    /* [OI Desktop] macOS traffic-light safe area ─────────────────────────────
       padding-top with box-sizing:border-box keeps the inset inside 100vh
       so no overflow occurs. Applies to both expanded and collapsed states. */

    #sidebar {
      height: 100vh !important;
      box-sizing: border-box !important;
      padding-top: 46px !important;
      overflow: hidden !important;
    }

    /* Open WebUI's inner wrapper sets its own h-screen / height:100vh.
       Override it so it fills our padded box rather than the full viewport,
       keeping the profile button visible at the bottom. */
    #sidebar > div:first-child {
      height: 100% !important;
    }

    /* The chat-history pane handles its own scrolling — restore it. */
    #sidebar .overflow-y-auto {
      overflow-y: auto !important;
      flex: 1 1 0% !important;
      min-height: 0 !important;
    }

    /* Push the model-selector button away from the left edge so it
       doesn't crowd the traffic-light hover zone. The nav's first-child
       flex row already has pl-1.5; we give it a bit more room. */
    nav.sticky > div:first-child {
      padding-left: 16px !important;
    }
  `;
  mainWindow.webContents.insertCSS(css).catch(() => {});
}

// ── Query injection ────────────────────────────────────────────────────────────
const INJECT_JS = (query) => `
(async () => {
  const q = ${JSON.stringify(query)};
  const log = m => console.log('[OI Desktop inject] ' + m);

  function fillTextarea(el, val) {
    el.focus();
    const proto = el.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, val); else el.value = val;
    el.dispatchEvent(new InputEvent('input',  { bubbles: true, data: val }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fillContentEditable(el, val) {
    el.focus();
    // Set content directly then fire a native-style InputEvent.
    // Svelte's bind:innerHTML/textContent reacts to this event type.
    el.textContent = val;
    // Move cursor to end so the send button enables
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true, cancelable: false,
      inputType: 'insertText', data: val,
    }));
  }

  function findSendButton() {
    return document.querySelector('button[aria-label="Send message"]')
        || document.querySelector('button[aria-label*="send" i]')
        || document.querySelector('[data-testid="send-message-button"]')
        || [...document.querySelectorAll('button')].find(b =>
              !b.disabled && /send/i.test(b.getAttribute('aria-label') || ''))
        || document.querySelector('button[type="submit"]');
  }

  for (let i = 0; i < 40; i++) {
    // textarea / input  (older Open WebUI)
    const ta = document.querySelector('textarea#chat-input')
            || document.querySelector('textarea[data-testid="message-input"]')
            || document.querySelector('textarea[placeholder]')
            || document.querySelector('textarea');

    // contenteditable — Open WebUI uses "plaintext-only", not "true",
    // so match the attribute name only, not its value
    const ce = ta ? null
             : document.querySelector('#chat-input[contenteditable]')
            || document.querySelector('[contenteditable][data-testid]')
            || document.querySelector('div[contenteditable]')
            || document.querySelector('p[contenteditable]')
            || document.querySelector('[role="textbox"]');

    const el = ta || ce;
    if (el) {
      log('Found: <' + el.tagName.toLowerCase()
        + (el.id ? ' id=' + el.id : '')
        + ' contenteditable=' + el.getAttribute('contenteditable') + '>');

      if (ta) fillTextarea(el, q);
      else    fillContentEditable(el, q);

      await new Promise(r => setTimeout(r, 400));
      log('Content after fill: "' + (el.textContent || el.value || '').slice(0, 60) + '"');

      const btn = findSendButton();
      log('Send btn: ' + (btn ? btn.outerHTML.slice(0, 80) + ' disabled=' + btn.disabled : 'NOT FOUND'));

      if (btn && !btn.disabled) {
        btn.click();
        log('Clicked send button');
      } else {
        el.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true,
        }));
        log('Dispatched Enter keydown');
      }
      return;
    }

    if (i % 5 === 0) log('Waiting for input… attempt ' + i);
    await new Promise(r => setTimeout(r, 200));
  }

  // Dump DOM info so we can diagnose the selector miss
  log('FAILED after 8s. contenteditable els: ['
    + [...document.querySelectorAll('[contenteditable]')]
        .map(e => e.tagName + (e.id ? '#' + e.id : '') + '[' + e.getAttribute('contenteditable') + ']')
        .join(', ') + ']');
  log('textareas: ' + document.querySelectorAll('textarea').length);
})();
`;

function injectQuery(query) {
  focusMainWindow();
  const wc = mainWindow.webContents;
  const doInject = () => setTimeout(
    () => wc.executeJavaScript(INJECT_JS(query)).catch(console.error), 300
  );
  const url = config.get('url');
  const currentURL = wc.getURL();
  if (url && !currentURL.startsWith(url.replace(/\/$/, ''))) {
    wc.loadURL(url);
    wc.once('did-finish-load', doInject);
  } else if (wc.isLoading()) {
    wc.once('did-finish-load', doInject);
  } else {
    doInject();
  }
}

// ── URL validation ─────────────────────────────────────────────────────────────
// Only allow http/https URLs. Rejects javascript:, file://, data:, etc. to
// prevent a malicious or mistyped URL from being loaded into the main webview.
function isSafeUrl(url) {
  if (!url) return true; // empty → no URL configured, that's fine
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// ── URL tester (main process, bypasses CORS) ───────────────────────────────────
function testUrl(url) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'Timed out after 8 s' }), 8000);
    try {
      const req = net.request({ url, method: 'HEAD' });
      req.on('response', (res) => {
        clearTimeout(timer);
        resolve({ ok: res.statusCode < 500, status: res.statusCode });
      });
      req.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, error: err.message });
      });
      req.end();
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    }
  });
}

// ── IPC ────────────────────────────────────────────────────────────────────────
ipcMain.handle('get-config', () => config.load());

ipcMain.handle('save-config', (_e, updates) => {
  // Reject non-http(s) URLs before they can be persisted or loaded into the webview.
  if (updates.url !== undefined && !isSafeUrl(updates.url)) {
    throw new Error('URL must use http:// or https://');
  }
  const prev = config.load();
  const next = config.save(updates);

  // Apply side effects immediately
  if (updates.theme !== undefined) applyTheme(next.theme);

  if (updates.url !== undefined && updates.url !== prev.url) {
    if (mainWindow && !mainWindow.isDestroyed() && next.url) {
      mainWindow.loadURL(next.url);
    }
  }

  if (updates.appName !== undefined && updates.appName !== prev.appName) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(next.appName);
    if (tray) tray.setToolTip(next.appName);
    buildAppMenu();
  }

  return next;
});

ipcMain.handle('test-url', (_e, url) => {
  if (!isSafeUrl(url)) return { ok: false, error: 'URL must use http:// or https://' };
  return testUrl(url);
});

ipcMain.handle('wizard-done', async (_e, data) => {
  if (data.url && !isSafeUrl(data.url)) throw new Error('URL must use http:// or https://');
  if (data.url) config.save({ url: data.url, firstRun: false });
  else          config.save({ firstRun: false });

  if (wizardWindow && !wizardWindow.isDestroyed() && !data.launch) return;

  // Launch = close wizard, open main window
  if (mainWindow && !mainWindow.isDestroyed()) {
    const url = config.get('url');
    if (url) mainWindow.loadURL(url);
    focusMainWindow();
  } else {
    createMainWindow();
    focusMainWindow();
  }
  if (wizardWindow && !wizardWindow.isDestroyed()) wizardWindow.close();
});

ipcMain.on('close-window', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) win.close();
});

ipcMain.on('open-settings', openSettings);

ipcMain.handle('run-in-iterm2', (_e, command, newTab) => {
  try { return mcpServer.runInITerm2(command, !!newTab); }
  catch (e) { throw new Error(e.message); }
});

ipcMain.handle('get-mcp-url', () => ({
  local:   `http://127.0.0.1:${mcpServer.getPort()}/mcp`,
  network: `http://${mcpServer.getLocalIP()}:${mcpServer.getPort()}/mcp`,
}));

ipcMain.on('submit-query', (_e, query) => {
  closePopover();
  if (query?.trim()) injectQuery(query.trim());
});

ipcMain.on('close-popover', closePopover);

// ── App lifecycle ──────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', focusMainWindow);

  app.whenReady().then(() => {
    applyTheme(config.get('theme'));
    buildAppMenu();
    mcpServer.startServer();

    if (app.dock) {
      setDockIcon();
      app.dock.hide();
    }

    const owuiSession = session.fromPartition('persist:owui');

    // Strip CSP headers from Open WebUI responses so the embedded page can
    // reach our local MCP server at http://127.0.0.1 (blocked by strict CSP).
    // Intentionally scoped to the Open WebUI origin only — our MCP server's
    // responses must pass through unmodified or Chromium's CORS/PNA checks fail.
    const owuiOrigin = (() => {
      try { return new URL(config.get('url') || '').origin + '/*'; } catch { return null; }
    })();
    if (owuiOrigin) {
      owuiSession.webRequest.onHeadersReceived(
        { urls: [owuiOrigin] },
        (details, callback) => {
          const h = { ...details.responseHeaders };
          delete h['content-security-policy'];
          delete h['Content-Security-Policy'];
          delete h['content-security-policy-report-only'];
          delete h['Content-Security-Policy-Report-Only'];
          callback({ responseHeaders: h });
        }
      );
    }


    createMainWindow();
    createTray();
    registerHotkey(config.get('hotkey'));

    if (config.get('firstRun') || !config.get('url')) {
      openWizard();
    } else {
      focusMainWindow();
    }
  });

  app.on('activate', () => {
    // Dock icon click — show main window (or wizard if not yet configured)
    if (config.get('firstRun') || !config.get('url')) openWizard();
    else focusMainWindow();
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('before-quit', () => { isQuitting = true; });
  app.on('window-all-closed', () => { /* stay alive in tray */ });
}
