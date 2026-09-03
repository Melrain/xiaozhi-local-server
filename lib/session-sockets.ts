import type { WebSocket } from "ws";

const SOCKETS_KEY = Symbol.for("xiaozhi.session-sockets");
const PENDING_KEY = Symbol.for("xiaozhi.pending-play");

type SocketStore = Map<string, WebSocket>;

function getSockets(): SocketStore {
  const globalWithStore = globalThis as typeof globalThis & {
    [SOCKETS_KEY]?: SocketStore;
  };
  if (!globalWithStore[SOCKETS_KEY]) {
    globalWithStore[SOCKETS_KEY] = new Map();
  }
  return globalWithStore[SOCKETS_KEY];
}

function pendingStore(): { path: string | null } {
  const globalWithStore = globalThis as typeof globalThis & {
    [PENDING_KEY]?: { path: string | null };
  };
  if (!globalWithStore[PENDING_KEY]) {
    globalWithStore[PENDING_KEY] = { path: null };
  }
  return globalWithStore[PENDING_KEY];
}

export function setSessionSocket(sessionId: string, ws: WebSocket): void {
  getSockets().set(sessionId, ws);
}

export function deleteSessionSocket(sessionId: string): void {
  getSockets().delete(sessionId);
}

export function getSessionSocket(sessionId: string): WebSocket | undefined {
  return getSockets().get(sessionId);
}

export function getOpenSession(): { sessionId: string; ws: WebSocket } | null {
  for (const [sessionId, ws] of getSockets()) {
    if (ws.readyState === ws.OPEN) return { sessionId, ws };
  }
  return null;
}

export function setPendingPlay(filePath: string | null): void {
  pendingStore().path = filePath;
}

export function takePendingPlay(): string | null {
  const store = pendingStore();
  const path = store.path;
  store.path = null;
  return path;
}
