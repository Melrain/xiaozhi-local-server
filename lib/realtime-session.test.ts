import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRealtimeSessionUpdate } from "./realtime-session";

const CONFIG = {
  apiKey: "x",
  workspaceId: "w",
  model: "qwen3.5-omni-flash-realtime",
  voice: "Tina",
  url: "wss://example",
  instructions: "hi",
  configured: true,
};

test("device session.update waits for listen stop instead of auto-creating replies", () => {
  const event = buildRealtimeSessionUpdate(CONFIG);
  assert.equal(event.type, "session.update");
  const session = event.session as {
    turn_detection: { type: string; create_response: boolean };
    audio: { input: { format: { sample_rate: number } } };
  };
  assert.equal(session.turn_detection.type, "server_vad");
  assert.equal(session.turn_detection.create_response, false);
  assert.equal(session.audio.input.format.sample_rate, 16000);
});

test("realtime / browser session.update can still auto-create replies", () => {
  const event = buildRealtimeSessionUpdate(CONFIG, { createResponse: true });
  const session = event.session as { turn_detection: { create_response: boolean } };
  assert.equal(session.turn_detection.create_response, true);
});
