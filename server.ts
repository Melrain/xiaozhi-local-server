import { createServer } from "node:http";
import next from "next";
import { BIND_HOST, getRealtimeConfig, getServerConfig, getOtaUrl, getUiUrl, getWebsocketUrl } from "./lib/config";
import { loadLocalEnv } from "./lib/load-env";
import { startDenoise } from "./lib/denoise";
import { startOtaServer } from "./lib/ota-server";
import { startWebsocketServer } from "./lib/ws-server";
import { startWorkers, tryServeWorker } from "./lib/worker-static";

loadLocalEnv();

const config = getServerConfig();
const dev = process.env.NODE_ENV !== "production";

async function main(): Promise<void> {
  const app = next({
    dev,
    hostname: BIND_HOST,
    port: config.uiPort,
  });
  const handle = app.getRequestHandler();
  await app.prepare();

  const uiServer = createServer((req, res) => {
    if (tryServeWorker(req, res)) return;
    void handle(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    uiServer.once("error", reject);
    uiServer.listen(config.uiPort, BIND_HOST, () => resolve());
  });

  startOtaServer();
  startWebsocketServer();
  const workerUrls = startWorkers();
  void startDenoise();

  console.log("");
  console.log("xiaozhi-local-server");
  console.log(`  UI  ${getUiUrl(config)}  (bind ${BIND_HOST}:${config.uiPort})`);
  console.log(`  OTA ${getOtaUrl(config)}  (bind ${BIND_HOST}:${config.otaPort})`);
  console.log(`  WS  ${getWebsocketUrl(config)}  (bind ${BIND_HOST}:${config.wsPort})`);
  const realtime = getRealtimeConfig();
  console.log(
    realtime.configured
      ? `  Realtime ${realtime.model} voice=${realtime.voice}`
      : "  Realtime disabled (stub) — set DASHSCOPE_API_KEY and DASHSCOPE_WORKSPACE_ID",
  );
  for (const url of workerUrls) {
    console.log(`  Worker ${url}`);
  }
  console.log("");
}

main().catch((error: unknown) => {
  console.error("[server] failed to start", error);
  process.exit(1);
});
