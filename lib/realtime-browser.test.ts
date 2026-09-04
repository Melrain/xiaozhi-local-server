import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import {
  attachBrowserRealtime,
  detachBrowserRealtime,
  isBrowserRealtimeConnected,
} from "./realtime-browser";
import { getRealtimeStatus } from "./realtime-status";

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

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error("timeout");
}

type Harness = {
  browserMessages: Array<Record<string, unknown>>;
  browserBinaries: Buffer[];
  bailianMessages: Array<Record<string, unknown>>;
  sendBailian: (event: Record<string, unknown>) => void;
  sendBrowserPcm: (pcm: Buffer) => void;
  close: () => Promise<void>;
};

const harnesses: Harness[] = [];

async function startHarness(): Promise<Harness> {
  const browserMessages: Array<Record<string, unknown>> = [];
  const browserBinaries: Buffer[] = [];
  const bailianMessages: Array<Record<string, unknown>> = [];
  let bailianSink: (event: Record<string, unknown>) => void = () => undefined;

  const bailianHttp = createServer();
  const bailianWss = new WebSocketServer({ server: bailianHttp });
  bailianWss.on("connection", (ws) => {
    bailianSink = (event) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
    };
    ws.send(JSON.stringify({ type: "session.created" }));
    ws.on("message", (data) => {
      bailianMessages.push(JSON.parse(String(data)) as Record<string, unknown>);
      const event = JSON.parse(String(data)) as { type?: string };
      if (event.type === "session.update") {
        ws.send(JSON.stringify({ type: "session.updated" }));
      }
    });
  });
  const bailianPort = await listen(bailianHttp);

  process.env.DASHSCOPE_API_KEY = "test-key";
  process.env.DASHSCOPE_REALTIME_URL = `ws://127.0.0.1:${bailianPort}`;

  const browserHttp = createServer();
  const browserWss = new WebSocketServer({ server: browserHttp });
  const browserPort = await listen(browserHttp);

  const accepted = new Promise<WebSocket>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("browser accept timeout")), 3000);
    browserWss.on("connection", (ws) => {
      clearTimeout(timer);
      resolve(ws);
    });
  });

  const browserClient = new WebSocket(`ws://127.0.0.1:${browserPort}`);
  browserClient.on("message", (data, isBinary) => {
    if (isBinary) {
      browserBinaries.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      return;
    }
    browserMessages.push(JSON.parse(String(data)) as Record<string, unknown>);
  });
  const browserServerWs = await accepted;
  await new Promise<void>((resolve, reject) => {
    if (browserClient.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    browserClient.once("open", () => resolve());
    browserClient.once("error", reject);
  });

  attachBrowserRealtime(browserServerWs);
  await waitFor(() => isBrowserRealtimeConnected());

  const harness: Harness = {
    browserMessages,
    browserBinaries,
    bailianMessages,
    sendBailian: (event) => bailianSink(event),
    sendBrowserPcm: (pcm) => {
      if (browserClient.readyState === WebSocket.OPEN) browserClient.send(pcm);
    },
    close: async () => {
      detachBrowserRealtime();
      browserClient.close();
      bailianWss.close();
      browserWss.close();
      await Promise.all([
        new Promise<void>((resolve) => bailianHttp.close(() => resolve())),
        new Promise<void>((resolve) => browserHttp.close(() => resolve())),
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

test("browser realtime becomes ready and does not reconnect after disconnect", async () => {
  const harness = await startHarness();
  assert.equal(getRealtimeStatus().browserConnected, true);
  assert.ok(harness.browserMessages.some((message) => message.type === "ready"));
  assert.ok(harness.bailianMessages.some((message) => message.type === "session.update"));

  detachBrowserRealtime();
  await waitFor(() => !isBrowserRealtimeConnected());
  assert.equal(getRealtimeStatus().browserConnected, false);
  const updates = harness.bailianMessages.filter((message) => message.type === "session.update").length;
  await sleep(200);
  assert.equal(
    harness.bailianMessages.filter((message) => message.type === "session.update").length,
    updates,
    "disconnect must not reconnect",
  );
});

test("browser pcm is forwarded and transcripts plus audio come back", async () => {
  const harness = await startHarness();
  harness.sendBrowserPcm(Buffer.alloc(3200));
  await waitFor(() =>
    harness.bailianMessages.some((message) => message.type === "input_audio_buffer.append"),
  );

  harness.sendBailian({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "你好",
  });
  harness.sendBailian({
    type: "response.audio_transcript.done",
    transcript: "在的",
  });
  harness.sendBailian({
    type: "response.audio.delta",
    delta: Buffer.from("abcd").toString("base64"),
  });
  harness.sendBailian({ type: "response.audio.done" });

  await waitFor(() =>
    harness.browserMessages.some((message) => message.type === "user" && message.transcript === "你好"),
  );
  await waitFor(() =>
    harness.browserMessages.some(
      (message) => message.type === "assistant" && message.transcript === "在的",
    ),
  );
  await waitFor(() => harness.browserBinaries.length > 0);
  assert.equal(harness.browserBinaries[0]?.toString(), "abcd");
});
