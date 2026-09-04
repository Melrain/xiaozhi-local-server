import { getRealtimeConfig, getServerConfig } from "@/lib/config";
import type { DeviceStatusSnapshot } from "@/lib/device-registry";

export const dynamic = "force-dynamic";

function fallbackRealtime() {
  const config = getRealtimeConfig();
  return {
    configured: config.configured,
    connected: false,
    browserConnected: false,
    model: config.model,
    voice: config.voice,
    lastInterruptReason: "",
  };
}

const emptyStatus: DeviceStatusSnapshot = {
  ok: true,
  connectedCount: 0,
  devices: [],
  recentOta: [],
  realtime: fallbackRealtime(),
};

export async function GET() {
  const { wsPort } = getServerConfig();

  try {
    const res = await fetch(`http://127.0.0.1:${wsPort}/status`, {
      cache: "no-store",
    });
    if (!res.ok) {
      return Response.json(emptyStatus, {
        headers: { "Cache-Control": "no-store" },
        status: 200,
      });
    }
    const data = (await res.json()) as DeviceStatusSnapshot;
    if (!data.realtime) data.realtime = fallbackRealtime();
    return Response.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(emptyStatus, {
      headers: { "Cache-Control": "no-store" },
    });
  }
}
