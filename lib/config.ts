export const DEFAULT_ADVERTISE_HOST = "192.168.50.188";
export const DEFAULT_OTA_PORT = 8002;
export const DEFAULT_WS_PORT = 8000;
export const DEFAULT_UI_PORT = 3000;
export const DEFAULT_FIRMWARE_VERSION = "2.4.2";
export const BIND_HOST = "0.0.0.0";
export const DEFAULT_REALTIME_MODEL = "qwen3.5-omni-flash-realtime";
export const DEFAULT_REALTIME_VOICE = "Tina";
export const DEFAULT_REALTIME_INSTRUCTIONS =
  "你是桌面机器人「小智」，性格友善、简洁、口语化。用简短中文陪伴用户，回答清楚即可，不要长篇大论。";

export type ServerConfig = {
  advertiseHost: string;
  otaPort: number;
  wsPort: number;
  uiPort: number;
};

export type RealtimeConfig = {
  apiKey: string;
  workspaceId: string;
  model: string;
  voice: string;
  url: string;
  instructions: string;
  configured: boolean;
};

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getServerConfig(): ServerConfig {
  return {
    advertiseHost: process.env.ADVERTISE_HOST?.trim() || DEFAULT_ADVERTISE_HOST,
    otaPort: readInt("OTA_PORT", DEFAULT_OTA_PORT),
    wsPort: readInt("WS_PORT", DEFAULT_WS_PORT),
    uiPort: readInt("UI_PORT", DEFAULT_UI_PORT),
  };
}

/** Hostname from an HTTP Host header (`192.168.50.189:8002` → `192.168.50.189`). */
export function hostFromHeader(hostHeader: string): string {
  const raw = hostHeader.trim();
  if (!raw) return "";
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end > 0 ? raw.slice(1, end) : raw;
  }
  const lastColon = raw.lastIndexOf(":");
  if (lastColon > 0 && /^\d+$/.test(raw.slice(lastColon + 1))) {
    return raw.slice(0, lastColon);
  }
  return raw;
}

export function getWebsocketUrl(config: ServerConfig = getServerConfig()): string {
  return `ws://${config.advertiseHost}:${config.wsPort}/xiaozhi/v1/`;
}

/** Prefer the host the device just used for OTA, so a stale ADVERTISE_HOST cannot break audio. */
export function getWebsocketUrlForRequest(
  hostHeader: string,
  config: ServerConfig = getServerConfig(),
): string {
  const host = hostFromHeader(hostHeader) || config.advertiseHost;
  return `ws://${host}:${config.wsPort}/xiaozhi/v1/`;
}

export function getOtaUrl(config: ServerConfig = getServerConfig()): string {
  return `http://${config.advertiseHost}:${config.otaPort}/xiaozhi/ota/`;
}

export function getListenStreamUrl(config: ServerConfig = getServerConfig()): string {
  return `ws://${config.advertiseHost}:${config.wsPort}/listen-stream`;
}

export function getUiUrl(config: ServerConfig = getServerConfig()): string {
  return `http://${config.advertiseHost}:${config.uiPort}/`;
}

function withModelQuery(url: string, model: string): string {
  if (!url || url.includes("model=")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}model=${encodeURIComponent(model)}`;
}

export function getRealtimeConfig(): RealtimeConfig {
  const apiKey = process.env.DASHSCOPE_API_KEY?.trim() ?? "";
  const workspaceId = process.env.DASHSCOPE_WORKSPACE_ID?.trim() ?? "";
  const model = process.env.DASHSCOPE_REALTIME_MODEL?.trim() || DEFAULT_REALTIME_MODEL;
  const voice = process.env.DASHSCOPE_REALTIME_VOICE?.trim() || DEFAULT_REALTIME_VOICE;
  const instructions =
    process.env.DASHSCOPE_INSTRUCTIONS?.trim() || DEFAULT_REALTIME_INSTRUCTIONS;
  const overrideUrl = process.env.DASHSCOPE_REALTIME_URL?.trim() ?? "";
  const builtUrl = workspaceId
    ? `wss://${workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(model)}`
    : "";
  const url = overrideUrl ? withModelQuery(overrideUrl, model) : builtUrl;
  return {
    apiKey,
    workspaceId,
    model,
    voice,
    url,
    instructions,
    configured: Boolean(apiKey && url),
  };
}
