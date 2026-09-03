import type { WebSocket } from "ws";

const SUBS_KEY = Symbol.for("xiaozhi.listen-stream");

type MonitorSocket = {
  ws: WebSocket;
  sessionId: string | null;
};

function subs(): Set<MonitorSocket> {
  const globalWithStore = globalThis as typeof globalThis & {
    [SUBS_KEY]?: Set<MonitorSocket>;
  };
  if (!globalWithStore[SUBS_KEY]) {
    globalWithStore[SUBS_KEY] = new Set();
  }
  return globalWithStore[SUBS_KEY];
}

export function addMonitor(ws: WebSocket, sessionId: string | null): MonitorSocket {
  const entry: MonitorSocket = { ws, sessionId };
  subs().add(entry);
  return entry;
}

export function removeMonitor(entry: MonitorSocket): void {
  subs().delete(entry);
}

export function sendStreamHello(
  ws: WebSocket,
  sessionId: string,
  sampleRate: number,
): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(
    JSON.stringify({
      type: "stream",
      sessionId,
      sampleRate,
    }),
  );
}

export function broadcastUplinkPcm(
  sessionId: string,
  pcm: Buffer,
  sampleRate: number,
): void {
  for (const entry of subs()) {
    if (entry.ws.readyState !== entry.ws.OPEN) continue;
    if (entry.sessionId && entry.sessionId !== sessionId) continue;
    entry.ws.send(pcm);
  }
}
