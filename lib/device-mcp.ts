import { WebSocket } from "ws";
import { patchConnection } from "./device-registry";
import { getOpenSession, getSessionSocket } from "./session-sockets";

const MCP_TIMEOUT_MS = 4000;
const STORE_KEY = Symbol.for("xiaozhi.device-mcp");

export const SET_VOLUME_TOOL = "self.audio_speaker.set_volume";
export const GET_STATUS_TOOL = "self.get_device_status";

export type JsonRpc = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

export type VolumeResult = {
  ok: boolean;
  volume?: number;
  sessionId?: string;
  error?: string;
};

type PendingCall = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type SessionMcp = {
  nextId: number;
  pending: Map<number, PendingCall>;
  initialized: boolean;
  initializing?: Promise<void>;
};

type Store = Map<string, SessionMcp>;

function getStore(): Store {
  const globalWithStore = globalThis as typeof globalThis & { [STORE_KEY]?: Store };
  if (!globalWithStore[STORE_KEY]) {
    globalWithStore[STORE_KEY] = new Map();
  }
  return globalWithStore[STORE_KEY];
}

function getOrCreate(sessionId: string): SessionMcp {
  const store = getStore();
  const current = store.get(sessionId);
  if (current) return current;
  const created: SessionMcp = { nextId: 1, pending: new Map(), initialized: false };
  store.set(sessionId, created);
  return created;
}

function targetSession(sessionId?: string): { sessionId: string; ws: WebSocket } | null {
  if (sessionId) {
    const ws = getSessionSocket(sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return null;
    return { sessionId, ws };
  }
  return getOpenSession();
}

export function shouldStartDeviceMcp(features?: { mcp?: boolean }): boolean {
  return features?.mcp !== false;
}

export function clampVolume(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function extractTextContent(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) =>
      item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
        ? (item as { text: string }).text
        : "",
    )
    .filter(Boolean)
    .join("");
}

function readVolume(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const volume = (value as { audio_speaker?: { volume?: unknown } }).audio_speaker?.volume;
  if (typeof volume === "number") {
    const clamped = clampVolume(volume);
    return clamped === null ? undefined : clamped;
  }
  return undefined;
}

export function parseSpeakerVolume(result: unknown): number | undefined {
  const direct = readVolume(result);
  if (direct !== undefined) return direct;

  const text = extractTextContent(result);
  if (!text) return undefined;
  try {
    return readVolume(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function toolErrorMessage(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  if ((result as { isError?: boolean }).isError !== true) return undefined;
  return extractTextContent(result) || "mcp tool error";
}

export function buildMcpEnvelope(
  sessionId: string,
  id: number,
  method: string,
  params: Record<string, unknown> = {},
) {
  return {
    session_id: sessionId,
    type: "mcp",
    payload: {
      jsonrpc: "2.0",
      id,
      method,
      params,
    },
  };
}

export function handleDeviceMcpResponse(sessionId: string, rpc: JsonRpc): boolean {
  if (rpc.method) return false;
  if (rpc.id === undefined || rpc.id === null) return false;
  const id = typeof rpc.id === "number" ? rpc.id : Number(rpc.id);
  if (!Number.isFinite(id)) return false;
  const pending = getStore().get(sessionId)?.pending.get(id);
  if (!pending) return false;
  clearTimeout(pending.timer);
  getStore().get(sessionId)?.pending.delete(id);
  if (rpc.error) {
    pending.reject(new Error(rpc.error.message || "mcp error"));
  } else {
    pending.resolve(rpc.result);
  }
  return true;
}

export function disposeDeviceMcp(sessionId: string): void {
  const state = getStore().get(sessionId);
  if (!state) return;
  for (const pending of state.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error("session closed"));
  }
  getStore().delete(sessionId);
}

function sendMcpRequest(
  sessionId: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const ws = getSessionSocket(sessionId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("no device online"));
  }
  const state = getOrCreate(sessionId);
  const id = state.nextId;
  state.nextId += 1;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error("mcp timeout"));
    }, MCP_TIMEOUT_MS);
    state.pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify(buildMcpEnvelope(sessionId, id, method, params)));
  });
}

export async function ensureDeviceMcp(sessionId: string): Promise<void> {
  const state = getOrCreate(sessionId);
  if (state.initialized) return;
  if (state.initializing) return state.initializing;
  state.initializing = sendMcpRequest(sessionId, "initialize", { capabilities: {} })
    .then(() => {
      state.initialized = true;
    })
    .finally(() => {
      state.initializing = undefined;
    });
  return state.initializing;
}

export async function refreshDeviceVolume(sessionId: string): Promise<number | undefined> {
  await ensureDeviceMcp(sessionId);
  const result = await sendMcpRequest(sessionId, "tools/call", {
    name: GET_STATUS_TOOL,
    arguments: {},
  });
  const toolError = toolErrorMessage(result);
  if (toolError) throw new Error(toolError);
  const volume = parseSpeakerVolume(result);
  patchConnection(sessionId, {
    mcpReady: true,
    mcpError: "",
    ...(volume !== undefined ? { speakerVolume: volume } : {}),
  });
  return volume;
}

export function startDeviceMcp(sessionId: string): void {
  void refreshDeviceVolume(sessionId)
    .then((volume) => {
      console.log(`[MCP] ready session_id=${sessionId} volume=${volume ?? "-"}`);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "mcp failed";
      const initialized = getStore().get(sessionId)?.initialized === true;
      patchConnection(sessionId, {
        mcpReady: initialized,
        mcpError: message,
      });
      console.log(`[MCP] init failed session_id=${sessionId} ${message}`);
    });
}

export async function setDeviceVolume(
  sessionId: string | undefined,
  volume: number,
): Promise<VolumeResult> {
  const clamped = clampVolume(volume);
  if (clamped === null) return { ok: false, error: "invalid volume" };

  const target = targetSession(sessionId);
  if (!target) return { ok: false, error: "no device online" };

  try {
    await ensureDeviceMcp(target.sessionId);
    const result = await sendMcpRequest(target.sessionId, "tools/call", {
      name: SET_VOLUME_TOOL,
      arguments: { volume: clamped },
    });
    const toolError = toolErrorMessage(result);
    if (toolError) {
      return { ok: false, sessionId: target.sessionId, error: toolError };
    }
    patchConnection(target.sessionId, {
      speakerVolume: clamped,
      mcpReady: true,
      mcpError: "",
    });
    console.log(`[MCP] set_volume session_id=${target.sessionId} volume=${clamped}`);
    return { ok: true, volume: clamped, sessionId: target.sessionId };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "volume failed";
    return { ok: false, sessionId: target.sessionId, error: message };
  }
}
