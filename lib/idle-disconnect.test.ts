import assert from "node:assert/strict";
import { test } from "node:test";
import type { WebSocket } from "ws";
import { getConnection, patchConnection, removeConnection, upsertConnection } from "./device-registry";
import { clearIdleDisconnect, noteDeviceActivity, noteVoiceFrame } from "./idle-disconnect";
import { deleteSessionSocket, setSessionSocket } from "./session-sockets";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeSocket() {
  return {
    OPEN: 1,
    readyState: 1,
    terminated: false,
    terminate() {
      this.readyState = 3;
      this.terminated = true;
    },
  };
}

function seed(sessionId: string) {
  upsertConnection({
    sessionId,
    deviceId: "idle-dev",
    clientId: "idle-client",
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

function cleanup(sessionId: string) {
  clearIdleDisconnect(sessionId);
  deleteSessionSocket(sessionId);
  removeConnection(sessionId);
}

test("idle disconnect kicks a silent session", async () => {
  const sessionId = "idle-kick";
  const ws = fakeSocket();
  setSessionSocket(sessionId, ws as unknown as WebSocket);
  seed(sessionId);
  try {
    noteDeviceActivity(sessionId, 25);
    await sleep(10);
    assert.equal(getConnection(sessionId)?.sessionId, sessionId);
    await sleep(40);
    assert.equal(getConnection(sessionId), undefined);
    assert.equal(ws.terminated, true);
  } finally {
    cleanup(sessionId);
  }
});

test("quiet opus frames do not refresh the idle timer", async () => {
  const sessionId = "idle-quiet";
  const ws = fakeSocket();
  setSessionSocket(sessionId, ws as unknown as WebSocket);
  seed(sessionId);
  try {
    noteDeviceActivity(sessionId, 30);
    await sleep(15);
    noteVoiceFrame(sessionId, 0.01, 30);
    await sleep(30);
    assert.equal(getConnection(sessionId), undefined);
    assert.equal(ws.terminated, true);
  } finally {
    cleanup(sessionId);
  }
});

test("voice or a later activity note defers the kick", async () => {
  const sessionId = "idle-voice";
  const ws = fakeSocket();
  setSessionSocket(sessionId, ws as unknown as WebSocket);
  seed(sessionId);
  try {
    noteDeviceActivity(sessionId, 25);
    await sleep(15);
    noteVoiceFrame(sessionId, 0.4, 25);
    await sleep(15);
    assert.equal(getConnection(sessionId)?.sessionId, sessionId);
    await sleep(25);
    assert.equal(getConnection(sessionId), undefined);
  } finally {
    cleanup(sessionId);
  }
});

test("responding defers idle disconnect until the model finishes", async () => {
  const sessionId = "idle-respond";
  const ws = fakeSocket();
  setSessionSocket(sessionId, ws as unknown as WebSocket);
  seed(sessionId);
  patchConnection(sessionId, { responding: true });
  try {
    noteDeviceActivity(sessionId, 20);
    await sleep(35);
    assert.equal(getConnection(sessionId)?.sessionId, sessionId);
    patchConnection(sessionId, { responding: false });
    noteDeviceActivity(sessionId, 20);
    await sleep(35);
    assert.equal(getConnection(sessionId), undefined);
  } finally {
    cleanup(sessionId);
  }
});

test("playing defers idle disconnect until playback ends", async () => {
  const sessionId = "idle-play";
  const ws = fakeSocket();
  setSessionSocket(sessionId, ws as unknown as WebSocket);
  seed(sessionId);
  patchConnection(sessionId, { playing: true });
  try {
    noteDeviceActivity(sessionId, 20);
    await sleep(35);
    assert.equal(getConnection(sessionId)?.sessionId, sessionId);
    patchConnection(sessionId, { playing: false });
    noteDeviceActivity(sessionId, 20);
    await sleep(35);
    assert.equal(getConnection(sessionId), undefined);
  } finally {
    cleanup(sessionId);
  }
});
