import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BIND_HOST, DEFAULT_FIRMWARE_VERSION, getServerConfig, getWebsocketUrl } from "./config";
import { recordOtaSighting } from "./device-registry";

const OTA_PATHS = new Set([
  "/xiaozhi/ota",
  "/xiaozhi/ota/",
  "/xiaozhi/ota/activate",
]);

type OtaBody = {
  application?: {
    version?: string;
  };
};

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("OTA body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function firmwareVersionFromBody(raw: string): string {
  if (!raw.trim()) return DEFAULT_FIRMWARE_VERSION;
  try {
    const parsed = JSON.parse(raw) as OtaBody;
    const version = parsed.application?.version?.trim();
    return version || DEFAULT_FIRMWARE_VERSION;
  } catch {
    return DEFAULT_FIRMWARE_VERSION;
  }
}

function buildOtaPayload(version: string) {
  const websocketUrl = getWebsocketUrl();
  return {
    server_time: {
      timestamp: Date.now(),
      timezone: "Asia/Shanghai",
      timezone_offset: 480,
    },
    firmware: {
      version,
      url: "",
    },
    websocket: {
      url: websocketUrl,
      token: "",
    },
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Device-Id, Client-Id, Authorization, Protocol-Version",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store",
  });
  res.end(json);
}

async function handleOta(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const path = req.url?.split("?")[0] ?? "/";

  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Device-Id, Client-Id, Authorization, Protocol-Version",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    res.end();
    return;
  }

  if (path === "/health") {
    sendJson(res, 200, { ok: true, service: "xiaozhi-ota" });
    return;
  }

  if (!OTA_PATHS.has(path)) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }

  let version = DEFAULT_FIRMWARE_VERSION;
  if (method === "POST") {
    try {
      const raw = await readBody(req);
      version = firmwareVersionFromBody(raw);
    } catch {
      version = DEFAULT_FIRMWARE_VERSION;
    }
  }

  const payload = buildOtaPayload(version);
  const deviceId = header(req, "device-id");
  const clientId = header(req, "client-id");

  if (deviceId || clientId) {
    recordOtaSighting({
      deviceId: deviceId || "-",
      clientId: clientId || "-",
      firmwareVersion: version,
      lastSeenAt: Date.now(),
    });
  }

  console.log(
    `[OTA] ${method} ${path} Device-Id=${deviceId || "-"} Client-Id=${clientId || "-"} websocket=${payload.websocket.url}`,
  );

  sendJson(res, 200, payload);
}

export function startOtaServer(): void {
  const { otaPort } = getServerConfig();
  const server = createServer((req, res) => {
    void handleOta(req, res).catch((error: unknown) => {
      console.error("[OTA] handler error", error);
      if (!res.headersSent) {
        sendJson(res, 200, buildOtaPayload(DEFAULT_FIRMWARE_VERSION));
      }
    });
  });

  server.listen(otaPort, BIND_HOST, () => {
    console.log(`[OTA] listening on ${BIND_HOST}:${otaPort} (advertise ${getWebsocketUrl()})`);
  });
}
