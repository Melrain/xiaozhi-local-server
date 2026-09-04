import assert from "node:assert/strict";
import { test } from "node:test";
import { bufferedSecondsAfterBurst } from "./pcm-playback-buffer";

test("live listen mode collapses a 2s burst to about 0.1s", () => {
  const seconds = bufferedSecondsAfterBurst({
    outputRate: 48000,
    mode: "live",
    burstSeconds: 2,
  });
  assert.ok(seconds < 0.12, `live burst kept ${seconds.toFixed(3)}s`);
  assert.ok(seconds > 0.02, `live burst kept ${seconds.toFixed(3)}s`);
});

test("queue mode keeps a 2s burst instead of collapsing to 0.1s", () => {
  const seconds = bufferedSecondsAfterBurst({
    outputRate: 48000,
    mode: "queue",
    burstSeconds: 2,
  });
  assert.ok(seconds > 1.8, `queue burst kept ${seconds.toFixed(3)}s, expected ~2s`);
});
