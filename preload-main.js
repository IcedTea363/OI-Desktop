'use strict';
/**
 * Preload for the main Open WebUI window.
 * Exposes a minimal terminal bridge so injected code-block buttons
 * can trigger iTerm2 via IPC without needing a local HTTP fetch.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('oidTerminal', {
  runInITerm2: (command, newTab) =>
    ipcRenderer.invoke('run-in-iterm2', command, !!newTab),
});
