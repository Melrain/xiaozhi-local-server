import { denoiseBackend, isDenoiseEnabled } from "./denoise";

const STORE_KEY = Symbol.for("xiaozhi.device-registry");

export type ConnectedDevice = {
  sessionId: string;
  deviceId: string;
  clientId: string;
  protocolVersion: string;
  remoteAddress: string;
  connectedAt: number;
  lastMessageAt: number;
  opusFrames: number;
  playing?: boolean;
  listenPaused?: boolean;
  listenState: string;
  listenMode: string;
  lastOpusAt: number;
  lastOpusBytes: number;
  level: number;
  framesPerSec: number;
  levelHistory: number[];
};

export type OtaSighting = {
  deviceId: string;
  clientId: string;
  firmwareVersion: string;
  lastSeenAt: number;
};

export type DeviceStatusSnapshot = {
  ok: true;
  connectedCount: number;
  devices: ConnectedDevice[];
  recentOta: OtaSighting[];
  denoiseEnabled?: boolean;
  denoiseBackend?: "rnnoise" | "gate" | "off";
};

const LEVEL_HISTORY = 40;

type Store = {
  connections: Map<string, ConnectedDevice>;
  otaSightings: Map<string, OtaSighting>;
};

export function emptyListenFields(): Pick<
  ConnectedDevice,
  | "listenState"
  | "listenMode"
  | "lastOpusAt"
  | "lastOpusBytes"
  | "level"
  | "framesPerSec"
  | "levelHistory"
> {
  return {
    listenState: "",
    listenMode: "",
    lastOpusAt: 0,
    lastOpusBytes: 0,
    level: 0,
    framesPerSec: 0,
    levelHistory: [],
  };
}

export function pushLevel(history: number[], level: number): number[] {
  const next = [...history, level];
  if (next.length <= LEVEL_HISTORY) return next;
  return next.slice(next.length - LEVEL_HISTORY);
}

function getStore(): Store {
  const globalWithStore = globalThis as typeof globalThis & {
    [STORE_KEY]?: Store;
  };
  if (!globalWithStore[STORE_KEY]) {
    globalWithStore[STORE_KEY] = {
      connections: new Map(),
      otaSightings: new Map(),
    };
  }
  return globalWithStore[STORE_KEY];
}

function sightingKey(deviceId: string, clientId: string): string {
  return `${deviceId || "-"}:${clientId || "-"}`;
}

export function upsertConnection(device: ConnectedDevice): void {
  getStore().connections.set(device.sessionId, device);
}

export function patchConnection(
  sessionId: string,
  patch: Partial<Omit<ConnectedDevice, "sessionId">>,
): void {
  const current = getStore().connections.get(sessionId);
  if (!current) return;
  getStore().connections.set(sessionId, { ...current, ...patch });
}

export function removeConnection(sessionId: string): void {
  getStore().connections.delete(sessionId);
}

export function isPlaying(sessionId: string): boolean {
  return getStore().connections.get(sessionId)?.playing === true;
}

export function isListenPaused(sessionId: string): boolean {
  return getStore().connections.get(sessionId)?.listenPaused === true;
}

export function getConnection(sessionId: string): ConnectedDevice | undefined {
  return getStore().connections.get(sessionId);
}

export function recordOtaSighting(sighting: OtaSighting): void {
  getStore().otaSightings.set(
    sightingKey(sighting.deviceId, sighting.clientId),
    sighting,
  );
}

export function getDeviceStatus(): DeviceStatusSnapshot {
  const store = getStore();
  const devices = [...store.connections.values()].sort(
    (a, b) => b.connectedAt - a.connectedAt,
  );
  const connectedDeviceIds = new Set(
    devices.map((device) => device.deviceId).filter((id) => id && id !== "-"),
  );
  const recentOta = [...store.otaSightings.values()]
    .filter((sighting) => {
      if (sighting.deviceId && sighting.deviceId !== "-") {
        return !connectedDeviceIds.has(sighting.deviceId);
      }
      return !devices.some(
        (device) =>
          sightingKey(device.deviceId, device.clientId) ===
          sightingKey(sighting.deviceId, sighting.clientId),
      );
    })
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, 20);

  return {
    ok: true,
    connectedCount: devices.length,
    devices,
    recentOta,
    denoiseEnabled: isDenoiseEnabled(),
    denoiseBackend: denoiseBackend(),
  };
}
