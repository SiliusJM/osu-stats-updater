'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadConfig:      ()     => ipcRenderer.invoke('load-config'),
  saveConfig:      (data) => ipcRenderer.invoke('save-config', data),
  startBot:        ()     => ipcRenderer.invoke('start-bot'),
  stopBot:         ()     => ipcRenderer.invoke('stop-bot'),
  testConnection:  ()     => ipcRenderer.invoke('test-connection'),
  onLog:           (cb)   => ipcRenderer.on('bot-log',        (_, msg)  => cb(msg)),
  onStopped:       (cb)   => ipcRenderer.on('bot-stopped',    (_, code) => cb(code)),
  onBotRestarted:  (cb)   => ipcRenderer.on('bot-restarted',  ()        => cb()),
});
