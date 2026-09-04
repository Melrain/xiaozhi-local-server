import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { getRealtimeConfig } from "./config";
import { isListenPaused, isPlaying, patchConnection } from "./device-registry";
import {
  DOWNLINK_SAMPLE_RATE,
  OPUS_FRAME_MS,
  PcmOpusEncoder,
  resamplePcmS16le,
  UPLINK_BAILIAN_RATE,
} from "./opus-audio";
import { interruptPlayback } from "./play-audio";
import {
  getRealtimeStatus,
  patchRealtimeStatus,
  resetRealtimeStatusFromConfig,
} from "./realtime-status";
import { getSessionSocket } from "./session-sockets";

const BRIDGES_KEY = Symbol.for("xiaozhi.realtime-bridges");
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const PING_MS = 20000;
const INPUT_TRANSCRIPTION_MODEL = "qwen3-asr-flash-realtime";

type BailianEvent = {
  type?: string;
  delta?: string;
  transcript?: string;
  text?: string;
  stash?: string;
  error?: { message?: string; code?: string } | string;
  response?: { id?: string };
  item?: { id?: string };
};

export type RealtimeBridge = {
  appendUplinkPcm(pcm: Buffer, sampleRate: number): void;
  interrupt(reason: string): void;
  dispose(): void;
  isConnected(): boolean;
};

function bridges(): Map<string, SessionBridge> {
  const globalWithStore = globalThis as typeof globalThis & {
    [BRIDGES_KEY]?: Map<string, SessionBridge>;
  };
  if (!globalWithStore[BRIDGES_KEY]) {
    globalWithStore[BRIDGES_KEY] = new Map();
  }
  return globalWithStore[BRIDGES_KEY];
}

function nextEventId(): string {
  return `event_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function sendDeviceJson(sessionId: string, payload: unknown): void {
  const ws = getSessionSocket(sessionId);
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function sendDeviceBinary(sessionId: string, frame: Buffer): void {
  const ws = getSessionSocket(sessionId);
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(frame);
}

function refreshConnectedFlag(): void {
  let connected = false;
  for (const bridge of bridges().values()) {
    if (bridge.isConnected()) {
      connected = true;
      break;
    }
  }
  const config = getRealtimeConfig();
  patchRealtimeStatus({
    configured: config.configured,
    connected,
    model: config.model,
    voice: config.voice,
  });
}

class SessionBridge implements RealtimeBridge {
  private readonly sessionId: string;
  private disposed = false;
  private ws: WebSocket | null = null;
  private connectGeneration = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private backoffMs = RECONNECT_MIN_MS;
  private encoder = new PcmOpusEncoder(DOWNLINK_SAMPLE_RATE);
  private outbound: Buffer[] = [];
  private paceTimer: NodeJS.Timeout | null = null;
  private ttsActive = false;
  private responding = false;
  private audioFinished = false;
  private sentenceText = "";
  private sentenceSent = false;
  private announcedSentence = "";
  private inputTranscript = "";

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.connect();
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  appendUplinkPcm(pcm: Buffer, sampleRate: number): void {
    if (this.disposed || !pcm.length) return;
    if (isListenPaused(this.sessionId)) return;
    if (!this.isConnected()) return;
    const input =
      sampleRate === UPLINK_BAILIAN_RATE
        ? pcm
        : resamplePcmS16le(pcm, sampleRate, UPLINK_BAILIAN_RATE);
    if (!input.length) return;
    this.sendEvent({
      type: "input_audio_buffer.append",
      audio: input.toString("base64"),
    });
  }

  interrupt(reason: string): void {
    const shouldCancel = this.ttsActive || this.responding || this.outbound.length > 0;
    this.clearDownlink();
    interruptPlayback(this.sessionId);
    if (this.ttsActive) {
      sendDeviceJson(this.sessionId, { session_id: this.sessionId, type: "tts", state: "stop" });
    }
    this.ttsActive = false;
    this.responding = false;
    this.audioFinished = false;
    this.sentenceText = "";
    this.sentenceSent = false;
    this.announcedSentence = "";
    patchConnection(this.sessionId, {
      playing: false,
      lastInterruptReason: reason,
    });
    patchRealtimeStatus({ lastInterruptReason: reason });
    if (shouldCancel && this.isConnected()) {
      this.sendEvent({ type: "response.cancel" });
    }
    if (reason) {
      console.log(`[REALTIME] interrupt reason=${reason} session=${this.sessionId.slice(0, 8)}`);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimers();
    this.clearDownlink();
    if (this.ttsActive) {
      sendDeviceJson(this.sessionId, { session_id: this.sessionId, type: "tts", state: "stop" });
      this.ttsActive = false;
      patchConnection(this.sessionId, { playing: false });
    }
    const socket = this.ws;
    this.ws = null;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ event_id: nextEventId(), type: "session.finish" }));
        }
      } catch {
        // ignore
      }
      socket.close();
    }
    this.encoder.dispose();
    patchConnection(this.sessionId, { realtimeConnected: false });
    refreshConnectedFlag();
  }

  private connect(): void {
    if (this.disposed) return;
    const config = getRealtimeConfig();
    if (!config.configured) return;

    this.connectGeneration += 1;
    const generation = this.connectGeneration;
    this.teardownSocket();

    console.log(
      `[REALTIME] connecting model=${config.model} voice=${config.voice} session=${this.sessionId.slice(0, 8)}`,
    );

    const ws = new WebSocket(config.url, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    this.ws = ws;

    ws.on("open", () => {
      if (generation !== this.connectGeneration || this.ws !== ws) return;
      this.backoffMs = RECONNECT_MIN_MS;
      this.sendSessionUpdate();
      this.startPing();
      patchConnection(this.sessionId, { realtimeConnected: true });
      refreshConnectedFlag();
      console.log(`[REALTIME] connected session=${this.sessionId.slice(0, 8)}`);
    });

    ws.on("message", (data) => {
      if (generation !== this.connectGeneration || this.ws !== ws) return;
      this.onMessage(data);
    });

    ws.on("close", (code, reason) => {
      if (generation !== this.connectGeneration || this.disposed) return;
      console.warn(
        `[REALTIME] bailian close code=${code} reason=${reason.toString("utf8") || "-"} session=${this.sessionId.slice(0, 8)}`,
      );
      this.handleDrop();
    });

    ws.on("error", (error) => {
      console.error(`[REALTIME] bailian error session=${this.sessionId.slice(0, 8)}`, error);
    });
  }

  private sendSessionUpdate(): void {
    const config = getRealtimeConfig();
    this.sendEvent({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        voice: config.voice,
        instructions: config.instructions,
        audio: {
          input: { format: { type: "pcm", sample_rate: UPLINK_BAILIAN_RATE } },
          output: { format: { type: "pcm", sample_rate: DOWNLINK_SAMPLE_RATE } },
        },
        input_audio_transcription: { model: INPUT_TRANSCRIPTION_MODEL },
        turn_detection: {
          type: "semantic_vad",
          threshold: 0.5,
          silence_duration_ms: 800,
        },
      },
    });
  }

  private sendEvent(event: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ event_id: nextEventId(), ...event }));
  }

  private onMessage(data: WebSocket.RawData): void {
    const raw = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data as ArrayBuffer).toString("utf8");
    let event: BailianEvent;
    try {
      event = JSON.parse(raw) as BailianEvent;
    } catch {
      console.warn("[REALTIME] non-json from bailian", raw.slice(0, 120));
      return;
    }

    const type = event.type ?? "";
    switch (type) {
      case "error":
        console.error("[REALTIME] bailian error event", event.error);
        break;
      case "session.created":
      case "session.updated":
        patchConnection(this.sessionId, { realtimeConnected: true });
        refreshConnectedFlag();
        break;
      case "response.created":
        this.responding = true;
        this.audioFinished = false;
        this.sentenceText = "";
        this.sentenceSent = false;
        this.announcedSentence = "";
        break;
      case "response.audio.delta":
        this.onAudioDelta(event.delta ?? "");
        break;
      case "response.audio.done":
        this.audioFinished = true;
        this.enqueueFrames(this.encoder.flush());
        this.finishTurnIfIdle();
        break;
      case "response.done":
      case "response.cancelled":
        this.responding = false;
        this.audioFinished = true;
        this.enqueueFrames(this.encoder.flush());
        this.finishTurnIfIdle();
        break;
      case "response.audio_transcript.delta":
        this.sentenceText += event.delta ?? "";
        this.maybeSendSentenceStart();
        break;
      case "response.audio_transcript.done":
        this.sentenceText = event.transcript || this.sentenceText;
        if (this.ttsActive && this.sentenceText.trim() && this.sentenceText.trim() !== this.announcedSentence) {
          sendDeviceJson(this.sessionId, {
            session_id: this.sessionId,
            type: "tts",
            state: "sentence_start",
            text: this.sentenceText.trim(),
          });
          this.sentenceSent = true;
          this.announcedSentence = this.sentenceText.trim();
        }
        if (this.sentenceText) {
          sendDeviceJson(this.sessionId, {
            session_id: this.sessionId,
            type: "llm",
            emotion: "happy",
            text: this.sentenceText,
          });
        }
        break;
      case "response.text.delta":
        this.sentenceText += event.delta ?? "";
        break;
      case "response.text.done":
        if (event.transcript || event.text) {
          this.sentenceText = event.transcript || event.text || this.sentenceText;
        }
        break;
      case "conversation.item.input_audio_transcription.delta": {
        const preview = `${event.text ?? ""}${event.stash ?? ""}`;
        if (preview) this.inputTranscript = preview;
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const text = event.transcript || event.text || this.inputTranscript;
        this.inputTranscript = "";
        if (text) {
          sendDeviceJson(this.sessionId, { session_id: this.sessionId, type: "stt", text });
        }
        break;
      }
      case "input_audio_buffer.speech_started":
        if (this.ttsActive || this.responding || this.outbound.length > 0 || isPlaying(this.sessionId)) {
          this.interrupt("speech_started");
        }
        break;
      default:
        break;
    }
  }

  private onAudioDelta(b64: string): void {
    if (!b64) return;
    let pcm: Buffer;
    try {
      pcm = Buffer.from(b64, "base64");
    } catch {
      return;
    }
    if (!pcm.length) return;
    this.beginTurn();
    this.enqueueFrames(this.encoder.push(pcm));
  }

  private beginTurn(): void {
    if (this.ttsActive) {
      this.maybeSendSentenceStart();
      return;
    }
    this.ttsActive = true;
    this.audioFinished = false;
    patchConnection(this.sessionId, { playing: true });
    sendDeviceJson(this.sessionId, { session_id: this.sessionId, type: "tts", state: "start" });
    sendDeviceJson(this.sessionId, {
      session_id: this.sessionId,
      type: "tts",
      state: "sentence_start",
      text: this.sentenceText.trim() || "…",
    });
    this.sentenceSent = true;
    this.announcedSentence = this.sentenceText.trim() || "…";
  }

  private maybeSendSentenceStart(): void {
    if (!this.ttsActive) return;
    const text = this.sentenceText.trim();
    if (!text || text === this.announcedSentence) return;
    if (this.sentenceSent && this.announcedSentence !== "…") return;
    sendDeviceJson(this.sessionId, {
      session_id: this.sessionId,
      type: "tts",
      state: "sentence_start",
      text,
    });
    this.sentenceSent = true;
    this.announcedSentence = text;
  }

  private enqueueFrames(frames: Buffer[]): void {
    if (frames.length === 0) return;
    this.outbound.push(...frames);
    this.ensurePace();
  }

  private sendNextFrame(): void {
    const frame = this.outbound.shift();
    if (frame) {
      sendDeviceBinary(this.sessionId, frame);
      return;
    }
    this.finishTurnIfIdle();
  }

  private ensurePace(): void {
    if (this.paceTimer) return;
    this.sendNextFrame();
    this.paceTimer = setInterval(() => this.sendNextFrame(), OPUS_FRAME_MS);
  }

  private finishTurnIfIdle(): void {
    if (!this.audioFinished || this.outbound.length > 0) return;
    this.stopPace();
    if (!this.ttsActive) return;
    if (!this.sentenceSent) {
      sendDeviceJson(this.sessionId, {
        session_id: this.sessionId,
        type: "tts",
        state: "sentence_start",
        text: this.sentenceText.trim() || " ",
      });
      this.sentenceSent = true;
    }
    sendDeviceJson(this.sessionId, { session_id: this.sessionId, type: "tts", state: "stop" });
    this.ttsActive = false;
    this.responding = false;
    patchConnection(this.sessionId, { playing: false });
    console.log(`[REALTIME] tts stop session=${this.sessionId.slice(0, 8)}`);
  }

  private clearDownlink(): void {
    this.outbound = [];
    this.encoder.reset();
    this.stopPace();
  }

  private stopPace(): void {
    if (!this.paceTimer) return;
    clearInterval(this.paceTimer);
    this.paceTimer = null;
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, PING_MS);
  }

  private stopPing(): void {
    if (!this.pingTimer) return;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private clearTimers(): void {
    this.stopPace();
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private teardownSocket(): void {
    this.stopPing();
    const socket = this.ws;
    this.ws = null;
    if (!socket) return;
    socket.removeAllListeners();
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }

  private handleDrop(): void {
    this.stopPing();
    this.ws = null;
    patchConnection(this.sessionId, { realtimeConnected: false });
    refreshConnectedFlag();
    if (this.disposed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS);
    console.warn(`[REALTIME] reconnect in ${delay}ms session=${this.sessionId.slice(0, 8)}`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

export function logRealtimeStartup(): void {
  const status = resetRealtimeStatusFromConfig();
  if (!status.configured) {
    console.warn("[REALTIME] Realtime disabled: set DASHSCOPE_API_KEY and DASHSCOPE_WORKSPACE_ID");
    return;
  }
  const config = getRealtimeConfig();
  console.log(`[REALTIME] enabled model=${config.model} voice=${config.voice}`);
}

export function attachRealtimeBridge(sessionId: string): RealtimeBridge | null {
  if (!getRealtimeConfig().configured) return null;
  const existing = bridges().get(sessionId);
  if (existing) return existing;
  const bridge = new SessionBridge(sessionId);
  bridges().set(sessionId, bridge);
  return bridge;
}

export function getRealtimeBridge(sessionId: string): RealtimeBridge | undefined {
  return bridges().get(sessionId);
}

export function detachRealtimeBridge(sessionId: string): void {
  const bridge = bridges().get(sessionId);
  if (!bridge) return;
  bridge.dispose();
  bridges().delete(sessionId);
  refreshConnectedFlag();
}

export function isRealtimeConfigured(): boolean {
  return getRealtimeConfig().configured || getRealtimeStatus().configured;
}
