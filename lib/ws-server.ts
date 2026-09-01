import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { BIND_HOST, getServerConfig } from "./config";

const WS_PATHS = new Set(["/xiaozhi/v1", "/xiaozhi/v1/"]);
const OPUS_IDLE_MS = 1800;
const STUB_STT_TEXT = "（本地占位）已收到语音";
const STUB_TTS_TEXT = "本地服务已收到你的语音，语音识别和合成还没有接入。";

type JsonRpc = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: {
    protocolVersion?: string;
  };
  result?: unknown;
};

type XiaoZhiMessage = {
  type?: string;
  state?: string;
  mode?: string;
  reason?: string;
  session_id?: string;
  payload?: JsonRpc | string;
  method?: string;
  id?: string | number | null;
  params?: JsonRpc["params"];
};

type Session = {
  id: string;
  opusFrames: number;
  idleTimer: NodeJS.Timeout | null;
  stubSentForBurst: boolean;
};

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function requestPath(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return req.url?.split("?")[0] ?? "/";
  }
}

function rawToString(data: WebSocket.RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function helloPayload(sessionId: string) {
  return {
    type: "hello",
    transport: "websocket",
    session_id: sessionId,
    audio_params: {
      format: "opus",
      sample_rate: 24000,
      channels: 1,
      frame_duration: 60,
    },
  };
}

function sendHello(ws: WebSocket, sessionId: string): void {
  sendJson(ws, helloPayload(sessionId));
  console.log(`[WS] hello sent session_id=${sessionId}`);
}

function sendStubReplies(ws: WebSocket, sessionId: string): void {
  sendJson(ws, { session_id: sessionId, type: "stt", text: STUB_STT_TEXT });
  sendJson(ws, { session_id: sessionId, type: "llm", emotion: "happy", text: "😀" });
  sendJson(ws, { session_id: sessionId, type: "tts", state: "start" });
  sendJson(ws, {
    session_id: sessionId,
    type: "tts",
    state: "sentence_start",
    text: STUB_TTS_TEXT,
  });
  sendJson(ws, { session_id: sessionId, type: "tts", state: "stop" });
  console.log(`[WS] stub stt/llm/tts sent session_id=${sessionId}`);
}

function clearIdle(session: Session): void {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
}

function armIdleStub(ws: WebSocket, session: Session): void {
  clearIdle(session);
  session.idleTimer = setTimeout(() => {
    session.idleTimer = null;
    if (session.opusFrames <= 0 || session.stubSentForBurst) return;
    session.stubSentForBurst = true;
    sendStubReplies(ws, session.id);
  }, OPUS_IDLE_MS);
}

function unwrapRpc(message: XiaoZhiMessage): JsonRpc {
  if (message.payload && typeof message.payload === "object") {
    return message.payload;
  }
  if (typeof message.payload === "string") {
    try {
      return JSON.parse(message.payload) as JsonRpc;
    } catch {
      return {};
    }
  }
  return {
    method: message.method,
    id: message.id,
    params: message.params,
  };
}

function handleMcp(ws: WebSocket, sessionId: string, message: XiaoZhiMessage): void {
  const rpc = unwrapRpc(message);
  const method = rpc.method ?? "";
  const id = rpc.id;

  if (!method && id === undefined) {
    console.log("[WS] json type=mcp (empty)");
    return;
  }

  if (method.startsWith("notifications/")) {
    console.log(`[WS] json type=mcp method=${method} (notification)`);
    return;
  }

  if (id === undefined || id === null) {
    console.log(`[WS] json type=mcp method=${method} (no id)`);
    return;
  }

  if (method === "initialize") {
    const protocolVersion = rpc.params?.protocolVersion ?? "2024-11-05";
    sendJson(ws, {
      session_id: sessionId,
      type: "mcp",
      payload: {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "xiaozhi-local-server", version: "0.1.0" },
        },
      },
    });
    console.log(`[WS] json type=mcp method=initialize id=${id}`);
    return;
  }

  if (method === "tools/list") {
    sendJson(ws, {
      session_id: sessionId,
      type: "mcp",
      payload: {
        jsonrpc: "2.0",
        id,
        result: { tools: [] },
      },
    });
    console.log(`[WS] json type=mcp method=tools/list id=${id}`);
    return;
  }

  sendJson(ws, {
    session_id: sessionId,
    type: "mcp",
    payload: {
      jsonrpc: "2.0",
      id,
      result: true,
    },
  });
  console.log(`[WS] json type=mcp method=${method || "unknown"} id=${id} result=true`);
}

function handleText(ws: WebSocket, session: Session, raw: string): void {
  let message: XiaoZhiMessage;
  try {
    message = JSON.parse(raw) as XiaoZhiMessage;
  } catch {
    console.log("[WS] text (non-json)", raw.slice(0, 120));
    return;
  }

  const type = message.type ?? "";
  if (type === "hello") {
    console.log("[WS] json type=hello");
    sendHello(ws, session.id);
    return;
  }

  if (type === "listen") {
    console.log(`[WS] json type=listen state=${message.state ?? "-"} mode=${message.mode ?? "-"}`);
    if (message.state === "start") {
      session.opusFrames = 0;
      session.stubSentForBurst = false;
      clearIdle(session);
    }
    return;
  }

  if (type === "abort") {
    console.log(`[WS] json type=abort reason=${message.reason ?? "-"}`);
    clearIdle(session);
    session.stubSentForBurst = true;
    return;
  }

  if (type === "mcp") {
    handleMcp(ws, session.id, message);
    return;
  }

  console.log(`[WS] json type=${type || "unknown"}`);
}

export function startWebsocketServer(): void {
  const { wsPort } = getServerConfig();
  const httpServer = createServer((req, res) => {
    const path = requestPath(req);
    if (path === "/health") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, service: "xiaozhi-ws" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("xiaozhi websocket");
  });

  // One WebSocketServer on the HTTP server — do not attach path-restricted extras.
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws, req) => {
    const path = requestPath(req);
    const deviceId = header(req, "device-id");
    const clientId = header(req, "client-id");
    const protocolVersion = header(req, "protocol-version");
    const authorization = header(req, "authorization");

    console.log(
      `[WS] connect path=${path} Device-Id=${deviceId || "-"} Client-Id=${clientId || "-"} Protocol-Version=${protocolVersion || "-"} Authorization=${authorization ? "yes" : "no"}`,
    );

    if (!WS_PATHS.has(path)) {
      console.log(`[WS] reject path=${path}`);
      ws.close(1008, "invalid path");
      return;
    }

    const session: Session = {
      id: randomUUID(),
      opusFrames: 0,
      idleTimer: null,
      stubSentForBurst: false,
    };

    // Send hello immediately — waiting for the device hello races and closes 1006.
    sendHello(ws, session.id);

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const bytes = Buffer.isBuffer(data)
          ? data.length
          : Buffer.byteLength(data as ArrayBuffer);
        session.opusFrames += 1;
        session.stubSentForBurst = false;
        if (session.opusFrames === 1 || session.opusFrames % 25 === 0) {
          console.log(`[WS] opus frames=${session.opusFrames} last_bytes=${bytes}`);
        }
        armIdleStub(ws, session);
        return;
      }

      handleText(ws, session, rawToString(data));
    });

    ws.on("close", (code, reason) => {
      clearIdle(session);
      console.log(
        `[WS] close code=${code} reason=${reason.toString("utf8") || "-"} opus_frames=${session.opusFrames} session_id=${session.id}`,
      );
    });

    ws.on("error", (error) => {
      console.error("[WS] socket error", error);
    });
  });

  httpServer.listen(wsPort, BIND_HOST, () => {
    console.log(`[WS] listening on ${BIND_HOST}:${wsPort} paths=/xiaozhi/v1 /xiaozhi/v1/`);
  });
}
