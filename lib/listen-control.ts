import { WebSocket } from "ws";
import { getConnection, patchConnection } from "./device-registry";
import { getOpenSession, getSessionSocket } from "./session-sockets";

export type ListenControlResult = {
  ok: boolean;
  paused?: boolean;
  sessionId?: string;
  error?: string;
};

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function targetSession(sessionId?: string): { sessionId: string; ws: WebSocket } | null {
  if (sessionId) {
    const ws = getSessionSocket(sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return null;
    return { sessionId, ws };
  }
  return getOpenSession();
}

export function setListenPaused(paused: boolean, sessionId?: string): ListenControlResult {
  const target = targetSession(sessionId);
  if (!target) {
    return { ok: false, error: "no device online" };
  }

  // Official firmware ignores type=listen from the server. tts start/stop
  // is what actually flips the board between speaking (mic off) and listening.
  if (paused) {
    sendJson(target.ws, { session_id: target.sessionId, type: "tts", state: "start" });
    sendJson(target.ws, {
      session_id: target.sessionId,
      type: "tts",
      state: "sentence_start",
      text: "已暂停听筒",
    });
  } else {
    sendJson(target.ws, { session_id: target.sessionId, type: "tts", state: "stop" });
  }

  patchConnection(target.sessionId, { listenPaused: paused });
  const current = getConnection(target.sessionId);
  console.log(
    `[LISTEN] ${paused ? "pause" : "resume"} session_id=${target.sessionId} mode=${current?.listenMode || "-"}`,
  );
  return { ok: true, paused, sessionId: target.sessionId };
}
