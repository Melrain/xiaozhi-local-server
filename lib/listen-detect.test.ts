import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyListenDetect,
  isWakeWord,
  normalizeWakeText,
  planDetect,
  WAKE_GREETING,
} from "./listen-detect";
import { getConnection, removeConnection, upsertConnection } from "./device-registry";

function seed(sessionId: string) {
  upsertConnection({
    sessionId,
    deviceId: "detect-dev",
    clientId: "detect-client",
    protocolVersion: "1",
    remoteAddress: "127.0.0.1",
    connectedAt: Date.now(),
    lastMessageAt: Date.now(),
    opusFrames: 0,
    listenState: "start",
    listenMode: "auto",
    lastOpusAt: 0,
    lastOpusBytes: 0,
    level: 0,
    framesPerSec: 0,
    levelHistory: [],
    playing: true,
    responding: true,
  });
}

test("wake words match official list after punctuation strip", () => {
  assert.equal(normalizeWakeText("你好，小智！"), "你好小智");
  assert.equal(isWakeWord("你好小智"), true);
  assert.equal(isWakeWord("你好，小智"), true);
  assert.equal(isWakeWord("嘿你好呀"), true);
  assert.equal(isWakeWord("今天天气怎么样"), false);
});

test("wake word with greeting disabled is STT + tts stop only", () => {
  const plan = planDetect("你好小智", { enableGreeting: false });
  assert.equal(plan.kind, "wake-ack");
  assert.equal(plan.sttText, "你好小智");
  assert.equal(plan.sendTtsStop, true);
  assert.equal(plan.chatText, null);
});

test("wake word with greeting enabled starts official chat starter", () => {
  const plan = planDetect("你好小智");
  assert.equal(plan.kind, "wake-greet");
  assert.equal(plan.sendTtsStop, true);
  assert.equal(plan.chatText, WAKE_GREETING);
});

test("non-wake detect text is treated as a chat starter", () => {
  const plan = planDetect("现在几点了");
  assert.equal(plan.kind, "chat");
  assert.equal(plan.sttText, "现在几点了");
  assert.equal(plan.sendTtsStop, true);
  assert.equal(plan.chatText, "现在几点了");
});

test("applyListenDetect without Realtime still sends STT + tts stop", () => {
  const sessionId = "detect-stub";
  seed(sessionId);
  const sent: Array<Record<string, unknown>> = [];
  try {
    const result = applyListenDetect({
      sessionId,
      text: "你好小智",
      sendJson: (payload) => sent.push(payload as Record<string, unknown>),
      enableGreeting: false,
    });
    assert.equal(result.kind, "wake-ack");
    assert.equal(result.greetedViaRealtime, false);
    assert.deepEqual(
      sent.map((message) => `${message.type}:${message.state ?? message.text}`),
      ["stt:你好小智", "tts:stop"],
    );
    assert.equal(getConnection(sessionId)?.playing, false);
    assert.equal(getConnection(sessionId)?.responding, false);
  } finally {
    removeConnection(sessionId);
  }
});
