export type BrowserLocation = {
  protocol: string;
  host: string;
  hostname: string;
};

/** Dashboard listen / realtime-test sockets. HTTPS pages must use same-origin wss. */
export function browserWebSocketUrl(
  pathWithQuery: string,
  wsPort: number,
  location: BrowserLocation,
): string {
  const path = pathWithQuery.startsWith("/") ? pathWithQuery : `/${pathWithQuery}`;
  if (location.protocol === "https:") {
    return `wss://${location.host}${path}`;
  }
  return `ws://${location.hostname}:${wsPort}${path}`;
}
