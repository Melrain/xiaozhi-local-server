import assert from "node:assert/strict";
import { test } from "node:test";
import { getWebsocketUrlForRequest, hostFromHeader } from "./config";

test("hostFromHeader strips the OTA port", () => {
  assert.equal(hostFromHeader("192.168.50.189:8002"), "192.168.50.189");
  assert.equal(hostFromHeader("192.168.50.189"), "192.168.50.189");
  assert.equal(hostFromHeader("localhost:8002"), "localhost");
  assert.equal(hostFromHeader("[::1]:8002"), "::1");
  assert.equal(hostFromHeader(""), "");
});

test("OTA websocket URL follows the host the device actually reached", () => {
  const config = {
    advertiseHost: "192.168.50.94",
    otaPort: 8002,
    wsPort: 8000,
    uiPort: 3000,
    publicHost: "",
  };
  assert.equal(
    getWebsocketUrlForRequest("192.168.50.189:8002", config),
    "ws://192.168.50.189:8000/xiaozhi/v1/",
  );
  assert.equal(
    getWebsocketUrlForRequest("", config),
    "ws://192.168.50.94:8000/xiaozhi/v1/",
  );
});

test("HTTPS OTA on the public host advertises wss on 443", () => {
  const config = {
    advertiseHost: "38.207.177.67",
    otaPort: 8002,
    wsPort: 8000,
    uiPort: 13500,
    publicHost: "xiaozhi.dingdangflash.com",
  };
  assert.equal(
    getWebsocketUrlForRequest("xiaozhi.dingdangflash.com", config, "https"),
    "wss://xiaozhi.dingdangflash.com/xiaozhi/v1/",
  );
  assert.equal(
    getWebsocketUrlForRequest("xiaozhi.dingdangflash.com", config),
    "wss://xiaozhi.dingdangflash.com/xiaozhi/v1/",
  );
  assert.equal(
    getWebsocketUrlForRequest("38.207.177.67:8002", config),
    "ws://38.207.177.67:8000/xiaozhi/v1/",
  );
});
