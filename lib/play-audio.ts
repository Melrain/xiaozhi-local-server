import { WebSocket } from "ws";
import { patchConnection } from "./device-registry";
import { audioFileToOpusFrames } from "./opus-audio";
import {
  getOpenSession,
  getSessionSocket,
  setPendingPlay,
} from "./session-sockets";

const FRAME_MS = 60;
const TEST_SENTENCE = "你好，我是小智本地服务。如果你能听到这段话，说明喇叭已经通了。";

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

  patchConnection(sessionId, { playing: true });
  sendJson(ws, { session_id: sessionId, type: "tts", state: "start" });
  sendJson(ws, { session_id: sessionId, type: "tts", state: "sentence_start", text });

  try {
    for (const frame of frames) {
      if (ws.readyState !== WebSocket.OPEN) {
        throw new Error("socket closed while sending audio");
      }
      ws.send(frame);
      await sleep(FRAME_MS);
    }
    sendJson(ws, { session_id: sessionId, type: "tts", state: "stop" });
    console.log(`[PLAY] sent ${frames.length} opus frames session_id=${sessionId}`);
  } finally {
    patchConnection(sessionId, { playing: false });
  }
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
