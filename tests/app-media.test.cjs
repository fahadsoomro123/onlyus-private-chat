const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const start = app.indexOf('function wireCall(call) {');
const end = app.indexOf('\nfunction scheduleOutgoingRetry', start);
assert.ok(start >= 0 && end > start, 'wireCall() test seam must exist');
const wireCallSource = app.slice(start, end);

function createHarness(remoteStream) {
  const audio = { autoplay: false, playsInline: false, muted: true, volume: 0, srcObject: null, playCount: 0,
    play() { this.playCount++; return Promise.resolve(); } };
  const call = { closed: false, metadata: { callId: 'incoming-test-call' }, remoteStream, handlers: new Map(),
    on(name, cb) { if (!this.handlers.has(name)) this.handlers.set(name, []); this.handlers.get(name).push(cb); return this; },
    emit(name, value) { for (const cb of this.handlers.get(name) || []) cb(value); } };
  const context = {
    $: id => id === 'remoteAudio' ? audio : {},
    showToast() {}, showActiveCall() {}, updateDesktopMicUi() {}, clearTimeout() {},
    window: { onlyUsDesktop: null }, role: 'wife', isMicMonitorSession: false, outgoingCallId: null,
    activeCallId: null, outgoingCallConnected: false, outgoingCallMode: 'call', callRetryTimer: null,
    callTimeoutTimer: null, labelFor: role => role === 'fahad' ? 'Fahad' : 'Wife', partnerRole: () => 'fahad'
  };
  vm.createContext(context);
  vm.runInContext(wireCallSource + '\nglobalThis.testWireCall = wireCall;', context);
  context.testWireCall(call);
  return { audio, call };
}

test('replays an incoming audio stream that arrived before call listeners were attached', () => {
  const track = { kind: 'audio', readyState: 'live' };
  const existingStream = { getAudioTracks: () => [track] };
  const { audio } = createHarness(existingStream);
  assert.strictEqual(audio.srcObject, existingStream);
  assert.equal(audio.playCount, 1);
  assert.equal(audio.muted, false);
  assert.equal(audio.volume, 1);
  assert.equal(audio.autoplay, true);
  assert.equal(audio.playsInline, true);
});

test('still attaches a remote audio stream that arrives after listeners are attached', () => {
  const { audio, call } = createHarness({ getAudioTracks: () => [] });
  const laterStream = { getAudioTracks: () => [{ kind: 'audio', readyState: 'live' }] };
  assert.equal(audio.srcObject, null);
  call.emit('stream', laterStream);
  assert.strictEqual(audio.srcObject, laterStream);
  assert.equal(audio.playCount, 1);
});
