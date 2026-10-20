'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('onlyUsDesktop', Object.freeze({
  incomingCall: () => ipcRenderer.send('onlyus:incoming-call'),
  callEnded: () => ipcRenderer.send('onlyus:call-ended')
}));
