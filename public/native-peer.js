'use strict';

(() => {
  const SIGNAL_TYPES = new Set(['offer', 'answer', 'ice', 'cancel']);
  const MAX_RECONNECT_MS = 30000;

  class Emitter {
    constructor() { this.handlers = new Map(); }
    on(name, callback) {
      if (typeof callback !== 'function') return this;
      if (!this.handlers.has(name)) this.handlers.set(name, new Set());
      this.handlers.get(name).add(callback);
      return this;
    }
    off(name, callback) {
      const set = this.handlers.get(name);
      if (set) set.delete(callback);
      return this;
    }
    emit(name, value) {
      const set = this.handlers.get(name);
      if (!set) return;
      for (const callback of [...set]) {
        try { callback(value); } catch (error) {
          console.error('Only Us event listener failed:', name, error);
        }
      }
    }
  }

  function id() {
    return globalThis.crypto && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);
  }

  function serialDescription(description) {
    if (!description) return null;
    if (typeof description.toJSON === 'function') return description.toJSON();
    return { type: description.type, sdp: description.sdp };
  }

  function serialCandidate(candidate) {
    if (!candidate) return null;
    if (typeof candidate.toJSON === 'function') return candidate.toJSON();
    return {
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid,
      sdpMLineIndex: candidate.sdpMLineIndex,
      usernameFragment: candidate.usernameFragment
    };
  }

  function normalError(type, message) {
    const error = new Error(message || type || 'Only Us connection error');
    error.type = type || 'unknown';
    return error;
  }

  class NativeConnection extends Emitter {
    constructor(peer, rtcId, callId, metadata, incoming) {
      super();
      this.peer = peer;
      this.rtcId = rtcId;
      this.callId = callId;
      this.metadata = metadata || {};
      this.incoming = Boolean(incoming);
      this.open = false;
      this.closed = false;
      this.connected = false;
      this.pendingIce = [];
      this.pc = new RTCPeerConnection({
        iceServers: peer.options && peer.options.config && Array.isArray(peer.options.config.iceServers)
          ? peer.options.config.iceServers
          : [{ urls: 'stun:stun.l.google.com:19302' }]
      });
      this._closeEmitted = false;
      this._wirePeerConnection();
      peer.connections.set(this.rtcId, this);
    }

    _wirePeerConnection() {
      this.pc.onicecandidate = event => {
        if (event.candidate && !this.closed) {
          this.peer._sendSignal(this, 'ice', serialCandidate(event.candidate));
        }
      };
      this.pc.onconnectionstatechange = () => {
        if (this.closed) return;
        const state = this.pc.connectionState;
        if (state === 'connected') {
          this.connected = true;
          this.open = true;
        } else if (state === 'failed') {
          this.emit('error', normalError('webrtc', 'Peer-to-peer connection failed.'));
        } else if (state === 'closed') {
          this.close(false);
        }
      };
      this.pc.oniceconnectionstatechange = () => {
        if (this.closed) return;
        if (this.pc.iceConnectionState === 'failed') {
          this.emit('error', normalError('webrtc', 'ICE connection failed.'));
        }
      };
    }

    async _setRemoteDescription(description) {
      await this.pc.setRemoteDescription(description);
      const waiting = this.pendingIce.splice(0);
      for (const candidate of waiting) {
        try { await this.pc.addIceCandidate(candidate); }
        catch (error) { console.warn('Only Us discarded an early ICE candidate:', error.message); }
      }
    }

    async _handleSignal(signalType, signal) {
      if (this.closed) return;
      try {
        if (signalType === 'answer') {
          await this._setRemoteDescription(signal);
        } else if (signalType === 'ice' && signal) {
          if (this.pc.remoteDescription && this.pc.remoteDescription.type) {
            try { await this.pc.addIceCandidate(signal); }
            catch (error) { console.warn('Only Us ignored an ICE candidate:', error.message); }
          } else {
            this.pendingIce.push(signal);
          }
        } else if (signalType === 'cancel') {
          this.close(false);
        }
      } catch (error) {
        this.emit('error', normalError('webrtc', error && error.message));
      }
    }

    _send(signalType, signal) {
      return this.peer._sendSignal(this, signalType, signal);
    }

    close(notifyPeer = true) {
      if (this.closed) return;
      this.closed = true;
      this.open = false;
      if (notifyPeer) this._send('cancel', { reason: 'closed' });
      try { this.pc.onicecandidate = null; } catch {}
      try { this.pc.close(); } catch {}
      this.peer._removeConnection(this);
      if (!this._closeEmitted) {
        this._closeEmitted = true;
        this.emit('close');
      }
    }
  }

  class NativeMediaConnection extends NativeConnection {
    constructor(peer, rtcId, callId, metadata, incoming) {
      super(peer, rtcId, callId, { ...(metadata || {}), kind: 'media', callId }, incoming);
      this.localStream = null;
      this.remoteStream = new MediaStream();
      this.readyForAnswer = Promise.resolve();
      this.pc.ontrack = event => {
        const stream = event.streams && event.streams[0];
        if (stream) {
          this.remoteStream = stream;
        } else if (event.track && !this.remoteStream.getTracks().some(track => track.id === event.track.id)) {
          this.remoteStream.addTrack(event.track);
        }
        this.emit('stream', this.remoteStream);
      };
    }

    async start(stream) {
      this.localStream = stream;
      for (const track of stream.getTracks()) this.pc.addTrack(track, stream);
      const offer = await this.pc.createOffer();
      if (this.closed) return;
      await this.pc.setLocalDescription(offer);
      if (!this._send('offer', serialDescription(this.pc.localDescription))) {
        this.emit('error', normalError('peer-unavailable', 'Partner is not connected to the call server yet.'));
      }
    }

    async prepareOffer(offer) {
      this.readyForAnswer = this._setRemoteDescription(offer);
      await this.readyForAnswer;
    }

    async answer(stream) {
      if (this.closed) throw normalError('closed', 'This call has ended.');
      await this.readyForAnswer;
      this.localStream = stream;
      for (const track of stream.getTracks()) this.pc.addTrack(track, stream);
      const answer = await this.pc.createAnswer();
      if (this.closed) return;
      await this.pc.setLocalDescription(answer);
      if (!this._send('answer', serialDescription(this.pc.localDescription))) {
        throw normalError('peer-unavailable', 'The caller disconnected.');
      }
    }
  }

  class NativeDataConnection extends NativeConnection {
    constructor(peer, rtcId, callId, metadata, incoming) {
      super(peer, rtcId, callId, { ...(metadata || {}), kind: 'data', callId }, incoming);
      this.dataChannel = null;
      this.serialization = 'json';
      if (incoming) {
        this.pc.ondatachannel = event => this._bindChannel(event.channel);
      }
    }

    _bindChannel(channel) {
      this.dataChannel = channel;
      channel.onopen = () => {
        if (this.closed) return;
        this.open = true;
        this.connected = true;
        this.emit('open');
      };
      channel.onmessage = event => {
        let value = event.data;
        try { value = JSON.parse(event.data); } catch {}
        this.emit('data', value);
      };
      channel.onerror = () => this.emit('error', normalError('data-channel', 'The message connection encountered an error.'));
      channel.onclose = () => {
        if (!this.closed) this.close(false);
      };
    }

    async start() {
      const channel = this.pc.createDataChannel('onlyus-chat', { ordered: true });
      this._bindChannel(channel);
      const offer = await this.pc.createOffer();
      if (this.closed) return;
      await this.pc.setLocalDescription(offer);
      if (!this._send('offer', serialDescription(this.pc.localDescription))) {
        this.emit('error', normalError('peer-unavailable', 'Partner is not connected yet.'));
      }
    }

    async prepareOffer(offer) {
      await this._setRemoteDescription(offer);
      const answer = await this.pc.createAnswer();
      if (this.closed) return;
      await this.pc.setLocalDescription(answer);
      if (!this._send('answer', serialDescription(this.pc.localDescription))) {
        this.emit('error', normalError('peer-unavailable', 'Partner is not connected yet.'));
      }
    }

    send(payload) {
      if (this.closed || !this.dataChannel || this.dataChannel.readyState !== 'open') {
        throw normalError('data-channel-not-open', 'Message channel is not open.');
      }
      this.dataChannel.send(JSON.stringify(payload));
    }

    close(notifyPeer = true) {
      if (this.closed) return;
      try {
        if (this.dataChannel) {
          this.dataChannel.onclose = null;
          this.dataChannel.close();
        }
      } catch {}
      super.close(notifyPeer);
    }
  }

  class OnlyUsPeer extends Emitter {
    constructor(peerId, options) {
      super();
      this.id = peerId;
      this.options = options || {};
      this.open = false;
      this.destroyed = false;
      this.disconnected = false;
      this.socket = null;
      this.connections = new Map();
      this.reconnectTimer = null;
      this.reconnectDelay = 1000;
      this.connectGeneration = 0;
      this.heartbeatTimer = null;
      this.lastPongAt = 0;
      this._connect();
    }

    _connect() {
      if (this.destroyed) return;
      const runtime = window.OnlyUsRuntime || {};
      const base = String(runtime.backendUrl || '').trim().replace(/\/+$/, '');
      const token = String(runtime.roomKey || '');
      const device = runtime.role === 'fahad' ? 'phone' : runtime.role === 'wife' ? 'desktop' : '';
      if (!base || !token || !device) {
        queueMicrotask(() => this.emit('error', normalError('configuration', 'Private server setup is missing.')));
        return;
      }
      if (typeof WebSocket !== 'function' || typeof RTCPeerConnection !== 'function') {
        queueMicrotask(() => this.emit('error', normalError('unsupported', 'This device does not support secure calling.')));
        return;
      }
      if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      const generation = ++this.connectGeneration;
      let socketUrl;
      try { socketUrl = base.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:') + '/ws'; }
      catch {
        this.emit('error', normalError('configuration', 'Private server URL is invalid.'));
        return;
      }
      let socket;
      try { socket = new WebSocket(socketUrl); }
      catch (error) {
        this.emit('error', normalError('network', error.message));
        this._scheduleReconnect();
        return;
      }
      this.socket = socket;
      socket.addEventListener('open', () => {
        if (this.destroyed || generation !== this.connectGeneration) return;
        socket.send(JSON.stringify({ type: 'auth', device, token }));
      });
      socket.addEventListener('message', event => {
        if (this.destroyed || generation !== this.connectGeneration) return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        this._handleMessage(message);
      });
      socket.addEventListener('close', () => {
        if (generation !== this.connectGeneration) return;
        this.socket = null;
        const wasOpen = this.open;
        this.open = false;
        this.disconnected = true;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        if (wasOpen) this.emit('disconnected');
        this._scheduleReconnect();
      });
      socket.addEventListener('error', () => {
        try { socket.close(); } catch {}
      });
    }

    _handleMessage(message) {
      if (message.type === 'connected') {
        this.open = true;
        this.disconnected = false;
        this.reconnectDelay = 1000;
        this.lastPongAt = Date.now();
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
          const socket = this.socket;
          if (this.destroyed || !this.open || !socket || socket.readyState !== WebSocket.OPEN) return;
          if (Date.now() - this.lastPongAt > 45000) {
            try { socket.close(); } catch {}
            return;
          }
          try { socket.send(JSON.stringify({ type: 'ping' })); }
          catch { try { socket.close(); } catch {} }
        }, 20000);
        this.emit('open', this.id);
        return;
      }
      if (message.type === 'pong') {
        this.lastPongAt = Date.now();
        return;
      }
      if (message.type === 'call_event') {
        this.emit('call-event', message);
        return;
      }
      if (message.type === 'peer-unavailable') {
        const conn = this.connections.get(message.rtcId);
        if (conn) {
          conn.emit('error', normalError('peer-unavailable', 'Partner is not connected yet.'));
          setTimeout(() => {
            if (!conn.closed && !conn.connected) conn.close(false);
          }, 0);
        }
        return;
      }
      if (message.type !== 'signal' || typeof message.rtcId !== 'string') return;
      const signalType = message.signalType;
      if (!SIGNAL_TYPES.has(signalType)) return;

      let conn = this.connections.get(message.rtcId);
      if (!conn && signalType === 'offer') {
        if (!message.callId || typeof message.callId !== 'string' || !message.metadata) return;
        if (message.metadata.kind === 'data') {
          conn = new NativeDataConnection(this, message.rtcId, message.callId, message.metadata, true);
          conn.prepareOffer(message.signal).catch(error =>
            conn.emit('error', normalError('webrtc', error && error.message)));
          this.emit('connection', conn);
        } else if (message.metadata.kind === 'media') {
          conn = new NativeMediaConnection(this, message.rtcId, message.callId, message.metadata, true);
          conn.prepareOffer(message.signal).catch(error =>
            conn.emit('error', normalError('webrtc', error && error.message)));
          this.emit('call', conn);
        } else {
          return;
        }
        return;
      }
      if (conn) {
        if (signalType === 'cancel') conn.close(false);
        else conn._handleSignal(signalType, message.signal);
      }
    }

    _sendSignal(conn, signalType, signal) {
      if (this.destroyed || !this.open || !this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
      if (!SIGNAL_TYPES.has(signalType)) return false;
      try {
        this.socket.send(JSON.stringify({
          type: 'signal',
          signalType,
          rtcId: conn.rtcId,
          callId: conn.callId,
          metadata: conn.metadata,
          signal
        }));
        return true;
      } catch (error) {
        console.warn('Only Us could not send signalling data:', error.message);
        return false;
      }
    }

    _removeConnection(conn) {
      if (this.connections.get(conn.rtcId) === conn) this.connections.delete(conn.rtcId);
    }

    call(peerId, stream, options) {
      const metadata = { ...((options && options.metadata) || {}), kind: 'media' };
      const callId = String(metadata.callId || id());
      const conn = new NativeMediaConnection(this, id(), callId, metadata, false);
      queueMicrotask(() => conn.start(stream).catch(error => {
        if (!conn.closed) conn.emit('error', normalError(error && error.type || 'webrtc', error && error.message));
      }));
      return conn;
    }

    connect(peerId, options) {
      const metadata = { kind: 'data', from: (window.OnlyUsRuntime || {}).role };
      const callId = id();
      const conn = new NativeDataConnection(this, id(), callId, metadata, false);
      queueMicrotask(() => conn.start().catch(error => {
        if (!conn.closed) conn.emit('error', normalError(error && error.type || 'webrtc', error && error.message));
      }));
      return conn;
    }

    reconnect() {
      if (this.destroyed) return;
      if (this.socket && (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN)) return;
      this._connect();
    }

    _scheduleReconnect() {
      if (this.destroyed || this.reconnectTimer) return;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this._connect();
      }, this.reconnectDelay);
      this.reconnectDelay = Math.min(MAX_RECONNECT_MS, this.reconnectDelay * 2);
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.open = false;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      for (const conn of [...this.connections.values()]) {
        try { conn.close(false); } catch {}
      }
      this.connections.clear();
      const socket = this.socket;
      this.socket = null;
      if (socket) {
        try { socket.close(1000, 'device closed'); } catch {}
      }
      this.emit('close');
    }
  }

  window.Peer = OnlyUsPeer;
})();
