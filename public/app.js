'use strict';

const $ = (id) => document.getElementById(id);
const PROFILE_KEY = 'onlyus.profile.v1';
const MESSAGE_KEY = 'onlyus.messages.v1';
const MAX_MESSAGES = 500;
const ROLE_LABELS = { fahad: 'Fahad', wife: 'Wife' };

let settings = null;
let role = null;
let peer = null;
let dataConnection = null;
let dialTimer = null;
let activeCall = null;
let incomingCall = null;
let localAudioStream = null;
let messages = loadMessages();
let toastTimer = null;
let ringtoneContext = null;
let ringtoneTimer = null;
let ringtoneActive = false;

function partnerRole() { return role === 'fahad' ? 'wife' : 'fahad'; }
function labelFor(value) { return ROLE_LABELS[value] || 'Partner'; }
function otherPeerId() { return 'onlyus-' + partnerRole() + '-' + settings.roomKey; }
function localPeerId() { return 'onlyus-' + role + '-' + settings.roomKey; }
function setStatus(text, online = false) {
  const status = $('connectionStatus');
  status.classList.toggle('online', online);
  status.querySelector('span').textContent = text;
  $('deliveryHint').textContent = online
    ? 'Connected directly. Messages and calls stay between your two devices.'
    : 'Offline: messages stay saved here until your partner opens Only Us.';
}
function showToast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3600);
}

function unlockRingtoneAudio() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!ringtoneContext) ringtoneContext = new AudioContextClass();
    if (ringtoneContext.state === 'suspended') ringtoneContext.resume().catch(() => {});
  } catch {}
}

function playRingtoneBurst() {
  if (!ringtoneActive || !ringtoneContext) return;
  try {
    const ctx = ringtoneContext;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const ringOne = (offset, duration) => {
      const startAt = ctx.currentTime + offset;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.linearRampToValueAtTime(0.075, startAt + 0.035);
      gain.gain.setValueAtTime(0.075, startAt + duration - 0.06);
      gain.gain.linearRampToValueAtTime(0.0001, startAt + duration);
      gain.connect(ctx.destination);
      for (const frequency of [440, 480]) {
        const oscillator = ctx.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequency, startAt);
        oscillator.connect(gain);
        oscillator.start(startAt);
        oscillator.stop(startAt + duration + 0.015);
      }
      setTimeout(() => { try { gain.disconnect(); } catch {} }, Math.ceil((offset + duration + 0.1) * 1000));
    };
    ringOne(0, 0.38);
    ringOne(0.48, 0.38);
  } catch {}
}

function startRingtone() {
  unlockRingtoneAudio();
  if (!ringtoneContext || ringtoneActive) return;
  ringtoneActive = true;
  $('callPanel').dataset.ringing = 'true';
  $('callDescription').textContent = labelFor(partnerRole()) + ' is calling you. Ringing…';
  playRingtoneBurst();
  ringtoneTimer = setInterval(playRingtoneBurst, 1900);
}

function stopRingtone() {
  ringtoneActive = false;
  if (ringtoneTimer) clearInterval(ringtoneTimer);
  ringtoneTimer = null;
  if ($('callPanel')) delete $('callPanel').dataset.ringing;
}
function loadMessages() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MESSAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.slice(-MAX_MESSAGES) : [];
  } catch { return []; }
}
function saveMessages() {
  messages = messages.slice(-MAX_MESSAGES);
  try { localStorage.setItem(MESSAGE_KEY, JSON.stringify(messages)); } catch {}
}
function makeId() {
  return (globalThis.crypto && typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}
function normalizeMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || raw.id.length > 100) return null;
  if (!['fahad', 'wife'].includes(raw.author)) return null;
  if (typeof raw.text !== 'string' || !raw.text.trim()) return null;
  const text = raw.text.slice(0, 2000);
  const createdAt = Number.isFinite(Date.parse(raw.createdAt)) ? new Date(raw.createdAt).toISOString() : new Date().toISOString();
  return { id: raw.id, author: raw.author, text, createdAt, delivered: Boolean(raw.delivered) };
}
function mergeMessages(incoming) {
  const byId = new Map(messages.map(item => [item.id, item]));
  let changed = false;
  for (const raw of incoming || []) {
    const item = normalizeMessage(raw);
    if (!item) continue;
    const existing = byId.get(item.id);
    if (!existing) { byId.set(item.id, item); changed = true; }
  }
  if (changed) {
    messages = Array.from(byId.values()).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).slice(-MAX_MESSAGES);
    saveMessages();
    renderMessages();
  }
}
function renderMessages() {
  const container = $('messages');
  container.replaceChildren();
  if (!messages.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Your conversation starts here. Send a message whenever you feel like talking.';
    container.appendChild(empty);
    return;
  }
  for (const msg of messages) {
    const row = document.createElement('div');
    row.className = 'message-row' + (msg.author === role ? ' mine' : '');
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.textContent = msg.text;
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const time = document.createElement('span');
    try { time.textContent = new Intl.DateTimeFormat('en-PK', { hour: 'numeric', minute: '2-digit' }).format(new Date(msg.createdAt)); }
    catch { time.textContent = ''; }
    meta.appendChild(time);
    if (msg.author === role) {
      const state = document.createElement('span');
      state.className = 'message-state';
      state.textContent = msg.delivered ? 'Delivered' : 'Waiting to send';
      meta.appendChild(state);
    }
    row.append(bubble, meta);
    container.appendChild(row);
  }
  container.scrollTop = container.scrollHeight;
}
function sendPayload(payload) {
  if (!dataConnection || !dataConnection.open) return false;
  try { dataConnection.send(payload); return true; }
  catch { return false; }
}
function sendSync() {
  sendPayload({ type: 'sync', messages: messages.slice(-250) });
}
function handlePayload(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (payload.type === 'sync' && Array.isArray(payload.messages)) {
    const received = payload.messages.map(normalizeMessage).filter(Boolean);
    mergeMessages(received);
    sendPayload({ type: 'ack', ids: received.map(m => m.id).slice(0, 500) });
    return;
  }
  if (payload.type === 'chat') {
    const msg = normalizeMessage(payload.message);
    if (!msg || msg.author === role) return;
    mergeMessages([msg]);
    sendPayload({ type: 'ack', ids: [msg.id] });
    return;
  }
  if (payload.type === 'ack' && Array.isArray(payload.ids)) {
    const ids = new Set(payload.ids.filter(id => typeof id === 'string'));
    let changed = false;
    messages = messages.map(msg => {
      if (msg.author === role && ids.has(msg.id) && !msg.delivered) {
        changed = true;
        return { ...msg, delivered: true };
      }
      return msg;
    });
    if (changed) { saveMessages(); renderMessages(); }
  }
}
function attachDataConnection(conn) {
  if (dataConnection && dataConnection !== conn && dataConnection.open) {
    try { conn.close(); } catch {}
    return;
  }
  dataConnection = conn;
  conn.on('open', () => {
    if (dataConnection !== conn) return;
    setStatus(labelFor(partnerRole()) + ' is online', true);
    sendSync();
    renderMessages();
  });
  conn.on('data', handlePayload);
  conn.on('close', () => {
    if (dataConnection === conn) {
      dataConnection = null;
      setStatus('Waiting for ' + labelFor(partnerRole()));
    }
  });
  conn.on('error', () => {
    if (dataConnection === conn && !conn.open) {
      dataConnection = null;
      setStatus('Reconnecting…');
    }
  });
  if (conn.open) setStatus(labelFor(partnerRole()) + ' is online', true);
}
function startDialLoop() {
  if (role !== 'fahad' || dialTimer) return;
  const attempt = () => {
    if (!peer || peer.destroyed || !peer.open) return;
    if (dataConnection && dataConnection.open) return; if (dataConnection) { try { dataConnection.close(); } catch {} dataConnection = null; }
    try {
      const conn = peer.connect(otherPeerId(), { reliable: true, serialization: 'json' });
      attachDataConnection(conn);
      conn.on('error', () => { if (dataConnection === conn) dataConnection = null; });
    } catch {}
  };
  attempt();
  dialTimer = setInterval(attempt, 7000);
}
function initRole(selectedRole) {
  if (!settings || !['fahad', 'wife'].includes(selectedRole) || !window.Peer) {
    showToast('The app could not start. Close it and try again with an Internet connection.');
    return;
  }
  unlockRingtoneAudio();
  if (peer) { try { peer.destroy(); } catch {} }
  if (dialTimer) { clearInterval(dialTimer); dialTimer = null; }
  endCall(false);
  role = selectedRole;
  localStorage.setItem(PROFILE_KEY, role);
  $('profileScreen').hidden = true;
  $('chatScreen').hidden = false;
  $('partnerName').textContent = labelFor(partnerRole());
  $('partnerAvatar').textContent = partnerRole() === 'wife' ? 'W' : 'F';
  $('partnerAvatar').className = 'avatar ' + (partnerRole() === 'wife' ? 'avatar-pink' : 'avatar-blue');
  $('callButton').setAttribute('aria-label', 'Call ' + labelFor(partnerRole()));
  renderMessages();
  setStatus('Connecting to private network…');
  try {
    peer = new Peer(localPeerId(), {
      host: settings.peerHost || '0.peerjs.com',
      port: Number(settings.peerPort || 443),
      secure: true,
      config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
      debug: 1
    });
  } catch {
    setStatus('Could not start connection');
    showToast('Connection setup failed. Check the Internet connection.');
    return;
  }
  peer.on('open', () => {
    setStatus('Waiting for ' + labelFor(partnerRole()));
    if (role === 'fahad') startDialLoop();
  });
  peer.on('connection', conn => {
    if (role === 'wife') attachDataConnection(conn);
    else { try { conn.close(); } catch {} }
  });
  peer.on('call', call => {
    if (activeCall || incomingCall) { try { call.close(); } catch {} return; }
    incomingCall = call;
    $('callPanel').hidden = false;
    $('callTitle').textContent = 'Incoming voice call';
    $('callDescription').textContent = labelFor(partnerRole()) + ' is calling you.';
    $('incomingActions').hidden = false;
    $('activeActions').hidden = true;
    call.on('close', () => {
      if (incomingCall === call && !activeCall) {
        stopRingtone();
        finishCallUi();
      }
    });
    call.on('error', () => {
      if (incomingCall === call && !activeCall) {
        stopRingtone();
        finishCallUi();
        showToast('The incoming call ended or could not connect.');
      }
    });
    startRingtone();
  });
  peer.on('disconnected', () => setStatus('Reconnecting to private network…'));
  peer.on('error', err => {
    if (err && err.type === 'unavailable-id') {
      setStatus('This profile is already open on another device');
      showToast('This name is already active. Use Fahad on the phone and Wife on the laptop.');
    } else if (err && err.type === 'peer-unavailable') {
      setStatus('Waiting for ' + labelFor(partnerRole()));
    } else {
      setStatus('Waiting for ' + labelFor(partnerRole()));
    }
  });
}
async function getMicrophone() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('This device does not allow microphone access here. Open Only Us in the app or a current browser.');
  }
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
}
function showActiveCall(title, description) {
  $('callPanel').hidden = false;
  $('callTitle').textContent = title;
  $('callDescription').textContent = description;
  $('incomingActions').hidden = true;
  $('activeActions').hidden = false;
}
function wireCall(call) {
  call.on('stream', stream => {
    $('remoteAudio').srcObject = stream;
    const p = $('remoteAudio').play();
    if (p && typeof p.catch === 'function') p.catch(() => showToast('Tap the call panel once to enable speaker audio.'));
    showActiveCall('In call with ' + labelFor(partnerRole()), 'Voice call is connected. Microphone is on.');
  });
  call.on('close', () => {
    if (activeCall === call || incomingCall === call) finishCallUi();
  });
  call.on('error', err => {
    const text = err && err.type === 'peer-unavailable'
      ? labelFor(partnerRole()) + ' is not online yet.'
      : 'The call could not connect. Try again.';
    showToast(text);
    if (activeCall === call || incomingCall === call) finishCallUi();
  });
}
async function startCall() {
  if (!peer || !peer.open) { showToast('Connecting to the private network. Try again in a moment.'); return; }
  if (activeCall || incomingCall) return;
  stopRingtone();
  try {
    localAudioStream = await getMicrophone();
    const call = peer.call(otherPeerId(), localAudioStream, { metadata: { from: role, label: labelFor(role) } });
    if (!call) throw new Error('Could not start call.');
    activeCall = call;
    showActiveCall('Calling ' + labelFor(partnerRole()) + '…', 'Waiting for an answer.');
    wireCall(call);
  } catch (error) {
    stopLocalAudio();
    showToast(error && error.message ? error.message : 'Microphone permission is needed for a voice call.');
  }
}
async function acceptCall() {
  if (!incomingCall) return;
  const call = incomingCall;
  stopRingtone();
  try {
    localAudioStream = await getMicrophone();
    activeCall = call;
    call.answer(localAudioStream);
    showActiveCall('Connecting call…', 'Please wait a moment.');
    wireCall(call);
  } catch (error) {
    showToast(error && error.message ? error.message : 'Microphone permission is needed to answer.');
    try { call.close(); } catch {}
    finishCallUi();
  }
}
function stopLocalAudio() {
  if (localAudioStream) {
    for (const track of localAudioStream.getTracks()) track.stop();
    localAudioStream = null;
  }
  $('remoteAudio').srcObject = null;
}
function finishCallUi() {
  stopRingtone();
  activeCall = null;
  incomingCall = null;
  stopLocalAudio();
  $('callPanel').hidden = true;
  $('incomingActions').hidden = false;
  $('activeActions').hidden = true;
}
function endCall(closeRemote = true) {
  stopRingtone();
  const call = activeCall || incomingCall;
  activeCall = null;
  incomingCall = null;
  if (closeRemote && call) { try { call.close(); } catch {} }
  stopLocalAudio();
  if ($('callPanel')) {
    $('callPanel').hidden = true;
    $('incomingActions').hidden = false;
    $('activeActions').hidden = true;
  }
}
function sendMessage(text) {
  const msg = { id: makeId(), author: role, text: text.trim().slice(0, 2000), createdAt: new Date().toISOString(), delivered: false };
  messages.push(msg);
  saveMessages();
  renderMessages();
  if (dataConnection && dataConnection.open) sendPayload({ type: 'chat', message: msg });
}

document.querySelectorAll('[data-role]').forEach(button => button.addEventListener('click', () => initRole(button.dataset.role)));
$('changeProfile').addEventListener('click', () => {
  stopRingtone();
  endCall();
  if (peer) { try { peer.destroy(); } catch {} peer = null; }
  if (dialTimer) { clearInterval(dialTimer); dialTimer = null; }
  dataConnection = null;
  localStorage.removeItem(PROFILE_KEY);
  role = null;
  $('chatScreen').hidden = true;
  $('profileScreen').hidden = false;
});
$('messageForm').addEventListener('submit', event => {
  event.preventDefault();
  const input = $('messageInput');
  const text = input.value.trim();
  if (!text || !role) return;
  sendMessage(text);
  input.value = '';
});
$('callButton').addEventListener('click', startCall);
$('acceptButton').addEventListener('click', acceptCall);
$('declineButton').addEventListener('click', () => {
  if (incomingCall) { try { incomingCall.close(); } catch {} }
  finishCallUi();
});
$('endCallButton').addEventListener('click', () => endCall(true));
document.addEventListener('pointerdown', unlockRingtoneAudio, { once: true, passive: true });

(async function bootstrap() {
  try {
    const response = await fetch('pair-config.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('pair config unavailable');
    settings = await response.json();
    if (typeof settings.roomKey !== 'string' || !/^[a-f0-9]{48}$/.test(settings.roomKey)) throw new Error('invalid pairing config');
    const savedRole = localStorage.getItem(PROFILE_KEY);
    if (['fahad', 'wife'].includes(savedRole)) initRole(savedRole);
  } catch {
    $('profileStatus').textContent = 'Setup could not load. Close the app and check its files.';
    showToast('Only Us setup could not load.');
  }
})();
