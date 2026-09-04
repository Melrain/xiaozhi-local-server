import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { getRealtimeConfig } from "./config";
import { isListenPaused, isPlaying, patchConnection } from "./device-registry";
import {
  claimDownlink,
  getDownlink,
  isDownlinkOwner,
  releaseDownlink,
} from "./downlink-owner";
import {
  DOWNLINK_SAMPLE_RATE,
  OPUS_FRAME_MS,
  PcmOpusEncoder,
  resamplePcmS16le,
  UPLINK_BAILIAN_RATE,
} from "./opus-audio";
import { noteDeviceActivity } from "./idle-disconnect";
import { interruptPlayback } from "./play-audio";
import {
  getRealtimeStatus,
  patchRealtimeStatus,
  resetRealtimeStatusFromConfig,
} from "./realtime-status";
import { buildRealtimeSessionUpdate } from "./realtime-session";
import { getSessionSocket } from "./session-sockets";

const BRIDGES_KEY = Symbol.for("xiaozhi.realtime-bridges");
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const PING_MS = 20000;
const UPLINK_QUEUE_MAX_BYTES = 16000 * 2 * 2;
const LOCAL_VAD_LEVEL = 0.018;
const LOCAL_VAD_SILENCE_MS = 700;

type BailianEvent = {
  type?: string;
  delta?: string;
  transcript?: string;
  text?: string;
  stash?: string;
  response_id?: string;
  error?: { message?: string; code?: string } | string;
  response?: { id?: string };
  item?: { id?: string };
};

function eventResponseId(event: BailianEvent): string | undefined {
  return event.response_id || event.response?.id;
}

export type RealtimeBridge = {
  appendUplinkPcm(pcm: Buffer, sampleRate: number): void;
  interrupt(reason: string): void;
  requestTurn(reason: string): void;
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

function pcmLevel(pcm: Buffer): number {
  const samples = pcm.length / 2;
  if (samples <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 2) {
    const sample = pcm.readInt16LE(i);
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples) / 32768;
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
  private outputGeneration = 0;
  private acceptedGeneration = 0;
  private activeResponseId: string | null = null;
  private cancelledResponseIds = new Set<string>();
  private downlinkGeneration = 0;
  private sessionReady = false;
  private uplinkQueue: Buffer[] = [];
  private uplinkQueueBytes = 0;
  private appendedBytes = 0;
  private serverVadSeen = false;
  private localSpeechSeen = false;
  private lastLoudAt = 0;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.connect();
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private setResponding(value: boolean): void {
    this.responding = value;
    patchConnection(this.sessionId, { responding: value });
    noteDeviceActivity(this.sessionId);
  }

  appendUplinkPcm(pcm: Buffer, sampleRate: number): void {
    if (this.disposed || !pcm.length) return;
    if (isListenPaused(this.sessionId)) return;
    const input =
      sampleRate === UPLINK_BAILIAN_RATE
        ? pcm
        : resamplePcmS16le(pcm, sampleRate, UPLINK_BAILIAN_RATE);
    if (!input.length) return;
    this.observeLocalVad(input);
    if (!this.sessionReady || !this.isConnected()) {
      this.queueUplink(input);
      return;
    }
    this.sendUplink(input);
  }

  requestTurn(reason: string): void {
    this.triggerTurn(reason);
  }

  interrupt(reason: string): void {
    const shouldCancel = this.ttsActive || this.responding || this.outbound.length > 0;
    interruptPlayback(this.sessionId);
    this.stopDeviceTts(reason);
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
    this.sessionReady = false;
    this.uplinkQueue = [];
    this.uplinkQueueBytes = 0;
    this.clearTimers();
    this.stopDeviceTts();
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
    this.sessionReady = false;
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
      setTimeout(() => {
        if (generation !== this.connectGeneration || this.disposed || this.sessionReady) return;
        console.warn(`[REALTIME] session.updated timeout, start uplink anyway session=${this.sessionId.slice(0, 8)}`);
        this.markSessionReady();
      }, 2000);
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
    this.sendEvent(buildRealtimeSessionUpdate(getRealtimeConfig()));
  }

  private queueUplink(pcm: Buffer): void {
    this.uplinkQueue.push(pcm);
    this.uplinkQueueBytes += pcm.length;
    while (this.uplinkQueueBytes > UPLINK_QUEUE_MAX_BYTES && this.uplinkQueue.length > 1) {
      const dropped = this.uplinkQueue.shift();
      if (dropped) this.uplinkQueueBytes -= dropped.length;
    }
  }

  private sendUplink(pcm: Buffer): void {
    this.appendedBytes += pcm.length;
    this.sendEvent({
      type: "input_audio_buffer.append",
      audio: pcm.toString("base64"),
    });
  }

  private flushUplinkQueue(): void {
    if (!this.sessionReady || !this.isConnected()) return;
    const queued = this.uplinkQueue;
    this.uplinkQueue = [];
    this.uplinkQueueBytes = 0;
    for (const chunk of queued) {
      this.sendUplink(chunk);
    }
  }

  private markSessionReady(): void {
    if (this.sessionReady) return;
    this.sessionReady = true;
    this.flushUplinkQueue();
    patchConnection(this.sessionId, { realtimeConnected: true });
    refreshConnectedFlag();
    console.log(`[REALTIME] session ready session=${this.sessionId.slice(0, 8)}`);
  }

  private observeLocalVad(pcm: Buffer): void {
    if (this.serverVadSeen || this.responding || this.ttsActive) return;
    const level = pcmLevel(pcm);
    const now = Date.now();
    if (level >= LOCAL_VAD_LEVEL) {
      this.localSpeechSeen = true;
      this.lastLoudAt = now;
      return;
    }
    if (this.localSpeechSeen && this.lastLoudAt && now - this.lastLoudAt >= LOCAL_VAD_SILENCE_MS) {
      this.localSpeechSeen = false;
      this.triggerTurn("local_vad");
    }
  }

  private triggerTurn(reason: string): void {
    if (this.disposed || !this.sessionReady || !this.isConnected()) return;
    if (this.responding || this.ttsActive) return;
    if (this.appendedBytes < 3200) return;
    console.log(`[REALTIME] turn reason=${reason} session=${this.sessionId.slice(0, 8)}`);
    this.sendEvent({ type: "input_audio_buffer.commit" });
    this.sendEvent({ type: "response.create" });
    this.appendedBytes = 0;
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
        patchConnection(this.sessionId, { realtimeConnected: true });
        refreshConnectedFlag();
        break;
      case "session.updated":
        this.markSessionReady();
        break;
      case "response.created":
        this.activeResponseId = eventResponseId(event) ?? `anon_${this.outputGeneration}`;
        this.acceptedGeneration = this.outputGeneration;
        this.setResponding(true);
        this.audioFinished = false;
        this.sentenceText = "";
        this.sentenceSent = false;
        this.announcedSentence = "";
        console.log(`[REALTIME] response.created session=${this.sessionId.slice(0, 8)}`);
        break;
      case "response.audio.delta":
        this.onAudioDelta(event);
        break;
      case "response.audio.done":
        if (!this.acceptOutput(event)) break;
        this.audioFinished = true;
        this.enqueueFrames(this.encoder.flush());
        this.finishTurnIfIdle();
        break;
      case "response.done":
        this.setResponding(false);
        if (!this.acceptOutput(event)) break;
        this.audioFinished = true;
        this.enqueueFrames(this.encoder.flush());
        this.finishTurnIfIdle();
        break;
      case "response.cancelled": {
        const cancelledId = eventResponseId(event) || this.activeResponseId;
        if (cancelledId) this.cancelledResponseIds.add(cancelledId);
        this.invalidateOutput();
        this.setResponding(false);
        this.encoder.reset();
        if (this.ttsActive || this.outbound.length > 0) {
          this.stopDeviceTts();
        }
        break;
      }
      case "response.audio_transcript.delta":
        if (!this.acceptOutput(event)) break;
        this.sentenceText += event.delta ?? "";
        this.maybeSendSentenceStart();
        break;
      case "response.audio_transcript.done":
        if (!this.acceptOutput(event)) break;
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
          console.log(
            `[REALTIME] llm ${JSON.stringify(this.sentenceText.trim())} session=${this.sessionId.slice(0, 8)}`,
          );
          sendDeviceJson(this.sessionId, {
            session_id: this.sessionId,
            type: "llm",
            emotion: "happy",
            text: this.sentenceText,
          });
        }
        break;
      case "response.text.delta":
        if (this.acceptOutput(event)) this.sentenceText += event.delta ?? "";
        break;
      case "response.text.done":
        if (this.acceptOutput(event) && (event.transcript || event.text)) {
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
          console.log(`[REALTIME] stt ${JSON.stringify(text)} session=${this.sessionId.slice(0, 8)}`);
          sendDeviceJson(this.sessionId, { session_id: this.sessionId, type: "stt", text });
        }
        break;
      }
      case "input_audio_buffer.speech_started":
        this.serverVadSeen = true;
        this.localSpeechSeen = false;
        console.log(`[REALTIME] speech_started session=${this.sessionId.slice(0, 8)}`);
        if (this.ttsActive || this.responding || this.outbound.length > 0 || isPlaying(this.sessionId)) {
          this.interrupt("speech_started");
        }
        break;
      case "input_audio_buffer.speech_stopped":
        console.log(`[REALTIME] speech_stopped session=${this.sessionId.slice(0, 8)}`);
        break;
      default:
        break;
    }
  }

  private onAudioDelta(event: BailianEvent): void {
    if (!this.acceptOutput(event)) return;
    const b64 = event.delta ?? "";
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
    if (!this.acceptOutput()) return;
    if (this.ttsActive) {
      this.maybeSendSentenceStart();
      return;
    }
    this.ttsActive = true;
    this.audioFinished = false;
    this.downlinkGeneration = claimDownlink(this.sessionId, "realtime");
    patchConnection(this.sessionId, { playing: true });
    noteDeviceActivity(this.sessionId);
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
    if (!this.acceptOutput() || frames.length === 0) return;
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
    if (!isDownlinkOwner(this.sessionId, this.downlinkGeneration, "realtime")) {
      this.ttsActive = false;
      this.setResponding(false);
      return;
    }
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
    this.setResponding(false);
    if (releaseDownlink(this.sessionId, this.downlinkGeneration, "realtime")) {
      patchConnection(this.sessionId, { playing: false });
      noteDeviceActivity(this.sessionId);
    }
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

  private eventResponseId(event?: BailianEvent): string | undefined {
    return event ? eventResponseId(event) : undefined;
  }

  private invalidateOutput(): void {
    this.outputGeneration += 1;
    if (this.activeResponseId) {
      this.cancelledResponseIds.add(this.activeResponseId);
      while (this.cancelledResponseIds.size > 32) {
        const first = this.cancelledResponseIds.values().next().value;
        if (!first) break;
        this.cancelledResponseIds.delete(first);
      }
    }
    this.activeResponseId = null;
  }

  private acceptOutput(event?: BailianEvent): boolean {
    const id = this.eventResponseId(event);
    if (id && this.cancelledResponseIds.has(id)) return false;
    if (this.acceptedGeneration !== this.outputGeneration) return false;
    if (id && this.activeResponseId && id !== this.activeResponseId) return false;
    return true;
  }

  private stopDeviceTts(reason?: string): void {
    this.invalidateOutput();
    this.clearDownlink();
    if (this.ttsActive) {
      sendDeviceJson(this.sessionId, { session_id: this.sessionId, type: "tts", state: "stop" });
    }
    this.ttsActive = false;
    this.setResponding(false);
    this.audioFinished = false;
    this.sentenceText = "";
    this.sentenceSent = false;
    this.announcedSentence = "";
    const ownedByPlay = getDownlink(this.sessionId).owner === "play";
    patchConnection(this.sessionId, {
      ...(ownedByPlay ? {} : { playing: false }),
      ...(reason ? { lastInterruptReason: reason } : {}),
    });
    if (!ownedByPlay) noteDeviceActivity(this.sessionId);
    if (reason) patchRealtimeStatus({ lastInterruptReason: reason });
  }

  private handleDrop(): void {
    this.stopPing();
    this.sessionReady = false;
    this.ws = null;
    const reason = this.ttsActive || this.outbound.length > 0 ? "bailian_drop" : undefined;
    this.stopDeviceTts(reason);
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

export function interruptRealtime(sessionId: string, reason = "interrupt"): boolean {
  const bridge = bridges().get(sessionId);
  if (!bridge) return false;
  bridge.interrupt(reason);
  return true;
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
