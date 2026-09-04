import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { BIND_HOST, getServerConfig } from "./config";
import {
  emptyListenFields,
  getConnection,
  getDeviceStatus,
  isListenPaused,
  isPlaying,
  patchConnection,
  pushLevel,
  removeConnection,
  upsertConnection,
} from "./device-registry";
import { denoiseBackend, isDenoiseEnabled, setDenoiseEnabled } from "./denoise";
import { addMonitor, removeMonitor, sendStreamHello } from "./listen-stream";
import {
  disposeDeviceMcp,
  handleDeviceMcpResponse,
  setDeviceVolume,
  shouldStartDeviceMcp,
  startDeviceMcp,
} from "./device-mcp";
import { disconnectDevice } from "./disconnect-device";
import { clearIdleDisconnect, noteDeviceActivity, noteVoiceFrame } from "./idle-disconnect";
import { setListenPaused } from "./listen-control";
import { interruptPlayback, playAudioFileToDevice, TEST_OGG_PATH, TEST_WAV_PATH } from "./play-audio";
import { attachBrowserRealtime } from "./realtime-browser";
import {
  attachRealtimeBridge,
  detachRealtimeBridge,
  getRealtimeBridge,
  logRealtimeStartup,
} from "./realtime-bridge";
import {
  disposeUplinkMeter,
  getUplinkSampleRate,
  measureUplinkFrame,
  resetUplinkMeter,
  setUplinkSampleRateHint,
  takeUplinkPcm,
} from "./uplink-meter";
import {
  deleteSessionSocket,
  getOpenSession,
  setSessionSocket,
  takePendingPlay,
} from "./session-sockets";

const WS_PATHS = new Set(["/xiaozhi/v1", "/xiaozhi/v1/"]);
const LISTEN_STREAM_PATHS = new Set(["/listen-stream", "/listen-stream/"]);
const REALTIME_TEST_PATHS = new Set(["/realtime-test", "/realtime-test/"]);
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
  error?: { code?: number; message?: string };
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
  features?: { mcp?: boolean };
  audio_params?: {
    format?: string;
    sample_rate?: number;
    channels?: number;
    frame_duration?: number;
  };
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

function remoteAddress(req: IncomingMessage): string {
  const forwarded = header(req, "x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "";
  const addr = req.socket.remoteAddress ?? "";
  return addr.startsWith("::ffff:") ? addr.slice(7) : addr;
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
    if (isPlaying(session.id) || isListenPaused(session.id)) return;
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

  if (!method) {
    if (handleDeviceMcpResponse(sessionId, rpc)) return;
    console.log(`[WS] json type=mcp (response id=${id ?? "-"})`);
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
    const sampleRate = message.audio_params?.sample_rate;
    if (sampleRate) setUplinkSampleRateHint(session.id, sampleRate);
    console.log(`[WS] json type=hello sample_rate=${sampleRate || "-"} mcp=${message.features?.mcp ?? "-"}`);
    sendHello(ws, session.id);
    if (shouldStartDeviceMcp(message.features)) {
      startDeviceMcp(session.id);
    } else {
      patchConnection(session.id, { mcpReady: false, mcpError: "设备未声明 MCP" });
    }
    return;
  }

  if (type === "listen") {
    const listenState = message.state ?? "-";
    const listenMode = message.mode ?? getConnection(session.id)?.listenMode ?? "-";
    console.log(`[WS] json type=listen state=${listenState} mode=${listenMode}`);
    if (message.state === "start" || message.state === "detect") {
      noteDeviceActivity(session.id);
    }
    if (message.state === "start") {
      session.opusFrames = 0;
      session.stubSentForBurst = false;
      clearIdle(session);
      resetUplinkMeter(session.id);
      if (isPlaying(session.id)) {
        getRealtimeBridge(session.id)?.interrupt("listen_start");
        interruptPlayback(session.id);
      }
      patchConnection(session.id, {
        ...emptyListenFields(),
        listenState: "start",
        listenMode: message.mode ?? "",
        listenPaused: false,
      });
    } else {
      patchConnection(session.id, {
        listenState,
        listenMode: message.mode || getConnection(session.id)?.listenMode || "",
      });
      if (message.state === "stop") {
        getRealtimeBridge(session.id)?.requestTurn("listen_stop");
      }
    }
    return;
  }

  if (type === "abort") {
    const reason = message.reason || "abort";
    console.log(`[WS] json type=abort reason=${reason}`);
    noteDeviceActivity(session.id);
    clearIdle(session);
    session.stubSentForBurst = true;
    getRealtimeBridge(session.id)?.interrupt(reason);
    interruptPlayback(session.id);
    patchConnection(session.id, { listenState: "abort" });
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
  logRealtimeStartup();
  const httpServer = createServer((req, res) => {
    const reqPath = requestPath(req);
    const method = req.method ?? "GET";

    if (reqPath === "/health" || reqPath === "/status") {
      const status = getDeviceStatus();
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(
        JSON.stringify(
          reqPath === "/health"
            ? { ok: true, service: "xiaozhi-ws", connectedCount: status.connectedCount }
            : status,
        ),
      );
      return;
    }

    if (reqPath === "/listen" && method === "POST") {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const paused = url.searchParams.get("paused") === "1";
        const result = setListenPaused(paused);
        res.writeHead(result.ok ? 200 : 409, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify(result));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "listen failed";
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: message }));
      }
      return;
    }

    if (reqPath === "/disconnect" && method === "POST") {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const sessionId = url.searchParams.get("session") || undefined;
        const result = disconnectDevice(sessionId);
        res.writeHead(result.ok ? 200 : 409, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify(result));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "disconnect failed";
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: message }));
      }
      return;
    }

    if (reqPath === "/volume" && method === "POST") {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const sessionId = url.searchParams.get("session") || undefined;
        const volume = Number(url.searchParams.get("volume"));
        void setDeviceVolume(sessionId, volume)
          .then((result) => {
            const status = result.ok ? 200 : result.error === "invalid volume" ? 400 : 409;
            res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(result));
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : "volume failed";
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: message }));
          });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "volume failed";
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: message }));
      }
      return;
    }

    if (reqPath === "/denoise" && method === "POST") {
      const url = new URL(req.url ?? "/", "http://localhost");
      const enabled = url.searchParams.get("on") !== "0";
      setDenoiseEnabled(enabled);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, enabled, backend: denoiseBackend() }));
      return;
    }

    if (reqPath === "/listen-pcm" && method === "GET") {
      const url = new URL(req.url ?? "/", "http://localhost");
      const sessionId = url.searchParams.get("session") || getOpenSession()?.sessionId;
      if (!sessionId) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, pcm: "", sampleRate: 16000 }));
        return;
      }
      const preview = takeUplinkPcm(sessionId);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(
        JSON.stringify({
          ok: true,
          pcm: preview.pcm.toString("base64"),
          sampleRate: preview.sampleRate,
          denoise: denoiseBackend(),
          denoiseEnabled: isDenoiseEnabled(),
        }),
      );
      return;
    }

    if (reqPath === "/play" && (method === "POST" || method === "GET")) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const sessionId = url.searchParams.get("session") || undefined;
      void playAudioFileToDevice(TEST_WAV_PATH, TEST_OGG_PATH, sessionId)
        .then((result) => {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(result));
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "play failed";
          console.error("[PLAY] failed", error);
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: message }));
        });
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("xiaozhi websocket");
  });

  // Device and monitor streams share one HTTP server; route upgrades by path.
  const deviceWss = new WebSocketServer({ noServer: true });
  const monitorWss = new WebSocketServer({ noServer: true });
  const realtimeTestWss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const reqPath = requestPath(req);
    if (LISTEN_STREAM_PATHS.has(reqPath)) {
      monitorWss.handleUpgrade(req, socket, head, (ws) => {
        monitorWss.emit("connection", ws, req);
      });
      return;
    }
    if (REALTIME_TEST_PATHS.has(reqPath)) {
      realtimeTestWss.handleUpgrade(req, socket, head, (ws) => {
        realtimeTestWss.emit("connection", ws, req);
      });
      return;
    }
    if (WS_PATHS.has(reqPath)) {
      deviceWss.handleUpgrade(req, socket, head, (ws) => {
        deviceWss.emit("connection", ws, req);
      });
      return;
    }
    socket.destroy();
  });

  realtimeTestWss.on("connection", (ws) => {
    console.log("[REALTIME-TEST] browser connect");
    attachBrowserRealtime(ws);
  });

  monitorWss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const sessionId = url.searchParams.get("session");
    const entry = addMonitor(ws, sessionId);
    const target = sessionId
      ? getConnection(sessionId)
      : getDeviceStatus().devices[0];
    if (target) {
      sendStreamHello(ws, target.sessionId, getUplinkSampleRate(target.sessionId));
    }
    console.log(`[LISTEN] monitor connect session=${sessionId || "auto"}`);
    ws.on("close", () => {
      removeMonitor(entry);
      console.log("[LISTEN] monitor disconnect");
    });
  });

  deviceWss.on("connection", (ws, req) => {
    const reqPath = requestPath(req);
    const deviceId = header(req, "device-id");
    const clientId = header(req, "client-id");
    const protocolVersion = header(req, "protocol-version");
    const authorization = header(req, "authorization");

    console.log(
      `[WS] connect path=${reqPath} Device-Id=${deviceId || "-"} Client-Id=${clientId || "-"} Protocol-Version=${protocolVersion || "-"} Authorization=${authorization ? "yes" : "no"}`,
    );

    const session: Session = {
      id: randomUUID(),
      opusFrames: 0,
      idleTimer: null,
      stubSentForBurst: false,
    };

    upsertConnection({
      sessionId: session.id,
      deviceId: deviceId || "-",
      clientId: clientId || "-",
      protocolVersion: protocolVersion || "",
      remoteAddress: remoteAddress(req),
      connectedAt: Date.now(),
      lastMessageAt: Date.now(),
      opusFrames: 0,
      ...emptyListenFields(),
    });
    setSessionSocket(session.id, ws);
    noteDeviceActivity(session.id);

    // Send hello immediately — waiting for the device hello races and closes 1006.
    sendHello(ws, session.id);
    const realtime = attachRealtimeBridge(session.id);

    const pendingPlay = takePendingPlay();
    if (pendingPlay) {
      setTimeout(() => {
        void playAudioFileToDevice(pendingPlay, TEST_OGG_PATH, session.id).catch((error: unknown) => {
          console.error("[PLAY] pending clip failed", error);
        });
      }, 1500);
    }

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const bytes = Buffer.isBuffer(data)
          ? data.length
          : Buffer.byteLength(data as ArrayBuffer);
        session.opusFrames += 1;
        session.stubSentForBurst = false;
        const frame = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        const meter = measureUplinkFrame(session.id, frame);
        noteVoiceFrame(session.id, meter.level);
        const current = getConnection(session.id);
        patchConnection(session.id, {
          opusFrames: session.opusFrames,
          lastMessageAt: Date.now(),
          lastOpusAt: Date.now(),
          lastOpusBytes: bytes,
          level: meter.level,
          framesPerSec: meter.framesPerSec,
          levelHistory: pushLevel(current?.levelHistory ?? [], meter.level),
        });
        if (session.opusFrames === 1 || session.opusFrames % 25 === 0) {
          console.log(
            `[WS] opus frames=${session.opusFrames} last_bytes=${bytes} level=${meter.level.toFixed(3)}`,
          );
        }
        const uplink = meter.rawPcm ?? meter.pcm;
        if (realtime && uplink) {
          realtime.appendUplinkPcm(uplink, meter.sampleRate);
        } else if (!realtime && !isPlaying(session.id) && !isListenPaused(session.id)) {
          armIdleStub(ws, session);
        }
        return;
      }

      patchConnection(session.id, { lastMessageAt: Date.now() });
      handleText(ws, session, rawToString(data));
    });

    ws.on("close", (code, reason) => {
      clearIdle(session);
      clearIdleDisconnect(session.id);
      detachRealtimeBridge(session.id);
      disposeDeviceMcp(session.id);
      deleteSessionSocket(session.id);
      disposeUplinkMeter(session.id);
      removeConnection(session.id);
      console.log(
        `[WS] close code=${code} reason=${reason.toString("utf8") || "-"} opus_frames=${session.opusFrames} session_id=${session.id}`,
      );
    });

    ws.on("error", (error) => {
      console.error("[WS] socket error", error);
    });
  });

  httpServer.listen(wsPort, BIND_HOST, () => {
    console.log(`[WS] listening on ${BIND_HOST}:${wsPort} paths=/xiaozhi/v1 /listen-stream /realtime-test`);
  });
}
