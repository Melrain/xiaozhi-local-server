import { getConnection, isSessionBusy } from "./device-registry";

const STORE_KEY = Symbol.for("xiaozhi.idle-disconnect");

export const IDLE_DISCONNECT_MS = 30_000;
export const IDLE_VOICE_LEVEL = 0.12;

type Slot = {
  timer: NodeJS.Timeout;
  idleMs: number;
};

function slots(): Map<string, Slot> {
  const globalWithStore = globalThis as typeof globalThis & {
    [STORE_KEY]?: Map<string, Slot>;
  };
  if (!globalWithStore[STORE_KEY]) {
    globalWithStore[STORE_KEY] = new Map();
  }
  return globalWithStore[STORE_KEY];
}

export function clearIdleDisconnect(sessionId: string): void {
  const slot = slots().get(sessionId);
  if (!slot) return;
  clearTimeout(slot.timer);
  slots().delete(sessionId);
}

export function noteDeviceActivity(sessionId: string, idleMs = IDLE_DISCONNECT_MS): void {
  clearIdleDisconnect(sessionId);
  const timer = setTimeout(() => {
    slots().delete(sessionId);
    void onIdle(sessionId, idleMs);
  }, idleMs);
  slots().set(sessionId, { timer, idleMs });
}

export function noteVoiceFrame(sessionId: string, level: number, idleMs = IDLE_DISCONNECT_MS): void {
  if (level < IDLE_VOICE_LEVEL) return;
  noteDeviceActivity(sessionId, idleMs);
}

function deferIfBusy(sessionId: string, idleMs: number): boolean {
  if (!getConnection(sessionId)) return true;
  if (!isSessionBusy(sessionId)) return false;
  noteDeviceActivity(sessionId, idleMs);
  return true;
}

async function onIdle(sessionId: string, idleMs: number): Promise<void> {
  if (deferIfBusy(sessionId, idleMs)) return;
  const { disconnectDevice } = await import("./disconnect-device");
  if (slots().has(sessionId)) return;
  if (deferIfBusy(sessionId, idleMs)) return;
  console.log(`[WS] idle disconnect after ${idleMs / 1000}s session_id=${sessionId}`);
  disconnectDevice(sessionId);
}
