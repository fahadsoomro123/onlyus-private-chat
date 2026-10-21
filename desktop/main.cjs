'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, session, shell, ipcMain, Notification, powerSaveBlocker, powerMonitor } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
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
let preferences = { startWithWindows: true, allowPhoneMicMonitor: false, lidActionBackup: null };
let incomingNotification = null;
let powerBlockerId = null;
let monitorPowerRequest = null;
let micMonitorActive = false;
let refreshTrayMenu = () => {};
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
    const loaded = {
      startWithWindows: saved.startWithWindows !== false,
      allowPhoneMicMonitor: saved.allowPhoneMicMonitor === true,
      lidActionBackup: saved.lidActionBackup && Number.isInteger(saved.lidActionBackup.ac)
        && Number.isInteger(saved.lidActionBackup.dc) ? saved.lidActionBackup : null
    };
    if (loaded.lidActionBackup && !loaded.allowPhoneMicMonitor
        && applyLidActionValues(loaded.lidActionBackup)) {
      loaded.lidActionBackup = null;
      fs.writeFileSync(file, JSON.stringify(loaded, null, 2));
    }
    return loaded;
  } catch {
    return { startWithWindows: true, allowPhoneMicMonitor: false, lidActionBackup: null };
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

function setMicMonitorPermission(enabled) {
  preferences.allowPhoneMicMonitor = Boolean(enabled);
  setStartup(preferences.startWithWindows);
  setSystemAwakeRequest(preferences.allowPhoneMicMonitor || micMonitorActive);
  refreshTrayMenu();
  if (win && !win.isDestroyed()) {
    win.webContents.send('onlyus:mic-monitor-permission', preferences.allowPhoneMicMonitor);
  }
  return preferences.allowPhoneMicMonitor;
}

function applyLidActionValues(values) {
  if (!values || !Number.isInteger(values.ac) || !Number.isInteger(values.dc)) return false;
  const ac = spawnSync('powercfg.exe', [
    '/setacvalueindex', 'SCHEME_CURRENT', 'SUB_BUTTONS', 'LIDACTION', String(values.ac)
  ], { encoding: 'utf8', windowsHide: true });
  const dc = spawnSync('powercfg.exe', [
    '/setdcvalueindex', 'SCHEME_CURRENT', 'SUB_BUTTONS', 'LIDACTION', String(values.dc)
  ], { encoding: 'utf8', windowsHide: true });
  if (ac.status !== 0 || dc.status !== 0) return false;
  const activate = spawnSync('powercfg.exe', ['/setactive', 'SCHEME_CURRENT'], {
    encoding: 'utf8', windowsHide: true
  });
  return activate.status === 0;
}

function setTemporaryLidAction(enabled) {
  if (enabled) {
    if (preferences.lidActionBackup) {
      return applyLidActionValues({ ac: 0, dc: 0 });
    }
    const query = spawnSync('powercfg.exe', [
      '/query', 'SCHEME_CURRENT', 'SUB_BUTTONS', 'LIDACTION'
    ], { encoding: 'utf8', windowsHide: true });
    if (query.status !== 0) return false;
    const acMatch = /Current AC Power Setting Index:\s*0x([0-9a-f]+)/i.exec(query.stdout || '');
    const dcMatch = /Current DC Power Setting Index:\s*0x([0-9a-f]+)/i.exec(query.stdout || '');
    if (!acMatch || !dcMatch) return false;
    const original = { ac: parseInt(acMatch[1], 16), dc: parseInt(dcMatch[1], 16) };
    preferences.lidActionBackup = original;
    setStartup(preferences.startWithWindows);
    if (applyLidActionValues({ ac: 0, dc: 0 })) return true;
    const restored = applyLidActionValues(original);
    if (restored) {
      preferences.lidActionBackup = null;
      setStartup(preferences.startWithWindows);
    }
    return false;
  }
  const original = preferences.lidActionBackup;
  if (!original) return true;
  if (!applyLidActionValues(original)) return false;
  preferences.lidActionBackup = null;
  setStartup(preferences.startWithWindows);
  return true;
}

function setSystemAwakeRequest(enabled) {
  if (enabled) {
    if (!setTemporaryLidAction(true)) {
      console.warn('Only Us could not temporarily change the lid-close power action. Closed-lid audio depends on Windows power settings.');
    }
    if (monitorPowerRequest && !monitorPowerRequest.killed) return;
    const script = [
      "$source = 'using System; using System.Runtime.InteropServices; public static class OnlyUsExecutionState { [DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint flags); }'",
      'Add-Type -TypeDefinition $source -ErrorAction Stop',
      "$flags = [uint32]::Parse('2147483649')",
      'while ($true) { [OnlyUsExecutionState]::SetThreadExecutionState($flags) | Out-Null; Start-Sleep -Seconds 30 }'
    ].join(String.fromCharCode(10));
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore'
    });
    monitorPowerRequest = child;
    child.on('exit', () => { if (monitorPowerRequest === child) monitorPowerRequest = null; });
    child.on('error', () => { if (monitorPowerRequest === child) monitorPowerRequest = null; });
    return;
  }
  const child = monitorPowerRequest;
  monitorPowerRequest = null;
  if (child) { try { child.kill(); } catch {} }
  if (!setTemporaryLidAction(false)) {
    console.warn('Only Us could not restore the prior lid-close power action.');
  }
}

function setMicMonitorActivity(active) {
  const next = Boolean(active) && preferences.allowPhoneMicMonitor === true;
  const changed = next !== micMonitorActive;
  micMonitorActive = next;
  setSystemAwakeRequest(preferences.allowPhoneMicMonitor || next);
  if (tray) tray.setToolTip(next
    ? 'Only Us · MIC ACTIVE · your paired phone is listening'
    : preferences.allowPhoneMicMonitor
      ? 'Only Us · mic ready · microphone is off until requested'
      : 'Only Us · Private calls and messages');
  refreshTrayMenu();
  if (changed && next && Notification.isSupported()) {
    const notice = new Notification({
      title: 'Only Us · Microphone active',
      body: 'Your paired phone is listening to this laptop. Stop the session in Only Us or turn microphone access off.',
      silent: true
    });
    notice.show();
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
  refreshTrayMenu = () => {
    const startup = preferences.startWithWindows;
    const micPermission = preferences.allowPhoneMicMonitor === true;
    tray.setToolTip(micMonitorActive
      ? 'Only Us · MIC ACTIVE · your paired phone is listening'
      : 'Only Us · Private calls and messages');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Only Us', click: showWindow },
      { type: 'separator' },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: startup,
        click: item => setStartup(item.checked)
      },
      {
        label: micMonitorActive ? 'MIC ACTIVE · phone listening' : 'Microphone sharing inactive',
        enabled: false
      },
      {
        label: 'Allow phone to listen to laptop mic',
        type: 'checkbox',
        checked: micPermission,
        click: item => setMicMonitorPermission(item.checked)
      },
      { type: 'separator' },
      { label: 'Exit Only Us', click: () => { allowQuit = true; app.quit(); } }
    ]));
  };
  refreshTrayMenu();
  tray.on('click', showWindow);
  tray.on('right-click', refreshTrayMenu);
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
    setSystemAwakeRequest(preferences.allowPhoneMicMonitor);

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
    ipcMain.handle('onlyus:get-mic-monitor', event =>
      originAllowed(event.sender.getURL()) && preferences.allowPhoneMicMonitor === true);
    ipcMain.handle('onlyus:set-mic-monitor', (event, enabled) => {
      if (!originAllowed(event.sender.getURL())) return false;
      return setMicMonitorPermission(enabled);
    });
    ipcMain.on('onlyus:mic-monitor-activity', (event, enabled) => {
      if (!originAllowed(event.sender.getURL())) return;
      if (Boolean(enabled) && preferences.allowPhoneMicMonitor !== true) return;
      setMicMonitorActivity(enabled);
    });
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
    micMonitorActive = false;
    setSystemAwakeRequest(false);
    if (powerBlockerId !== null) {
      try { powerSaveBlocker.stop(powerBlockerId); } catch {}
      powerBlockerId = null;
    }
    if (tray) { tray.destroy(); tray = null; }
    if (server) { try { server.close(); } catch {} }
  });
}
