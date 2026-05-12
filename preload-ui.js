'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig:    ()          => ipcRenderer.invoke('get-config'),
  saveConfig:   (data)      => ipcRenderer.invoke('save-config', data),
  testUrl:      (url)       => ipcRenderer.invoke('test-url', url),
  wizardDone:   (data)      => ipcRenderer.invoke('wizard-done', data),
  getMcpUrl:    ()          => ipcRenderer.invoke('get-mcp-url'),
  closeWindow:  ()          => ipcRenderer.send('close-window'),
  openSettings: ()          => ipcRenderer.send('open-settings'),
});
