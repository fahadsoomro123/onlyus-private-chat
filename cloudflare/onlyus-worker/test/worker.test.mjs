import test from "node:test";
import assert from "node:assert/strict";
import { OnlyUsRoom } from "../src/index.js";

const pairToken = "a".repeat(48);

function makeRoom(envOverrides = {}) {
  const data = new Map();
  const state = {
    storage: {
      async get(key) { return data.get(key); },
      async put(key, value) { data.set(key, value); },
      async delete(key) { return data.delete(key); },
    },
    getWebSockets() { return []; },
    acceptWebSocket() { throw new Error("WebSocket not needed in HTTP tests"); },
  };
  const env = {
    ONLYUS_PAIR_TOKEN: pairToken,
    ONLYUS_ALLOWED_ORIGINS:
      "https://appassets.androidplatform.net,http://127.0.0.1:4178,http://localhost:4178",
    ...envOverrides,
  };
  return new OnlyUsRoom(state, env);
}

function request(path, { method = "GET", token, body, origin } = {}) {
  const headers = new Headers();
  if (token) headers.set("Authorization", "Bearer " + token);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (origin) headers.set("Origin", origin);
  return new Request("https://unit.test" + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("health endpoint responds without pairing authorization", async () => {
  const response = await makeRoom().fetch(request("/healthz"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "onlyus-signaling-cloudflare",
  });
});

test("protected ICE endpoint rejects missing authorization", async () => {
  const response = await makeRoom().fetch(request("/v1/ice"));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorized" });
});

test("authorized ICE endpoint provides STUN fallback", async () => {
  const response = await makeRoom().fetch(request("/v1/ice", { token: pairToken }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.iceServers.length, 1);
  assert.deepEqual(body.iceServers[0].urls, ["stun:stun.cloudflare.com:3478"]);
});

test("allowed browser origin receives CORS permission", async () => {
  const response = await makeRoom().fetch(request("/v1/ice", {
    token: pairToken,
    origin: "https://appassets.androidplatform.net",
  }));
  assert.equal(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://appassets.androidplatform.net",
  );
});

test("unlisted API path is rejected", async () => {
  const response = await makeRoom().fetch(request("/admin", { token: pairToken }));
  assert.equal(response.status, 404);
});

test("invalid JSON body is rejected", async () => {
  const room = makeRoom();
  const response = await room.fetch(new Request("https://unit.test/v1/call", {
    method: "POST",
    headers: { Authorization: "Bearer " + pairToken, "Content-Type": "application/json" },
    body: "{broken",
  }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_json" });
});

test("phone FCM registration is explicitly blocked until push credentials are configured", async () => {
  const response = await makeRoom().fetch(request("/v1/register-phone", {
    method: "POST",
    token: pairToken,
    body: { fcmToken: "f".repeat(40) },
  }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "firebase_not_configured" });
});

test("incoming call reports push blocker when phone socket is offline", async () => {
  const response = await makeRoom().fetch(request("/v1/call", {
    method: "POST",
    token: pairToken,
    body: { from: "desktop", callId: "test-call-0001", event: "ringing" },
  }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "push_not_configured",
    wsDelivered: false,
    pushDelivered: false,
  });
});

test("invalid call event is rejected", async () => {
  const response = await makeRoom().fetch(request("/v1/call", {
    method: "POST",
    token: pairToken,
    body: { from: "desktop", callId: "test-call-0001", event: "execute" },
  }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_call_event" });
});

test("Cloudflare TURN credentials are requested server-side when configured", async () => {
  const previousFetch = globalThis.fetch;
  let calledUrl = "";
  let calledInit;
  globalThis.fetch = async (url, init) => {
    calledUrl = String(url);
    calledInit = init;
    return new Response(JSON.stringify({
      iceServers: [
        { urls: ["stun:stun.cloudflare.com:3478"] },
        {
          urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
          username: "short-lived-user",
          credential: "short-lived-credential",
        },
      ],
    }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const room = makeRoom({
      CLOUDFLARE_TURN_KEY_ID: "test-turn-key-id",
      CLOUDFLARE_TURN_API_TOKEN: "test-turn-api-secret",
    });
    const servers = await room.buildIceServers();
    assert.equal(servers.length, 2);
    assert.ok(calledUrl.endsWith("/v1/turn/keys/test-turn-key-id/credentials/generate-ice-servers"));
    assert.equal(calledInit.headers.Authorization, "Bearer test-turn-api-secret");
    assert.equal(JSON.parse(calledInit.body).ttl, 86400);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
