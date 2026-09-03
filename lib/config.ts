export const DEFAULT_ADVERTISE_HOST = "192.168.50.188";
export const DEFAULT_OTA_PORT = 8002;
export const DEFAULT_WS_PORT = 8000;
export const DEFAULT_UI_PORT = 3000;
export const DEFAULT_FIRMWARE_VERSION = "2.4.2";
export const BIND_HOST = "0.0.0.0";

export type ServerConfig = {
  advertiseHost: string;
  otaPort: number;
  wsPort: number;
  uiPort: number;
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

export function getWebsocketUrl(config: ServerConfig = getServerConfig()): string {
  return `ws://${config.advertiseHost}:${config.wsPort}/xiaozhi/v1/`;
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
