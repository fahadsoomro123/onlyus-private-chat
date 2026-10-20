'use strict';

const $ = (id) => document.getElementById(id);
const PROFILE_KEY = 'onlyus.profile.v1';
const ROOM_KEY = 'onlyus.room-key.v1';
const MESSAGE_KEY = 'onlyus.messages.v1';
const MAX_MESSAGES = 500;
const ROLE_LABELS = { fahad: 'Fahad', wife: 'Wife' };

let settings = null;
let role = null;
let peer = null;
let dataConnection = null;
let dialTimer = null;
let peerRetryTimer = null;
let peerRetryCount = 0;
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
      gain.gain.linearRampToValueAtTime(0.85, startAt + 0.035);
      gain.gain.setValueAtTime(0.85, startAt + duration - 0.06);
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
  if (ringtoneActive) return;
  ringtoneActive = true;
  // Native rings use the phone's ringtone volume and continue if the app is backgrounded.
  try { window.AndroidOnlyUs?.incomingCall?.(); } catch {}
  try { window.onlyUsDesktop?.incomingCall?.(); } catch {}
  $('callPanel').dataset.ringing = 'true';
  $('callDescription').textContent = labelFor(partnerRole()) + ' is calling you. Ringing…';
  if (!ringtoneContext) return;
  playRingtoneBurst();
  ringtoneTimer = setInterval(playRingtoneBurst, 1900);
}

function stopRingtone() {
  ringtoneActive = false;
  if (ringtoneTimer) clearInterval(ringtoneTimer);
  ringtoneTimer = null;
  try { window.AndroidOnlyUs?.callEnded?.(); } catch {}
  try { window.onlyUsDesktop?.callEnded?.(); } catch {}
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
    if (dataConnection && dataConnection.open) return;
    if (dataConnection) {
      const age = Date.now() - Number(dataConnection.__onlyUsStartedAt || 0);
      // Do not keep cancelling a slow connection every seven seconds.
      if (age < 20000) return;
      try { dataConnection.close(); } catch {}
      dataConnection = null;
    }
    try {
      const conn = peer.connect(otherPeerId(), { reliable: true, serialization: 'json' });
      conn.__onlyUsStartedAt = Date.now();
      attachDataConnection(conn);
      conn.on('error', () => { if (dataConnection === conn) dataConnection = null; });
    } catch {}
  };
  attempt();
  dialTimer = setInterval(attempt, 7000);
}
function schedulePeerRestart(reason) {
  if (!role || peerRetryTimer) return;
  const roleToRestore = role;
  const waitMs = Math.min(30000, 1500 * (2 ** Math.min(peerRetryCount, 4)));
  peerRetryCount += 1;
  if (dialTimer) { clearInterval(dialTimer); dialTimer = null; }
  if (dataConnection) { try { dataConnection.close(); } catch {} dataConnection = null; }
  setStatus('Connection error (' + reason + '). Retrying…');
  peerRetryTimer = setTimeout(() => {
    peerRetryTimer = null;
    if (role === roleToRestore) initRole(roleToRestore);
  }, waitMs);
}

function initRole(selectedRole) {
  if (peerRetryTimer) { clearTimeout(peerRetryTimer); peerRetryTimer = null; }
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
      config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }] },
      debug: 1
    });
  } catch {
    setStatus('Could not start connection');
    showToast('Connection setup failed. Check the Internet connection.');
    return;
  }
  peer.on('open', () => {
    peerRetryCount = 0;
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
    try { window.onlyUsDesktop?.incomingCall?.(); } catch {}
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
  peer.on('disconnected', () => {
    setStatus('Reconnecting to private network…');
    // Re-open the PeerJS signalling connection after a transient server drop.
    // Without this, the UI can remain stuck on “Reconnecting…” indefinitely.
    if (peer && !peer.destroyed) {
      try { peer.reconnect(); } catch {}
    }
  });
  peer.on('error', err => {
    const type = err && typeof err.type === 'string' ? err.type : 'unknown';
    console.error('Only Us signalling error:', type, err);
    if (type === 'unavailable-id') {
      setStatus('This profile is already open on another device');
      showToast('Only one Wife profile and one Fahad profile can be active at a time.');
    } else if (type === 'peer-unavailable') {
      setStatus('Waiting for ' + labelFor(partnerRole()));
    } else if (['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected'].includes(type)) {
      schedulePeerRestart(type);
    } else if (type === 'webrtc') {
      setStatus('Device-to-device connection failed (webrtc)');
      showToast('The network blocked the direct connection. A TURN relay may be needed.');
    } else {
      setStatus('Connection error (' + type + ')');
      showToast('Only Us connection error: ' + type);
    }
  });
}
async function getMicrophone() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const error = new Error('Microphone access is unavailable in this app.');
    error.name = 'NotSupportedError';
    throw error;
  }

  // Some Android WebView/audio-driver combinations fail while opening AudioRecord
  // with processing constraints. Retry using simpler capture constraints.
  const attempts = [
    { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false },
    { audio: { echoCancellation: true }, video: false },
    { audio: true, video: false }
  ];
  let lastError;
  for (let index = 0; index < attempts.length; index += 1) {
    try {
      return await navigator.mediaDevices.getUserMedia(attempts[index]);
    } catch (error) {
      lastError = error;
      const retryable = ['NotReadableError', 'AbortError', 'OverconstrainedError'].includes(error && error.name);
      if (!retryable || index === attempts.length - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw lastError || new Error('Could not access the microphone.');
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
    console.error('Only Us microphone capture failed:', error && error.name, error && error.message);
    const name = error && error.name ? error.name : 'UnknownError';
    const guidance = name === 'NotReadableError'
      ? 'Phone could not open its microphone. Close other voice/recording apps and check Only Us microphone permission.'
      : name === 'NotAllowedError' || name === 'SecurityError'
        ? 'Allow microphone permission for Only Us in Android Settings.'
        : 'Microphone failed to start. Check Android microphone permission and try again.';
    showToast(guidance + ' (' + name + ')');
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
    console.error('Only Us microphone capture failed while answering:', error && error.name, error && error.message);
    const name = error && error.name ? error.name : 'UnknownError';
    const guidance = name === 'NotReadableError'
      ? 'Phone could not open its microphone. Close other voice/recording apps and check Only Us microphone permission.'
      : name === 'NotAllowedError' || name === 'SecurityError'
        ? 'Allow microphone permission for Only Us in Android Settings.'
        : 'Microphone failed to start. Check Android microphone permission and try again.';
    showToast(guidance + ' (' + name + ')');
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
  try { window.onlyUsDesktop?.callEnded?.(); } catch {}
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

document.querySelectorAll('[data-role]').forEach(button => button.addEventListener('click', () => {
  if (!settings) { showToast('Enter your private pairing key first.'); $('pairCode').focus(); return; }
  initRole(button.dataset.role);
}));
$('pairSetupForm').addEventListener('submit', event => {
  event.preventDefault();
  const roomKey = $('pairCode').value.trim().toLowerCase();
  if (!/^[a-f0-9]{48}$/.test(roomKey)) {
    $('pairSetupError').textContent = 'That key is not valid. Copy all 48 characters and try again.';
    return;
  }
  settings = { roomKey };
  localStorage.setItem(ROOM_KEY, roomKey);
  $('pairSetup').hidden = true;
  $('pairSetupError').textContent = '';
  $('profileStatus').textContent = 'Private pairing key saved in this browser.';
  const savedRole = localStorage.getItem(PROFILE_KEY);
  if (['fahad', 'wife'].includes(savedRole)) initRole(savedRole);
});
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
  let configured = false;
  try {
    const response = await fetch('pair-config.json', { cache: 'no-store' });
    if (response.ok) {
      const candidate = await response.json();
      if (candidate && typeof candidate.roomKey === 'string' && /^[a-f0-9]{48}$/.test(candidate.roomKey)) {
        settings = candidate;
        configured = true;
      }
    }
  } catch {}

  if (!configured) {
    const savedKey = localStorage.getItem(ROOM_KEY) || '';
    if (/^[a-f0-9]{48}$/.test(savedKey)) {
      settings = { roomKey: savedKey };
      configured = true;
    }
  }

  if (!configured) {
    $('pairSetup').hidden = false;
    $('profileStatus').textContent = 'Enter your private pairing key to connect this browser to your phone.';
    return;
  }

  const savedRole = localStorage.getItem(PROFILE_KEY);
  if (['fahad', 'wife'].includes(savedRole)) initRole(savedRole);
})();
