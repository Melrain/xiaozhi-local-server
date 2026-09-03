import { getServerConfig } from "@/lib/config";
import type { DeviceStatusSnapshot } from "@/lib/device-registry";

export const dynamic = "force-dynamic";

const emptyStatus: DeviceStatusSnapshot = {
  ok: true,
  connectedCount: 0,
  devices: [],
  recentOta: [],
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
    return Response.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(emptyStatus, {
      headers: { "Cache-Control": "no-store" },
    });
  }
}
