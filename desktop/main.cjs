'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, session, shell, ipcMain, Notification, powerSaveBlocker, powerMonitor } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let win = null;
let tray = null;
let server = null;
let appUrl = 'http://127.0.0.1:4178';
let preferences = { startWithWindows: true };
let incomingNotification = null;
let powerBlockerId = null;
let allowQuit = false;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function backendConnectSources(root) {
  const sources = ["'self'"];
  try {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'pair-config.json'), 'utf8'));
    const parsed = new URL(String(config.backendUrl || ''));
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      sources.push(parsed.origin);
      const socketScheme = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      sources.push(socketScheme + '//' + parsed.host);
    }
  } catch {}
  return sources.join(' ');
}

function publicRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'public')
    : path.resolve(__dirname, '..', 'public');
}

function loadPreferences() {
  try {
    const file = path.join(app.getPath('userData'), 'settings.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { startWithWindows: saved.startWithWindows !== false };
  } catch {
    return { startWithWindows: true };
  }
}

function setStartup(enabled) {
  preferences.startWithWindows = Boolean(enabled);
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(path.join(app.getPath('userData'), 'settings.json'), JSON.stringify(preferences, null, 2));
    app.setLoginItemSettings({
      openAtLogin: preferences.startWithWindows,
      path: process.execPath,
      args: ['--hidden'],
      enabled: preferences.startWithWindows,
      name: 'Only Us'
    });
  } catch (error) {
    console.error('Only Us startup setting failed:', error.message);
  }
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect x="1" y="1" width="30" height="30" rx="9" fill="#315eea"/><path d="M16 25s-8-5.8-8-12a4.4 4.4 0 0 1 8-2.2A4.4 4.4 0 0 1 24 13c0 6.2-8 12-8 12Z" fill="none" stroke="#fff" stroke-width="2"/></svg>';
  const trayImage = nativeImage.createFromDataURL('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
  tray = new Tray(trayImage);
  tray.setToolTip('Only Us · Private calls and messages');
  const refreshMenu = () => {
    const startup = preferences.startWithWindows;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Only Us', click: showWindow },
      { type: 'separator' },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: startup,
        click: item => setStartup(item.checked)
      },
      { type: 'separator' },
      { label: 'Exit Only Us', click: () => { allowQuit = true; app.quit(); } }
    ]));
  };
  refreshMenu();
  tray.on('click', showWindow);
  tray.on('right-click', refreshMenu);
}

function createStaticServer() {
  const root = path.resolve(publicRoot());
  const connectSources = backendConnectSources(root);
  server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    if (pathname === '/') pathname = '/index.html';
    const file = path.resolve(root, '.' + pathname);
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    fs.stat(file, (statError, stat) => {
      if (statError || !stat.isFile()) {
        res.writeHead(404, { 'Cache-Control': 'no-store' }).end('Not found');
        return;
      }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src " + connectSources + "; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
        'Cache-Control': path.basename(file) === 'pair-config.json' ? 'no-store' : 'no-cache'
      });
      fs.createReadStream(file).pipe(res);
    });
  });
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 520,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    title: 'Only Us',
    backgroundColor: '#f6f8fc',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  win.webContents.setBackgroundThrottling(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('close', event => {
    if (!allowQuit) {
      event.preventDefault();
      win.hide();
    }
  });

  await win.loadURL(appUrl);

  // The installed laptop build is intended to belong to the Wife device.
  // On first run, auto-select Wife only after the local private config is loaded.
  await win.webContents.executeJavaScript(`(async () => {
    if (localStorage.getItem('onlyus.profile.v1')) return 'profile-exists';
    for (let i = 0; i < 80; i += 1) {
      const setup = document.querySelector('#pairSetup');
      const wife = document.querySelector('[data-role="wife"]');
      if (setup && setup.hidden && wife && window.Peer && typeof settings !== 'undefined' && settings && settings.roomKey) {
        wife.click();
        return 'wife-started';
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return 'config-not-ready';
  })()`).catch(error => console.error('Only Us first-run setup failed:', error.message));

  const hiddenLaunch = process.argv.includes('--hidden');
  if (!hiddenLaunch) win.show();
}

if (!gotLock) {
  // Another instance already owns the tray/server.
} else {
  app.whenReady().then(() => {
    preferences = loadPreferences();
    setStartup(preferences.startWithWindows);

    // Keep the call-signaling app alive while the display is off.
    // The monitor may turn off; Windows itself must not enter sleep.
    try {
      powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    } catch (error) {
      console.error('Only Us power-save blocker failed:', error.message);
    }
    powerMonitor.on('resume', () => {
      if (win && !win.isDestroyed()) {
        win.webContents.executeJavaScript(
          "if (typeof peer !== 'undefined' && peer && !peer.destroyed) { try { peer.reconnect(); } catch {} }"
        ).catch(() => {});
      }
    });
    const originAllowed = origin => {
      try { return new URL(origin).origin === appUrl; } catch { return false; }
    };
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const allowedOrigin = appUrl && originAllowed(details && details.requestingUrl || webContents.getURL());
      const audioOnly = details && Array.isArray(details.mediaTypes)
        && details.mediaTypes.includes('audio')
        && !details.mediaTypes.includes('video');
      callback(Boolean(allowedOrigin && permission === 'media' && audioOnly));
    });

    ipcMain.on('onlyus:incoming-call', event => {
      if (!event.sender.getURL().startsWith(appUrl)) return;
      if (win && !win.isDestroyed()) win.flashFrame(true);
      if (Notification.isSupported()) {
        if (incomingNotification) incomingNotification.close();
        incomingNotification = new Notification({
          title: 'Only Us',
          body: 'Incoming voice call from your partner',
          silent: false
        });
        incomingNotification.on('click', showWindow);
        incomingNotification.show();
      }
    });

    ipcMain.on('onlyus:call-ended', event => {
      if (!event.sender.getURL().startsWith(appUrl)) return;
      if (win && !win.isDestroyed()) win.flashFrame(false);
      if (incomingNotification) {
        incomingNotification.close();
        incomingNotification = null;
      }
    });

    createStaticServer();
    server.listen(4178, '127.0.0.1', async () => {
      try {
        createTray();
        await createWindow();
      } catch (error) {
        console.error('Only Us desktop startup failed:', error);
        app.quit();
      }
    });
    server.on('error', error => {
      console.error('Only Us local server error:', error);
    });
  });

  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('before-quit', () => {
    allowQuit = true;
    if (powerBlockerId !== null) {
      try { powerSaveBlocker.stop(powerBlockerId); } catch {}
      powerBlockerId = null;
    }
    if (tray) { tray.destroy(); tray = null; }
    if (server) { try { server.close(); } catch {} }
  });
}
