import { createServer } from "node:http";
import next from "next";
import { BIND_HOST, getServerConfig, getOtaUrl, getUiUrl, getWebsocketUrl } from "./lib/config";
import { loadLocalEnv } from "./lib/load-env";
import { startOtaServer } from "./lib/ota-server";
import { startWebsocketServer } from "./lib/ws-server";

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
    void handle(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    uiServer.once("error", reject);
    uiServer.listen(config.uiPort, BIND_HOST, () => resolve());
  });

  startOtaServer();
  startWebsocketServer();

  console.log("");
  console.log("xiaozhi-local-server");
  console.log(`  UI  ${getUiUrl(config)}  (bind ${BIND_HOST}:${config.uiPort})`);
  console.log(`  OTA ${getOtaUrl(config)}  (bind ${BIND_HOST}:${config.otaPort})`);
  console.log(`  WS  ${getWebsocketUrl(config)}  (bind ${BIND_HOST}:${config.wsPort})`);
  console.log("");
}

main().catch((error: unknown) => {
  console.error("[server] failed to start", error);
  process.exit(1);
});
