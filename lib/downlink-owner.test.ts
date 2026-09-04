import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claimDownlink,
  getDownlink,
  isDownlinkOwner,
  releaseDownlink,
} from "./downlink-owner";

test("only the current downlink owner can release playing", () => {
  const sessionId = "owner-test";
  const playGen = claimDownlink(sessionId, "play");
  assert.equal(getDownlink(sessionId).owner, "play");
  assert.equal(isDownlinkOwner(sessionId, playGen, "play"), true);

  const realtimeGen = claimDownlink(sessionId, "realtime");
  assert.equal(isDownlinkOwner(sessionId, playGen, "play"), false);
  assert.equal(releaseDownlink(sessionId, playGen, "play"), false);
  assert.equal(releaseDownlink(sessionId, realtimeGen, "realtime"), true);
  assert.equal(getDownlink(sessionId).owner, "none");
});
