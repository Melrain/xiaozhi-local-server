import { getServerConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function POST() {
  const { wsPort } = getServerConfig();
  try {
    const res = await fetch(`http://127.0.0.1:${wsPort}/play`, {
      method: "POST",
      cache: "no-store",
    });
    const data = (await res.json()) as unknown;
    return Response.json(data, { status: res.ok ? 200 : 500 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "play failed";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
