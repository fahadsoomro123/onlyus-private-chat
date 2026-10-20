import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { getFirestore } from 'firebase-admin/firestore';

const PORT = Number(process.env.PORT || 8787);
const PAIR_TOKEN = process.env.ONLYUS_PAIR_TOKEN || '';
const ALLOWED_ORIGINS = new Set(
  (process.env.ONLYUS_ALLOWED_ORIGINS ||
    'https://appassets.androidplatform.net,http://127.0.0.1:4178,http://localhost:4178')
    .split(',').map(value => value.trim()).filter(Boolean)
);
const MAX_BODY_BYTES = 16 * 1024;

if (PAIR_TOKEN.length < 32) {
  console.error('ONLYUS_PAIR_TOKEN must be a private random value of at least 32 characters.');
  process.exit(1);
}

let state = { phoneFcmToken: null, updatedAt: null };
try {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (saved && typeof saved === 'object') state = { ...state, ...saved };
} catch (error) {
  if (error.code !== 'ENOENT') {
    console.error('Could not read device state:', error.message);
    process.exit(1);
  }
}

let messaging = null;
let firestore = null;
try {
  if (getApps().length) {
    messaging = getMessaging();
    firestore = getFirestore();
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    initializeApp({ credential: cert(serviceAccount) });
    messaging = getMessaging();
    firestore = getFirestore();
  } else {
    initializeApp({ credential: applicationDefault() });
    messaging = getMessaging();
    firestore = getFirestore();
  }
} catch (error) {
  console.warn('Firebase push is not configured yet:', error.message);
}

const connected = new Map();
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.writeHead(origin && !ALLOWED_ORIGINS.has(origin) ? 403 : 204).end();
    return;
  }

  const url = new URL(req.url || '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/healthz') {
    return json(res, 200, {
      ok: true,
      pushConfigured: Boolean(messaging),
      phoneRegistered: Boolean(state.phoneFcmToken),
      desktopConnected: isOpen(connected.get('desktop')),
      phoneSocketConnected: isOpen(connected.get('phone'))
    });
  }

  if (!['/v1/register-phone', '/v1/unregister-phone', '/v1/ice', '/v1/call'].includes(url.pathname)) {
    return json(res, 404, { error: 'not_found' });
  }
  if (!authorized(req.headers.authorization)) {
    return json(res, 401, { error: 'unauthorized' });
  }

  if (req.method === 'GET' && url.pathname === '/v1/ice') {
    return json(res, 200, { iceServers: buildIceServers() });
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return json(res, error.statusCode || 400, { error: error.message || 'invalid_json' });
  }

  if (url.pathname === '/v1/register-phone') {
    if (typeof body.fcmToken !== 'string' || body.fcmToken.length < 20 || body.fcmToken.length > 4096) {
      return json(res, 400, { error: 'invalid_fcm_token' });
    }
    state.phoneFcmToken = body.fcmToken;
    state.updatedAt = new Date().toISOString();
    try {
      if (!firestore) return json(res, 503, { error: 'firebase_not_configured' });
      await firestore.collection('onlyus_devices').doc('phone').set({
        fcmToken: state.phoneFcmToken,
        updatedAt: state.updatedAt
      });
    } catch (error) {
      console.error('Could not persist the phone token:', error.message);
      return json(res, 500, { error: 'state_write_failed' });
    }
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/v1/unregister-phone') {
    state.phoneFcmToken = null;
    state.updatedAt = new Date().toISOString();
    try {
      if (!firestore) return json(res, 503, { error: 'firebase_not_configured' });
      await firestore.collection('onlyus_devices').doc('phone').set({
        fcmToken: null,
        updatedAt: state.updatedAt
      });
    } catch (error) {
      return json(res, 500, { error: 'state_write_failed' });
    }
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/v1/call') {
    const allowedEvents = new Set(['ringing', 'accepted', 'rejected', 'ended', 'missed']);
    if (!['phone', 'desktop'].includes(body.from) ||
        typeof body.callId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(body.callId) ||
        !allowedEvents.has(body.event)) {
      return json(res, 400, { error: 'invalid_call_event' });
    }

    const event = {
      type: 'call_event',
      event: body.event,
      callId: body.callId,
      from: body.from,
      at: Date.now()
    };
    const recipient = body.from === 'phone' ? 'desktop' : 'phone';
    const wsDelivered = sendTo(recipient, event);
    let pushDelivered = false;

    if (recipient === 'phone' && state.phoneFcmToken && messaging) {
      try {
        await messaging.send({
          token: state.phoneFcmToken,
          data: {
            type: 'incoming_call',
            event: body.event,
            callId: body.callId,
            caller: body.from === 'desktop' ? 'Wife' : 'Fahad'
          },
          android: { priority: 'high', ttl: 60 * 1000 }
        });
        pushDelivered = true;
      } catch (error) {
        console.error('Phone push delivery failed:', error.code || error.message);
        if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(error.code)) {
          state.phoneFcmToken = null;
          state.updatedAt = new Date().toISOString();
          try {
            if (firestore) await firestore.collection('onlyus_devices').doc('phone').set({
              fcmToken: null, updatedAt: state.updatedAt
            });
          } catch {}
        }
      }
    }

    if (body.event === 'ringing' && recipient === 'phone' && !pushDelivered && !wsDelivered) {
      return json(res, 503, {
        ok: false,
        error: !messaging ? 'push_not_configured' : 'phone_not_reachable',
        wsDelivered,
        pushDelivered
      });
    }

    return json(res, 202, { ok: true, wsDelivered, pushDelivered });
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', ws => {
  let authenticated = false;
  const timeout = setTimeout(() => {
    if (!authenticated) ws.close(4401, 'authentication required');
  }, 5000);

  ws.on('message', raw => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch {
      ws.close(4400, 'invalid message');
      return;
    }

    if (!authenticated) {
      if (message.type !== 'auth' ||
          !['phone', 'desktop'].includes(message.device) ||
          !safeEqual(message.token, PAIR_TOKEN)) {
        ws.close(4401, 'authentication failed');
        return;
      }
      authenticated = true;
      clearTimeout(timeout);
      ws.device = message.device;
      const previous = connected.get(ws.device);
      if (previous && previous !== ws && previous.readyState === WebSocket.OPEN) {
        try { previous.close(4001, 'replaced by a newer connection'); } catch {}
      }
      connected.set(ws.device, ws);
      send(ws, { type: 'connected', device: ws.device, at: Date.now() });
      return;
    }

    if (message.type === 'ping') {
      send(ws, { type: 'pong', at: Date.now() });
      return;
    }
    if (message.type === 'call_event' &&
        typeof message.callId === 'string' &&
        /^[a-zA-Z0-9_-]{8,100}$/.test(message.callId) &&
        ['ringing', 'accepted', 'rejected', 'ended', 'missed'].includes(message.event)) {
      sendTo(ws.device === 'phone' ? 'desktop' : 'phone', {
        type: 'call_event',
        event: message.event,
        callId: message.callId,
        from: ws.device,
        at: Date.now()
      });
    }
  });

  ws.on('close', () => {
    clearTimeout(timeout);
    if (ws.device && connected.get(ws.device) === ws) connected.delete(ws.device);
  });
  ws.on('error', error => console.warn('WebSocket connection error:', error.message));
});

try {
  if (firestore) {
    const saved = await firestore.collection('onlyus_devices').doc('phone').get();
    state.phoneFcmToken = saved.exists ? (saved.data().fcmToken || null) : null;
    state.updatedAt = saved.exists ? (saved.data().updatedAt || null) : null;
  }
} catch (error) {
  console.warn('Could not load saved phone token from Firestore:', error.message);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Only Us backend listening on port ${PORT}.`);
  console.log(`FCM: ${messaging ? 'ready' : 'not configured'}; phone registered: ${Boolean(state.phoneFcmToken)}.`);
});

function authorized(header) {
  const match = /^Bearer\s+(.+)$/i.exec(header || '');
  return Boolean(match && safeEqual(match[1], PAIR_TOKEN));
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function buildIceServers() {
  const result = [{ urls: ['stun:stun.l.google.com:19302'] }];
  const urls = (process.env.ONLYUS_TURN_URLS || '').split(',').map(v => v.trim()).filter(Boolean);
  const secret = process.env.ONLYUS_TURN_SHARED_SECRET || '';
  if (!urls.length || secret.length < 16) return result;

  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const username = `${expiry}:onlyus`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  result.push({ urls, username, credential });
  return result;
}

function isOpen(ws) {
  return Boolean(ws && ws.readyState === WebSocket.OPEN);
}

function sendTo(device, payload) {
  const ws = connected.get(device);
  if (!isOpen(ws)) return false;
  send(ws, payload);
  return true;
}

function send(ws, payload) {
  if (isOpen(ws)) ws.send(JSON.stringify(payload));
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (Buffer.byteLength(data) > MAX_BODY_BYTES) {
      const error = new Error('body_too_large');
      error.statusCode = 413;
      throw error;
    }
  }
  try { return JSON.parse(data || '{}'); } catch {
    const error = new Error('invalid_json');
    error.statusCode = 400;
    throw error;
  }
}
