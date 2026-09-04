import { getRealtimeConfig } from "./config";

export type RealtimeStatus = {
  configured: boolean;
  connected: boolean;
  model: string;
  voice: string;
  lastInterruptReason: string;
};

const STORE_KEY = Symbol.for("xiaozhi.realtime-status");

function fromConfig(): RealtimeStatus {
  const config = getRealtimeConfig();
  return {
    configured: config.configured,
    connected: false,
    model: config.model,
    voice: config.voice,
    lastInterruptReason: "",
  };
}

function store(): { current: RealtimeStatus } {
  const globalWithStore = globalThis as typeof globalThis & {
    [STORE_KEY]?: { current: RealtimeStatus };
  };
  if (!globalWithStore[STORE_KEY]) {
    globalWithStore[STORE_KEY] = { current: fromConfig() };
  }
  return globalWithStore[STORE_KEY];
}

export function resetRealtimeStatusFromConfig(): RealtimeStatus {
  store().current = fromConfig();
  return store().current;
}

export function patchRealtimeStatus(patch: Partial<RealtimeStatus>): void {
  store().current = { ...store().current, ...patch };
}

export function getRealtimeStatus(): RealtimeStatus {
  return store().current;
}
