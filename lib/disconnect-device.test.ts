import assert from "node:assert/strict";
import { test } from "node:test";
import type { WebSocket } from "ws";
import { disconnectDevice } from "./disconnect-device";
import { getConnection, removeConnection, upsertConnection } from "./device-registry";
import { deleteSessionSocket, setSessionSocket } from "./session-sockets";

function fakeSocket(readyState = 1) {
  return {
    OPEN: 1,
    CONNECTING: 0,
    CLOSING: 2,
    CLOSED: 3,
    readyState,
    terminated: false,
    terminate() {
      this.readyState = 3;
      this.terminated = true;
    },
  };
}

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

test("disconnectDevice terminates the targeted open socket and drops the session", () => {
  const ws = fakeSocket();
  setSessionSocket("disconnect-s1", ws as unknown as WebSocket);
  seedConnection("disconnect-s1");
  try {
    const result = disconnectDevice("disconnect-s1");
    assert.equal(result.ok, true);
    assert.equal(result.sessionId, "disconnect-s1");
    assert.equal(ws.terminated, true);
    assert.equal(getConnection("disconnect-s1"), undefined);
  } finally {
    deleteSessionSocket("disconnect-s1");
    removeConnection("disconnect-s1");
  }
});

test("disconnectDevice treats a closing socket as already disconnectable", () => {
  const ws = fakeSocket(2);
  setSessionSocket("disconnect-s2", ws as unknown as WebSocket);
  seedConnection("disconnect-s2");
  try {
    const result = disconnectDevice("disconnect-s2");
    assert.equal(result.ok, true);
    assert.equal(ws.terminated, true);
    assert.equal(getConnection("disconnect-s2"), undefined);
  } finally {
    deleteSessionSocket("disconnect-s2");
    removeConnection("disconnect-s2");
  }
});

test("disconnectDevice drops a registry entry even after the socket is gone", () => {
  seedConnection("disconnect-s3");
  try {
    const result = disconnectDevice("disconnect-s3");
    assert.equal(result.ok, true);
    assert.equal(getConnection("disconnect-s3"), undefined);
  } finally {
    removeConnection("disconnect-s3");
  }
});

test("disconnectDevice returns error when no device is online", () => {
  const result = disconnectDevice("missing-session");
  assert.equal(result.ok, false);
  assert.equal(result.error, "no device online");
});
