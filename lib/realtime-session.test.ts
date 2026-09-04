import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRealtimeSessionUpdate } from "./realtime-session";

test("session.update enables server VAD with create_response", () => {
  const event = buildRealtimeSessionUpdate({
    apiKey: "x",
    workspaceId: "w",
    model: "qwen3.5-omni-flash-realtime",
    voice: "Tina",
    url: "wss://example",
    instructions: "hi",
    configured: true,
  });
  assert.equal(event.type, "session.update");
  const session = event.session as {
    turn_detection: { type: string; create_response: boolean };
    audio: { input: { format: { sample_rate: number } } };
  };
  assert.equal(session.turn_detection.type, "server_vad");
  assert.equal(session.turn_detection.create_response, true);
  assert.equal(session.audio.input.format.sample_rate, 16000);
});
