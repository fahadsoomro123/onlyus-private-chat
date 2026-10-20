import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';

const TOKEN = 'test-only-pairing-token-0123456789abcdef0123456789';
const TIMEOUT_MS = 5000;

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(url, child) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error('Backend exited early: ' + child.exitCode);
    try {
      const response = await fetch(url + '/healthz', { signal: AbortSignal.timeout(1000) });
      if (response.ok) return response.json();
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Backend health endpoint did not become ready.');
}

function nextMessage(socket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Timed out waiting for WebSocket message.')), TIMEOUT_MS);
    const onMessage = raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (predicate(message)) finish(null, message);
    };
    const onClose = () => finish(new Error('WebSocket closed before expected message.'));
    function finish(error, value) {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('close', onClose);
      if (error) reject(error);
      else resolve(value);
    }
    socket.on('message', onMessage);
    socket.once('close', onClose);
  });
}

async function connectDevice(url, device, token = TOKEN) {
  const socket = new WebSocket(url + '/ws');
  await once(socket, 'open');
  const connected = nextMessage(socket, message => message.type === 'connected');
  socket.send(JSON.stringify({ type: 'auth', device, token }));
  await connected;
  return socket;
}

test('backend health, authentication, and paired WebRTC signaling work', async t => {
  const port = await freePort();
  const url = 'http://127.0.0.1:' + port;
  const childEnv = { ...process.env, PORT: String(port), ONLYUS_PAIR_TOKEN: TOKEN };
  for (const key of ['FIREBASE_SERVICE_ACCOUNT_JSON', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'K_SERVICE']) {
    delete childEnv[key];
  }
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk.toString(); });
  child.stderr.on('data', chunk => { logs += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([once(child, 'exit').catch(() => {}), new Promise(resolve => setTimeout(resolve, 1500))]);
  });

  const health = await waitForHealth(url, child);
  assert.equal(health.ok, true);

  const denied = await fetch(url + '/v1/ice', {
    headers: { Authorization: 'Bearer wrong-token' }
  });
  assert.equal(denied.status, 401);

  const phone = await connectDevice(url, 'phone');
  const desktop = await connectDevice(url, 'desktop');
  t.after(() => {
    try { phone.close(); } catch {}
    try { desktop.close(); } catch {}
  });

  const rtcId = 'rtc_test_123456';
  const callId = 'call_test_123456';
  const offer = { type: 'offer', sdp: 'v=0\\r\\no=- test' };
  const receivedOffer = nextMessage(desktop, message =>
    message.type === 'signal' && message.signalType === 'offer' && message.rtcId === rtcId);
  phone.send(JSON.stringify({
    type: 'signal', signalType: 'offer', rtcId, callId,
    metadata: { kind: 'media', callId, from: 'phone' }, signal: offer
  }));
  const offerMessage = await receivedOffer;
  assert.equal(offerMessage.callId, callId);
  assert.equal(offerMessage.metadata.kind, 'media');
  assert.equal(offerMessage.signal.sdp, offer.sdp);

  const answer = { type: 'answer', sdp: 'v=0\\r\\no=- answer' };
  const receivedAnswer = nextMessage(phone, message =>
    message.type === 'signal' && message.signalType === 'answer' && message.rtcId === rtcId);
  desktop.send(JSON.stringify({
    type: 'signal', signalType: 'answer', rtcId, callId,
    signal: answer
  }));
  assert.equal((await receivedAnswer).signal.sdp, answer.sdp);

  const candidate = { candidate: 'candidate:test', sdpMid: '0', sdpMLineIndex: 0 };
  const receivedCandidate = nextMessage(desktop, message =>
    message.type === 'signal' && message.signalType === 'ice' && message.rtcId === rtcId);
  phone.send(JSON.stringify({
    type: 'signal', signalType: 'ice', rtcId, callId, signal: candidate
  }));
  assert.equal((await receivedCandidate).signal.candidate, candidate.candidate);

  const receivedCancel = nextMessage(phone, message =>
    message.type === 'signal' && message.signalType === 'cancel' && message.rtcId === rtcId);
  desktop.send(JSON.stringify({
    type: 'signal', signalType: 'cancel', rtcId, callId, signal: { reason: 'closed' }
  }));
  assert.equal((await receivedCancel).callId, callId);
  assert.match(logs, /Only Us backend listening/);
});
