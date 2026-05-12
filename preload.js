'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  submitQuery: (query) => ipcRenderer.send('submit-query', query),
  closePopover: ()     => ipcRenderer.send('close-popover'),
});
