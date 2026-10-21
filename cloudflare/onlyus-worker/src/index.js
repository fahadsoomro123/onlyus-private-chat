const ALLOWED_CALL_EVENTS = new Set(["ringing", "accepted", "rejected", "ended", "missed"]);
const SIGNAL_TYPES = new Set(["offer", "answer", "ice", "cancel"]);
const DEVICE_TYPES = new Set(["phone", "desktop"]);
const MAX_BODY_BYTES = 16 * 1024;
const RTC_TTL_MS = 10 * 60 * 1000;

export default {
  async fetch(request, env) {
    const roomId = env.SIGNALING.idFromName("onlyus-private-room-v2");
    return env.SIGNALING.get(roomId).fetch(request);
  },
};

export class OnlyUsRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const cors = this.corsHeaders(request);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: request.headers.get("Origin") && !cors["Access-Control-Allow-Origin"] ? 403 : 204,
        headers: cors,
      });
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "websocket_upgrade_required" }, 426, cors);
      }
      return this.openWebSocket(cors);
    }

    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({ ok: true, service: "onlyus-signaling-cloudflare" }, 200, cors);
    }

    const allowedPaths = new Set([
      "/v1/register-phone",
      "/v1/unregister-phone",
      "/v1/ice",
      "/v1/call",
    ]);
    if (!allowedPaths.has(url.pathname)) {
      return json({ error: "not_found" }, 404, cors);
    }
    if (!this.authorized(request.headers.get("Authorization"))) {
      return json({ error: "unauthorized" }, 401, cors);
    }

    if (request.method === "GET" && url.pathname === "/v1/ice") {
      return json({ iceServers: await this.buildIceServers() }, 200, cors);
    }
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405, cors);
    }

    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      return json({ error: error.message || "invalid_json" }, error.statusCode || 400, cors);
    }

    if (url.pathname === "/v1/register-phone") {
      if (
        typeof body.fcmToken !== "string" ||
        body.fcmToken.length < 20 ||
        body.fcmToken.length > 4096
      ) {
        return json({ error: "invalid_fcm_token" }, 400, cors);
      }
      if (!this.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        return json({ error: "firebase_not_configured" }, 503, cors);
      }
      await this.state.storage.put("phoneFcmToken", body.fcmToken);
      await this.state.storage.put("phoneTokenUpdatedAt", new Date().toISOString());
      return json({ ok: true }, 200, cors);
    }

    if (url.pathname === "/v1/unregister-phone") {
      await this.state.storage.delete("phoneFcmToken");
      await this.state.storage.put("phoneTokenUpdatedAt", new Date().toISOString());
      return json({ ok: true }, 200, cors);
    }

    if (url.pathname === "/v1/call") {
      if (
        !DEVICE_TYPES.has(body.from) ||
        typeof body.callId !== "string" ||
        !/^[a-zA-Z0-9_-]{8,100}$/.test(body.callId) ||
        !ALLOWED_CALL_EVENTS.has(body.event)
      ) {
        return json({ error: "invalid_call_event" }, 400, cors);
      }

      const recipient = body.from === "phone" ? "desktop" : "phone";
      const wsDelivered = this.sendTo(recipient, {
        type: "call_event",
        event: body.event,
        callId: body.callId,
        from: body.from,
        at: Date.now(),
      });

      let pushDelivered = false;
      if (recipient === "phone" && body.event === "ringing") {
        const fcmToken = await this.state.storage.get("phoneFcmToken");
        if (fcmToken && this.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
          try {
            await sendFirebasePush(this.env.FIREBASE_SERVICE_ACCOUNT_JSON, fcmToken, {
              type: "incoming_call",
              event: body.event,
              callId: body.callId,
              caller: body.from === "desktop" ? "Wife" : "Fahad",
            });
            pushDelivered = true;
          } catch (error) {
            console.error("FCM delivery failed; HTTP status:", error.status || "unknown");
          }
        }
      }

      if (body.event === "ringing" && recipient === "phone" && !pushDelivered && !wsDelivered) {
        const missing = !this.env.FIREBASE_SERVICE_ACCOUNT_JSON
          ? "push_not_configured"
          : !(await this.state.storage.get("phoneFcmToken"))
            ? "phone_not_registered"
            : "phone_not_reachable";
        return json({ ok: false, error: missing, wsDelivered, pushDelivered }, 503, cors);
      }
      return json({ ok: true, wsDelivered, pushDelivered }, 202, cors);
    }

    return json({ error: "not_found" }, 404, cors);
  }

  corsHeaders(request) {
    const origin = request.headers.get("Origin");
    const configured = String(this.env.ONLYUS_ALLOWED_ORIGINS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    };
    if (origin && configured.includes(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers.Vary = "Origin";
    }
    return headers;
  }

  authorized(header) {
    const match = /^Bearer\s+(.+)$/i.exec(header || "");
    return Boolean(
      match &&
      typeof this.env.ONLYUS_PAIR_TOKEN === "string" &&
      this.env.ONLYUS_PAIR_TOKEN.length >= 32 &&
      safeEqual(match[1], this.env.ONLYUS_PAIR_TOKEN)
    );
  }

  openWebSocket(cors) {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ device: null, connectedAt: Date.now() });
    return new Response(null, { status: 101, webSocket: client, headers: cors });
  }

  webSocketMessage(socket, rawMessage) {
    this.handleWebSocketMessage(socket, rawMessage).catch(() => {
      try { socket.close(1011, "internal signaling error"); } catch {}
    });
  }

  async handleWebSocketMessage(socket, rawMessage) {
    let message;
    try {
      const raw = typeof rawMessage === "string"
        ? rawMessage
        : new TextDecoder().decode(rawMessage);
      if (raw.length > 64 * 1024) {
        socket.close(4400, "message too large");
        return;
      }
      message = JSON.parse(raw);
    } catch {
      socket.close(4400, "invalid message");
      return;
    }

    const attachment = socket.deserializeAttachment() || { device: null };
    if (!attachment.device) {
      if (
        message.type !== "auth" ||
        !DEVICE_TYPES.has(message.device) ||
        !this.env.ONLYUS_PAIR_TOKEN ||
        !safeEqual(message.token, this.env.ONLYUS_PAIR_TOKEN)
      ) {
        socket.close(4401, "authentication failed");
        return;
      }
      for (const existing of this.state.getWebSockets()) {
        if (existing === socket || existing.readyState !== 1) continue;
        const prior = existing.deserializeAttachment() || {};
        if (prior.device === message.device) {
          try { existing.close(4001, "replaced by a newer connection"); } catch {}
        }
      }
      socket.serializeAttachment({ device: message.device, connectedAt: Date.now() });
      socket.send(JSON.stringify({
        type: "connected",
        device: message.device,
        at: Date.now(),
      }));
      return;
    }

    if (message.type === "ping") {
      socket.send(JSON.stringify({ type: "pong", at: Date.now() }));
      return;
    }

    if (message.type === "signal") {
      await this.handleSignal(socket, attachment.device, message);
      return;
    }

    if (
      message.type === "call_event" &&
      typeof message.callId === "string" &&
      /^[a-zA-Z0-9_-]{8,100}$/.test(message.callId) &&
      ALLOWED_CALL_EVENTS.has(message.event)
    ) {
      const recipient = attachment.device === "phone" ? "desktop" : "phone";
      this.sendTo(recipient, {
        type: "call_event",
        event: message.event,
        callId: message.callId,
        from: attachment.device,
        at: Date.now(),
      });
    }
  }

  async handleSignal(socket, device, message) {
    if (
      typeof message.rtcId !== "string" ||
      !/^[a-zA-Z0-9_-]{8,100}$/.test(message.rtcId) ||
      typeof message.callId !== "string" ||
      !/^[a-zA-Z0-9_-]{8,100}$/.test(message.callId) ||
      !SIGNAL_TYPES.has(message.signalType)
    ) {
      socket.close(4400, "invalid signalling payload");
      return;
    }

    const storageKey = "rtc:" + message.rtcId;
    let session = await this.state.storage.get(storageKey);
    const now = Date.now();
    if (session && now - session.updatedAt > RTC_TTL_MS) {
      await this.state.storage.delete(storageKey);
      session = undefined;
    }

    if (message.signalType === "offer") {
      const kind = message.metadata && message.metadata.kind;
      if (
        !["media", "data"].includes(kind) ||
        !message.signal ||
        message.signal.type !== "offer" ||
        typeof message.signal.sdp !== "string" ||
        message.signal.sdp.length > 48 * 1024 ||
        session
      ) {
        socket.close(4400, "invalid offer");
        return;
      }
      session = {
        rtcId: message.rtcId,
        callId: message.callId,
        callerDevice: device,
        calleeDevice: device === "phone" ? "desktop" : "phone",
        updatedAt: now,
        metadata: {
          kind,
          callId: message.callId,
          from: device === "phone" ? "fahad" : "wife",
          label: device === "phone" ? "Fahad" : "Wife",
          monitor: kind === "media" && device === "phone" && message.metadata.monitor === true,
        },
      };
    } else if (
      !session ||
      session.callId !== message.callId ||
      ![session.callerDevice, session.calleeDevice].includes(device)
    ) {
      return;
    }

    if (
      message.signalType === "answer" &&
      (!message.signal || message.signal.type !== "answer" ||
        typeof message.signal.sdp !== "string" ||
        message.signal.sdp.length > 48 * 1024)
    ) {
      socket.close(4400, "invalid answer");
      return;
    }
    if (
      message.signalType === "ice" &&
      message.signal &&
      typeof message.signal.candidate === "string" &&
      message.signal.candidate.length > 4096
    ) {
      socket.close(4400, "invalid ICE candidate");
      return;
    }

    session.updatedAt = now;
    await this.state.storage.put(storageKey, session);
    const recipient = device === session.callerDevice
      ? session.calleeDevice
      : session.callerDevice;
    const delivered = this.sendTo(recipient, {
      type: "signal",
      from: device,
      rtcId: session.rtcId,
      callId: session.callId,
      signalType: message.signalType,
      metadata: session.metadata,
      signal: message.signal,
    });
    if (!delivered) {
      socket.send(JSON.stringify({
        type: "peer-unavailable",
        rtcId: session.rtcId,
        callId: session.callId,
      }));
      if (message.signalType === "offer" || message.signalType === "cancel") {
        await this.state.storage.delete(storageKey);
      }
      return;
    }
    if (message.signalType === "cancel") await this.state.storage.delete(storageKey);
  }

  sendTo(device, payload) {
    for (const socket of this.state.getWebSockets()) {
      if (socket.readyState !== 1) continue;
      const attachment = socket.deserializeAttachment() || {};
      if (attachment.device !== device) continue;
      try {
        socket.send(JSON.stringify(payload));
        return true;
      } catch {}
    }
    return false;
  }

  async buildIceServers() {
    const result = [{ urls: ["stun:stun.cloudflare.com:3478"] }];
    const turnKeyId = String(this.env.CLOUDFLARE_TURN_KEY_ID || "").trim();
    const turnApiToken = String(this.env.CLOUDFLARE_TURN_API_TOKEN || "").trim();
    if (turnKeyId && turnApiToken) {
      try {
        const response = await fetch(
          "https://rtc.live.cloudflare.com/v1/turn/keys/" +
            encodeURIComponent(turnKeyId) + "/credentials/generate-ice-servers",
          {
            method: "POST",
            headers: {
              Authorization: "Bearer " + turnApiToken,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ ttl: 86400 }),
          },
        );
        if (response.ok) {
          const payload = await response.json();
          if (Array.isArray(payload.iceServers) && payload.iceServers.length > 0) {
            return payload.iceServers;
          }
        } else {
          console.warn("Cloudflare TURN credential API returned HTTP", response.status);
        }
      } catch {
        console.warn("Cloudflare TURN credential request failed; using STUN fallback.");
      }
      return result;
    }

    // Optional coturn-style fallback for deployments using a shared-secret TURN provider.
    const urls = String(this.env.ONLYUS_TURN_URLS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const secret = String(this.env.ONLYUS_TURN_SHARED_SECRET || "");
    if (!urls.length || secret.length < 16) return result;

    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const username = String(expiry) + ":onlyus";
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(username));
    result.push({
      urls,
      username,
      credential: bytesToBase64(new Uint8Array(signature)),
    });
    return result;
  }

  webSocketClose(socket) {
    try { socket.close(); } catch {}
  }

  webSocketError(socket) {
    try { socket.close(1011, "websocket error"); } catch {}
  }
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

async function readJson(request) {
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    const error = new Error("body_too_large");
    error.statusCode = 413;
    throw error;
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    const error = new Error("body_too_large");
    error.statusCode = 413;
    throw error;
  }
  try {
    return JSON.parse(raw || "{}");
  } catch {
    const error = new Error("invalid_json");
    error.statusCode = 400;
    throw error;
  }
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Url(value) {
  return btoa(value).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function encodeBase64UrlJson(value) {
  return base64Url(JSON.stringify(value));
}

async function sendFirebasePush(serviceAccountJson, token, data) {
  const serviceAccount = JSON.parse(serviceAccountJson);
  if (!serviceAccount.client_email || !serviceAccount.private_key || !serviceAccount.project_id) {
    throw new Error("invalid Firebase service-account configuration");
  }
  const now = Math.floor(Date.now() / 1000);
  const unsigned = encodeBase64UrlJson({ alg: "RS256", typ: "JWT" }) + "." +
    encodeBase64UrlJson({
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    });

  const pem = serviceAccount.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const keyBytes = Uint8Array.from(atob(pem), (char) => char.charCodeAt(0));
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(unsigned),
  );
  const sig = String.fromCharCode(...new Uint8Array(signature));
  const assertion = unsigned + "." + base64Url(sig);

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!tokenResponse.ok) throw new Error("Firebase OAuth failed: HTTP " + tokenResponse.status);
  const tokenBody = await tokenResponse.json();
  if (!tokenBody.access_token) throw new Error("Firebase OAuth returned no access token");

  const response = await fetch(
    "https://fcm.googleapis.com/v1/projects/" +
      encodeURIComponent(serviceAccount.project_id) + "/messages:send",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + tokenBody.access_token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token,
          data,
          android: { priority: "HIGH", ttl: "60s" },
        },
      }),
    },
  );
  if (!response.ok) throw new Error("Firebase push failed: HTTP " + response.status);
}
