import { WebSocket } from "ws";
import { isPlaying, patchConnection } from "./device-registry";
import { audioFileToOpusFrames } from "./opus-audio";
import {
  getOpenSession,
  getSessionSocket,
  setPendingPlay,
} from "./session-sockets";

const FRAME_MS = 60;
const TEST_SENTENCE = "你好，我是小智本地服务。如果你能听到这段话，说明喇叭已经通了。";
const PLAY_GEN_KEY = Symbol.for("xiaozhi.play-generation");

function playGenerations(): Map<string, number> {
  const globalWithStore = globalThis as typeof globalThis & {
    [PLAY_GEN_KEY]?: Map<string, number>;
  };
  if (!globalWithStore[PLAY_GEN_KEY]) {
    globalWithStore[PLAY_GEN_KEY] = new Map();
  }
  return globalWithStore[PLAY_GEN_KEY];
}

function bumpPlayGeneration(sessionId: string): number {
  const next = (playGenerations().get(sessionId) ?? 0) + 1;
  playGenerations().set(sessionId, next);
  return next;
}

export type PlayResult = {
  ok: boolean;
  queued?: boolean;
  sessionId?: string;
  frames?: number;
  error?: string;
};

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function playOpusToSession(
  sessionId: string,
  frames: Buffer[],
  text = TEST_SENTENCE,
): Promise<void> {
  const ws = getSessionSocket(sessionId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("device socket is not open");
  }

  const generation = bumpPlayGeneration(sessionId);
  patchConnection(sessionId, { playing: true });
  sendJson(ws, { session_id: sessionId, type: "tts", state: "start" });
  sendJson(ws, { session_id: sessionId, type: "tts", state: "sentence_start", text });

  try {
    for (const frame of frames) {
      if (playGenerations().get(sessionId) !== generation) {
        console.log(`[PLAY] interrupted session_id=${sessionId}`);
        return;
      }
      if (ws.readyState !== WebSocket.OPEN) {
        throw new Error("socket closed while sending audio");
      }
      ws.send(frame);
      await sleep(FRAME_MS);
    }
    if (playGenerations().get(sessionId) !== generation) return;
    sendJson(ws, { session_id: sessionId, type: "tts", state: "stop" });
    console.log(`[PLAY] sent ${frames.length} opus frames session_id=${sessionId}`);
  } finally {
    if (playGenerations().get(sessionId) === generation) {
      patchConnection(sessionId, { playing: false });
    }
  }
}

export function interruptPlayback(sessionId: string): boolean {
  bumpPlayGeneration(sessionId);
  if (!isPlaying(sessionId)) return false;
  const ws = getSessionSocket(sessionId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendJson(ws, { session_id: sessionId, type: "tts", state: "stop" });
  }
  patchConnection(sessionId, { playing: false });
  return true;
}

export async function playAudioFileToDevice(
  filePath: string,
  oggPath: string,
  sessionId?: string,
): Promise<PlayResult> {
  const target = sessionId
    ? { sessionId, ws: getSessionSocket(sessionId) }
    : getOpenSession();

  if (!target?.ws || target.ws.readyState !== target.ws.OPEN) {
    setPendingPlay(filePath);
    console.log(`[PLAY] no device online, queued ${filePath}`);
    return { ok: true, queued: true };
  }

  const frames = await audioFileToOpusFrames(filePath, oggPath);
  await playOpusToSession(target.sessionId, frames);
  return { ok: true, sessionId: target.sessionId, frames: frames.length };
}

export function defaultTestText(): string {
  return TEST_SENTENCE;
}
