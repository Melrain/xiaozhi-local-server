import { WebSocket } from "ws";
import { disposeDeviceMcp } from "./device-mcp";
import { getConnection, removeConnection } from "./device-registry";
import { clearIdleDisconnect } from "./idle-disconnect";
import { detachRealtimeBridge } from "./realtime-bridge";
import { deleteSessionSocket, getOpenSession, getSessionSocket } from "./session-sockets";
import { disposeUplinkMeter } from "./uplink-meter";

export type DisconnectResult = {
  ok: boolean;
  sessionId?: string;
  error?: string;
};

function isUsableSocket(ws: WebSocket | undefined): ws is WebSocket {
  return !!ws && ws.readyState !== WebSocket.CLOSED;
}

function targetSession(sessionId?: string): { sessionId: string; ws: WebSocket } | null {
  if (sessionId) {
    const ws = getSessionSocket(sessionId);
    if (!isUsableSocket(ws)) return null;
    return { sessionId, ws };
  }
  return getOpenSession();
}

function dropSession(sessionId: string): void {
  clearIdleDisconnect(sessionId);
  detachRealtimeBridge(sessionId);
  disposeDeviceMcp(sessionId);
  disposeUplinkMeter(sessionId);
  deleteSessionSocket(sessionId);
  removeConnection(sessionId);
}

function forceClose(ws: WebSocket): void {
  try {
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  } catch {
    // already gone
  }
}

export function disconnectDevice(sessionId?: string): DisconnectResult {
  const target = targetSession(sessionId);
  if (target) {
    dropSession(target.sessionId);
    forceClose(target.ws);
    console.log(`[WS] disconnect requested session_id=${target.sessionId}`);
    return { ok: true, sessionId: target.sessionId };
  }

  if (sessionId && getConnection(sessionId)) {
    dropSession(sessionId);
    console.log(`[WS] disconnect requested session_id=${sessionId}`);
    return { ok: true, sessionId };
  }

  return { ok: false, error: "no device online" };
}
