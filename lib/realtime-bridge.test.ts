import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { getConnection, removeConnection, upsertConnection } from "./device-registry";
import { applyListenDetect } from "./listen-detect";
import {
  attachRealtimeBridge,
  detachRealtimeBridge,
  getRealtimeBridge,
  interruptRealtime,
} from "./realtime-bridge";
import { setSessionSocket } from "./session-sockets";

function loudPcm(bytes = 16000): Buffer {
  const pcm = Buffer.alloc(bytes);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(22000, i);
  return pcm;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function waitFor(
  check: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error("timeout");
}

type Harness = {
  sessionId: string;
  deviceMessages: Array<Record<string, unknown>>;
  bailianMessages: Array<Record<string, unknown>>;
  sendBailian: (event: Record<string, unknown>) => void;
  closeBailian: () => void;
  close: () => Promise<void>;
};

const harnesses: Harness[] = [];

async function startHarness(): Promise<Harness> {
  const deviceMessages: Array<Record<string, unknown>> = [];
  const bailianMessages: Array<Record<string, unknown>> = [];
  let bailianSink: (event: Record<string, unknown>) => void = () => undefined;
  const sendBailian = (event: Record<string, unknown>) => bailianSink(event);

  const bailianHttp = createServer();
  const bailianWss = new WebSocketServer({ server: bailianHttp });
  bailianWss.on("connection", (ws) => {
    bailianSink = (event) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
    };
    ws.send(JSON.stringify({ type: "session.created" }));
    ws.on("message", (data) => {
      const event = JSON.parse(String(data)) as Record<string, unknown>;
      bailianMessages.push(event);
      if (event.type === "session.update") {
        ws.send(JSON.stringify({ type: "session.updated" }));
      }
    });
  });
  const bailianPort = await listen(bailianHttp);

  process.env.DASHSCOPE_API_KEY = "test-key";
  process.env.DASHSCOPE_REALTIME_URL = `ws://127.0.0.1:${bailianPort}`;

  const deviceHttp = createServer();
  const deviceWss = new WebSocketServer({ server: deviceHttp });
  const devicePort = await listen(deviceHttp);
  const sessionId = `test-${bailianPort}-${devicePort}`;

  const deviceReady = new Promise<WebSocket>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("device accept timeout")), 3000);
    deviceWss.on("connection", (ws) => {
      clearTimeout(timer);
      resolve(ws);
    });
  });

  const deviceClient = new WebSocket(`ws://127.0.0.1:${devicePort}`);
  deviceClient.on("message", (data, isBinary) => {
    if (isBinary) return;
    deviceMessages.push(JSON.parse(String(data)) as Record<string, unknown>);
  });
  const deviceServerWs = await deviceReady;
  await new Promise<void>((resolve, reject) => {
    if (deviceClient.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    deviceClient.once("open", () => resolve());
    deviceClient.once("error", reject);
  });

  upsertConnection({
    sessionId,
    deviceId: "test",
    clientId: "test",
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
  });
  setSessionSocket(sessionId, deviceServerWs);
  attachRealtimeBridge(sessionId);

  await waitFor(() => getConnection(sessionId)?.realtimeConnected === true);

  const harness: Harness = {
    sessionId,
    deviceMessages,
    bailianMessages,
    sendBailian,
    closeBailian: () => {
      for (const client of bailianWss.clients) client.close();
    },
    close: async () => {
      detachRealtimeBridge(sessionId);
      removeConnection(sessionId);
      deviceClient.close();
      bailianWss.close();
      deviceWss.close();
      await Promise.all([
        new Promise<void>((resolve) => bailianHttp.close(() => resolve())),
        new Promise<void>((resolve) => deviceHttp.close(() => resolve())),
      ]);
    },
  };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop();
    if (harness) await harness.close();
  }
});

function ttsStates(messages: Array<Record<string, unknown>>): string[] {
  return messages.filter((message) => message.type === "tts").map((message) => String(message.state));
}

test("session.update uses server VAD and uplink only after session.updated", async () => {
  const harness = await startHarness();
  await waitFor(() => harness.bailianMessages.some((message) => message.type === "session.update"));
  const update = harness.bailianMessages.find((message) => message.type === "session.update");
  const session = update?.session as { turn_detection?: { type?: string; create_response?: boolean } };
  assert.equal(session?.turn_detection?.type, "server_vad");
  assert.equal(session?.turn_detection?.create_response, false);
  getRealtimeBridge(harness.sessionId)?.setTurnMode("realtime");
  await waitFor(
    () =>
      harness.bailianMessages.filter((message) => message.type === "session.update").length >= 2,
  );
  const realtimeUpdate = [...harness.bailianMessages]
    .reverse()
    .find((message) => message.type === "session.update");
  const realtimeSession = realtimeUpdate?.session as {
    turn_detection?: { create_response?: boolean };
  };
  assert.equal(realtimeSession?.turn_detection?.create_response, true);

  const before = harness.bailianMessages.filter((message) => message.type === "input_audio_buffer.append").length;
  getRealtimeBridge(harness.sessionId)?.appendUplinkPcm(Buffer.alloc(1920, 1), 16000);
  await waitFor(
    () =>
      harness.bailianMessages.filter((message) => message.type === "input_audio_buffer.append").length > before,
  );
});

test("interrupt ignores cancelled response audio deltas", async () => {
  const harness = await startHarness();
  harness.sendBailian({ type: "response.created", response: { id: "resp_1" } });
  harness.sendBailian({
    type: "response.audio.delta",
    response_id: "resp_1",
    delta: Buffer.alloc(24000 * 2).toString("base64"),
  });
  await waitFor(() => ttsStates(harness.deviceMessages).includes("start"));
  const startsBefore = harness.deviceMessages.filter(
    (message) => message.type === "tts" && message.state === "start",
  ).length;

  interruptRealtime(harness.sessionId, "abort");
  await waitFor(() => ttsStates(harness.deviceMessages).includes("stop"));

  harness.sendBailian({
    type: "response.audio.delta",
    response_id: "resp_1",
    delta: Buffer.alloc(24000 * 2).toString("base64"),
  });
  harness.sendBailian({ type: "response.cancelled", response: { id: "resp_1" } });
  await sleep(200);

  const startsAfter = harness.deviceMessages.filter(
    (message) => message.type === "tts" && message.state === "start",
  ).length;
  assert.equal(startsAfter, startsBefore, "stale audio must not begin a new tts turn");
});

test("bailian drop while speaking sends tts stop", async () => {
  const harness = await startHarness();
  harness.sendBailian({ type: "response.created", response: { id: "resp_drop" } });
  harness.sendBailian({
    type: "response.audio.delta",
    response_id: "resp_drop",
    delta: Buffer.alloc(24000 * 2).toString("base64"),
  });
  await waitFor(() => ttsStates(harness.deviceMessages).includes("start"));
  harness.closeBailian();
  await waitFor(() => ttsStates(harness.deviceMessages).includes("stop"));
  await waitFor(() => getConnection(harness.sessionId)?.lastInterruptReason === "bailian_drop");
  assert.equal(getConnection(harness.sessionId)?.playing, false);
});

test("detect wake word sends STT + tts stop and starts a text greeting turn", async () => {
  const harness = await startHarness();
  const sent: Array<Record<string, unknown>> = [];
  const result = applyListenDetect({
    sessionId: harness.sessionId,
    text: "你好小智",
    sendJson: (payload) => {
      sent.push(payload as Record<string, unknown>);
      harness.deviceMessages.push(payload as Record<string, unknown>);
    },
  });
  assert.equal(result.kind, "wake-greet");
  assert.equal(result.sendTtsStop, true);
  assert.equal(result.greetedViaRealtime, true);
  assert.equal(sent[0]?.type, "stt");
  assert.equal(sent[0]?.text, "你好小智");
  assert.equal(sent[1]?.type, "tts");
  assert.equal(sent[1]?.state, "stop");

  await waitFor(() =>
    harness.bailianMessages.some((message) => message.type === "input_audio_buffer.clear"),
  );
  await waitFor(() =>
    harness.bailianMessages.some((message) => message.type === "conversation.item.create"),
  );
  await waitFor(() => harness.bailianMessages.some((message) => message.type === "response.create"));
  const item = harness.bailianMessages.find((message) => message.type === "conversation.item.create");
  const content = (item?.item as { content?: Array<{ text?: string }> })?.content;
  assert.equal(content?.[0]?.text, "嘿，你好呀");
});

test("listen_stop after detect does not create a turn until the user speaks again", async () => {
  const harness = await startHarness();
  const bridge = getRealtimeBridge(harness.sessionId);
  assert.ok(bridge);
  bridge.appendUplinkPcm(loudPcm(8000), 16000);
  await waitFor(() =>
    harness.bailianMessages.some((message) => message.type === "input_audio_buffer.append"),
  );
  applyListenDetect({
    sessionId: harness.sessionId,
    text: "你好小智",
    sendJson: () => undefined,
    enableGreeting: false,
  });
  await waitFor(() =>
    harness.bailianMessages.some((message) => message.type === "input_audio_buffer.clear"),
  );
  const createsAfterDetect = harness.bailianMessages.filter(
    (message) => message.type === "response.create",
  ).length;
  bridge.requestTurn("listen_stop");
  await sleep(80);
  assert.equal(
    harness.bailianMessages.filter((message) => message.type === "response.create").length,
    createsAfterDetect,
    "wake-word listen_stop must not start a Realtime turn",
  );

  bridge.appendUplinkPcm(loudPcm(8000), 16000);
  await waitFor(
    () =>
      harness.bailianMessages.filter((message) => message.type === "input_audio_buffer.append")
        .length >= 2,
  );
  bridge.requestTurn("listen_stop");
  await waitFor(() =>
    harness.bailianMessages.filter((message) => message.type === "response.create").length >
    createsAfterDetect,
  );
});

test("response.done after audio always emits tts stop so listening can resume", async () => {
  const harness = await startHarness();
  harness.sendBailian({ type: "response.created", response: { id: "resp_done" } });
  harness.sendBailian({
    type: "response.audio.delta",
    response_id: "resp_done",
    delta: Buffer.alloc(4800).toString("base64"),
  });
  await waitFor(() => ttsStates(harness.deviceMessages).includes("start"));
  harness.sendBailian({ type: "response.done", response: { id: "resp_done" } });
  await waitFor(() => ttsStates(harness.deviceMessages).includes("stop"));
  assert.equal(getConnection(harness.sessionId)?.playing, false);
});

test("output_audio event aliases still start and stop device TTS", async () => {
  const harness = await startHarness();
  harness.sendBailian({ type: "response.created", response: { id: "resp_alias" } });
  harness.sendBailian({
    type: "response.output_audio.delta",
    response_id: "resp_alias",
    delta: Buffer.alloc(4800).toString("base64"),
  });
  await waitFor(() => ttsStates(harness.deviceMessages).includes("start"));
  harness.sendBailian({
    type: "response.output_audio.done",
    response_id: "resp_alias",
  });
  await waitFor(() => ttsStates(harness.deviceMessages).includes("stop"));
});
