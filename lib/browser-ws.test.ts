import assert from "node:assert/strict";
import { test } from "node:test";
import { browserWebSocketUrl } from "./browser-ws";

test("LAN HTTP dashboard talks to the device WebSocket port", () => {
  assert.equal(
    browserWebSocketUrl("/listen-stream?session=abc", 8000, {
      protocol: "http:",
      host: "192.168.50.188:3000",
      hostname: "192.168.50.188",
    }),
    "ws://192.168.50.188:8000/listen-stream?session=abc",
  );
});

test("HTTPS dashboard uses same-origin wss so Caddy can proxy the worker", () => {
  assert.equal(
    browserWebSocketUrl("/realtime-test", 8000, {
      protocol: "https:",
      host: "xiaozhi.dingdangflash.com",
      hostname: "xiaozhi.dingdangflash.com",
    }),
    "wss://xiaozhi.dingdangflash.com/realtime-test",
  );
});
