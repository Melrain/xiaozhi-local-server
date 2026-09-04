import assert from "node:assert/strict";
import { test } from "node:test";
import type { WebSocket } from "ws";
import {
  buildMcpEnvelope,
  clampVolume,
  disposeDeviceMcp,
  handleDeviceMcpResponse,
  parseSpeakerVolume,
  SET_VOLUME_TOOL,
  setDeviceVolume,
  shouldStartDeviceMcp,
} from "./device-mcp";
import { getConnection, removeConnection, upsertConnection } from "./device-registry";
import { deleteSessionSocket, setSessionSocket } from "./session-sockets";

function seedConnection(sessionId: string) {
  upsertConnection({
    sessionId,
    deviceId: "dev",
    clientId: "client",
    protocolVersion: "1",
    remoteAddress: "127.0.0.1",
    connectedAt: Date.now(),
    lastMessageAt: Date.now(),
    opusFrames: 0,
    listenState: "",
    listenMode: "",
    lastOpusAt: 0,
    lastOpusBytes: 0,
    level: 0,
    framesPerSec: 0,
    levelHistory: [],
  });
}

function fakeOpenSocket(onSend: (raw: string) => void) {
  return {
    OPEN: 1,
    readyState: 1,
    send(raw: string) {
      onSend(raw);
    },
  };
}

test("clampVolume keeps integers inside 0-100", () => {
  assert.equal(clampVolume(80), 80);
  assert.equal(clampVolume(-4), 0);
  assert.equal(clampVolume(140.2), 100);
  assert.equal(clampVolume(33.4), 33);
  assert.equal(clampVolume(Number.NaN), null);
});

test("parseSpeakerVolume reads firmware MCP text content", () => {
  assert.equal(
    parseSpeakerVolume({
      content: [{ type: "text", text: '{"audio_speaker":{"volume":70}}' }],
      isError: false,
    }),
    70,
  );
  assert.equal(parseSpeakerVolume({ audio_speaker: { volume: 12 } }), 12);
  assert.equal(parseSpeakerVolume({ content: [{ type: "text", text: "true" }] }), undefined);
});

test("shouldStartDeviceMcp defaults to trying unless firmware opts out", () => {
  assert.equal(shouldStartDeviceMcp(), true);
  assert.equal(shouldStartDeviceMcp({ mcp: true }), true);
  assert.equal(shouldStartDeviceMcp({ mcp: false }), false);
});

test("buildMcpEnvelope uses a numeric JSON-RPC id", () => {
  const envelope = buildMcpEnvelope("s1", 3, "tools/call", {
    name: SET_VOLUME_TOOL,
    arguments: { volume: 80 },
  });
  assert.equal(envelope.type, "mcp");
  assert.equal(typeof envelope.payload.id, "number");
  assert.equal(envelope.payload.id, 3);
  assert.deepEqual(envelope.payload.params, {
    name: SET_VOLUME_TOOL,
    arguments: { volume: 80 },
  });
});

test("setDeviceVolume initializes MCP then calls set_volume", async () => {
  const sent: Array<{ method?: string; id?: number; params?: Record<string, unknown> }> = [];
  const ws = fakeOpenSocket((raw) => {
    const message = JSON.parse(raw) as {
      payload: { method?: string; id?: number; params?: Record<string, unknown> };
    };
    sent.push(message.payload);
    queueMicrotask(() => {
      handleDeviceMcpResponse("vol-s1", {
        jsonrpc: "2.0",
        id: message.payload.id,
        result:
          message.payload.method === "tools/call"
            ? { content: [{ type: "text", text: "true" }], isError: false }
            : { protocolVersion: "2024-11-05" },
      });
    });
  });

  setSessionSocket("vol-s1", ws as unknown as WebSocket);
  seedConnection("vol-s1");
  try {
    const result = await setDeviceVolume("vol-s1", 108);
    assert.equal(result.ok, true);
    assert.equal(result.volume, 100);
    assert.equal(sent.length, 2);
    assert.equal(sent[0]?.method, "initialize");
    assert.equal(typeof sent[0]?.id, "number");
    assert.equal(sent[1]?.method, "tools/call");
    assert.deepEqual(sent[1]?.params, {
      name: SET_VOLUME_TOOL,
      arguments: { volume: 100 },
    });
    assert.equal(getConnection("vol-s1")?.speakerVolume, 100);
    assert.equal(getConnection("vol-s1")?.mcpReady, true);
  } finally {
    disposeDeviceMcp("vol-s1");
    deleteSessionSocket("vol-s1");
    removeConnection("vol-s1");
  }
});

test("setDeviceVolume returns error when no device is online", async () => {
  const result = await setDeviceVolume("missing-session", 40);
  assert.equal(result.ok, false);
  assert.equal(result.error, "no device online");
});
