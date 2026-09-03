import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import {
  LISTEN_PLAYBACK_WORKLET_URL,
  LISTEN_WS_WORKER_URL,
} from "../worker/urls";

const WORKER_DIR = path.resolve(process.cwd(), "worker");
const WORKER_PREFIX = "/worker/";
const REQUIRED_WORKERS = [LISTEN_WS_WORKER_URL, LISTEN_PLAYBACK_WORKLET_URL];

function workerFileFromUrl(urlPath: string): string | null {
  if (!urlPath.startsWith(WORKER_PREFIX)) return null;
  const name = path.basename(urlPath);
  if (!name.endsWith(".js")) return null;
  const file = path.resolve(WORKER_DIR, name);
  if (!file.startsWith(WORKER_DIR + path.sep)) return null;
  return existsSync(file) ? file : null;
}

export function listWorkerUrls(): string[] {
  if (!existsSync(WORKER_DIR)) return [];
  return readdirSync(WORKER_DIR)
    .filter((name) => name.endsWith(".js"))
    .map((name) => `${WORKER_PREFIX}${name}`);
}

export function startWorkers(): string[] {
  const missing = REQUIRED_WORKERS.filter((url) => !workerFileFromUrl(url));
  if (missing.length > 0) {
    throw new Error(`worker files missing: ${missing.join(", ")}`);
  }

  const urls = listWorkerUrls();
  for (const url of urls) {
    console.log(`[WORKER] ready ${url}`);
  }
  return urls;
}

export function tryServeWorker(req: IncomingMessage, res: ServerResponse): boolean {
  const urlPath = (req.url ?? "").split("?")[0] ?? "";
  if (!urlPath.startsWith(WORKER_PREFIX)) return false;

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.end();
    return true;
  }

  const file = workerFileFromUrl(urlPath);
  if (!file) {
    res.statusCode = 404;
    res.end("worker not found");
    return true;
  }

  const body = readFileSync(file);
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Length", String(body.length));
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  res.end(body);
  return true;
}
