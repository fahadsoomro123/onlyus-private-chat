'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('onlyUsDesktop', Object.freeze({
  incomingCall: () => ipcRenderer.send('onlyus:incoming-call'),
  callEnded: () => ipcRenderer.send('onlyus:call-ended'),
  micMonitorEnabled: () => ipcRenderer.invoke('onlyus:get-mic-monitor'),
  setMicMonitorEnabled: enabled => ipcRenderer.invoke('onlyus:set-mic-monitor', Boolean(enabled)),
  micMonitorActivity: active => ipcRenderer.send('onlyus:mic-monitor-activity', Boolean(active)),
  onMicMonitorPermissionChange: callback => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, enabled) => callback(Boolean(enabled));
    ipcRenderer.on('onlyus:mic-monitor-permission', handler);
    return () => ipcRenderer.removeListener('onlyus:mic-monitor-permission', handler);
  }
}));