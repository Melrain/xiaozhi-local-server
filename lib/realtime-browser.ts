import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { getRealtimeConfig } from "./config";
import { buildRealtimeSessionUpdate } from "./realtime-session";
import { patchRealtimeStatus } from "./realtime-status";

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

type BailianEvent = {
  type?: string;
  delta?: string;
  transcript?: string;
  text?: string;
  stash?: string;
  error?: { message?: string; code?: string } | string;
};

let current: BrowserRealtimeSession | null = null;

function nextEventId(): string {
  return `event_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function errorMessage(error: BailianEvent["error"]): string {
  if (!error) return "百炼返回错误";
  if (typeof error === "string") return error;
  return error.message || error.code || "百炼返回错误";
}

function refreshBrowserFlag(): void {
  patchRealtimeStatus({ browserConnected: current?.isReady() === true });
}

class BrowserRealtimeSession {
  private readonly browserWs: WebSocket;
  private disposed = false;
  private bailian: WebSocket | null = null;
  private ready = false;
  private audioBytes = 0;

  constructor(browserWs: WebSocket) {
    this.browserWs = browserWs;
    this.connect();
    browserWs.on("message", (data, isBinary) => this.onBrowserMessage(data, isBinary));
    browserWs.on("close", () => this.dispose());
    browserWs.on("error", () => this.dispose());
  }

  isReady(): boolean {
    return this.ready && this.bailian?.readyState === WebSocket.OPEN;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    const bailian = this.bailian;
    this.bailian = null;
    if (bailian && (bailian.readyState === WebSocket.OPEN || bailian.readyState === WebSocket.CONNECTING)) {
      try {
        if (bailian.readyState === WebSocket.OPEN) {
          bailian.send(JSON.stringify({ event_id: nextEventId(), type: "session.finish" }));
        }
      } catch {
        // ignore
      }
      bailian.close();
    }
    if (this.browserWs.readyState === WebSocket.OPEN) {
      sendJson(this.browserWs, { type: "closed" });
      this.browserWs.close();
    }
    if (current === this) current = null;
    refreshBrowserFlag();
    console.log("[REALTIME-TEST] disposed");
  }

  private connect(): void {
    const config = getRealtimeConfig();
    if (!config.configured) {
      sendJson(this.browserWs, { type: "error", message: "未配置 DASHSCOPE_API_KEY 与接入地址" });
      this.dispose();
      return;
    }

    console.log(`[REALTIME-TEST] connecting model=${config.model} voice=${config.voice}`);
    const ws = new WebSocket(config.url, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    this.bailian = ws;

    ws.on("open", () => {
      if (this.disposed || this.bailian !== ws) return;
      this.sendBailian(buildRealtimeSessionUpdate(config));
    });

    ws.on("message", (data) => {
      if (this.disposed || this.bailian !== ws) return;
      this.onBailianMessage(data);
    });

    ws.on("close", (code, reason) => {
      if (this.disposed || this.bailian !== ws) return;
      const detail = reason.toString("utf8") || `close_${code}`;
      console.warn(`[REALTIME-TEST] bailian close ${detail}`);
      sendJson(this.browserWs, { type: "error", message: `百炼连接已断开（${detail}）` });
      this.dispose();
    });

    ws.on("error", (error) => {
      console.error("[REALTIME-TEST] bailian error", error);
      if (this.disposed) return;
      sendJson(this.browserWs, {
        type: "error",
        message: error instanceof Error ? error.message : "百炼连接失败",
      });
    });
  }

  private sendBailian(event: Record<string, unknown>): void {
    if (!this.bailian || this.bailian.readyState !== WebSocket.OPEN) return;
    this.bailian.send(JSON.stringify({ event_id: nextEventId(), ...event }));
  }

  private onBrowserMessage(data: WebSocket.RawData, isBinary: boolean): void {
    if (this.disposed) return;
    if (isBinary) {
      const pcm = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (pcm.length < 2 || !this.ready) return;
      this.sendBailian({
        type: "input_audio_buffer.append",
        audio: pcm.toString("base64"),
      });
      return;
    }
    const raw = typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8");
    try {
      const event = JSON.parse(raw) as { type?: string };
      if (event.type === "disconnect") this.dispose();
    } catch {
      // ignore
    }
  }

  private onBailianMessage(data: WebSocket.RawData): void {
    const raw = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data as ArrayBuffer).toString("utf8");
    let event: BailianEvent;
    try {
      event = JSON.parse(raw) as BailianEvent;
    } catch {
      return;
    }

    const type = event.type ?? "";
    switch (type) {
      case "error":
        sendJson(this.browserWs, { type: "error", message: errorMessage(event.error) });
        break;
      case "session.created":
        break;
      case "session.updated": {
        this.ready = true;
        refreshBrowserFlag();
        const config = getRealtimeConfig();
        sendJson(this.browserWs, {
          type: "ready",
          model: config.model,
          voice: config.voice,
          inputRate: INPUT_SAMPLE_RATE,
          outputRate: OUTPUT_SAMPLE_RATE,
        });
        console.log("[REALTIME-TEST] ready");
        break;
      }
      case "input_audio_buffer.speech_started":
        sendJson(this.browserWs, { type: "speech", started: true });
        break;
      case "input_audio_buffer.speech_stopped":
        sendJson(this.browserWs, { type: "speech", started: false });
        break;
      case "conversation.item.input_audio_transcription.delta":
        sendJson(this.browserWs, {
          type: "user",
          transcript: `${event.text ?? ""}${event.stash ?? ""}`,
          partial: true,
        });
        break;
      case "conversation.item.input_audio_transcription.completed":
        sendJson(this.browserWs, {
          type: "user",
          transcript: event.transcript ?? "",
          partial: false,
        });
        break;
      case "response.audio_transcript.delta":
        sendJson(this.browserWs, {
          type: "assistant",
          transcript: event.delta ?? "",
          partial: true,
        });
        break;
      case "response.audio_transcript.done":
        sendJson(this.browserWs, {
          type: "assistant",
          transcript: event.transcript ?? "",
          partial: false,
        });
        break;
      case "response.audio.delta": {
        if (!event.delta) break;
        const pcm = Buffer.from(event.delta, "base64");
        this.audioBytes += pcm.length;
        if (this.browserWs.readyState === WebSocket.OPEN) {
          this.browserWs.send(pcm);
        }
        break;
      }
      case "response.audio.done":
      case "response.done":
        if (this.audioBytes > 0) {
          const seconds = this.audioBytes / 2 / OUTPUT_SAMPLE_RATE;
          console.log(
            `[REALTIME-TEST] tts pcm=${this.audioBytes}B duration=${seconds.toFixed(2)}s`,
          );
          this.audioBytes = 0;
        }
        break;
      default:
        break;
    }
  }
}

export function attachBrowserRealtime(ws: WebSocket): boolean {
  current?.dispose();
  current = new BrowserRealtimeSession(ws);
  return true;
}

export function detachBrowserRealtime(): void {
  current?.dispose();
}

export function isBrowserRealtimeConnected(): boolean {
  return current?.isReady() === true;
}
