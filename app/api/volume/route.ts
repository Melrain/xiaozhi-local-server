import { getServerConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { wsPort } = getServerConfig();
  let sessionId = "";
  let volume: number | undefined;
  try {
    const body = (await request.json()) as { sessionId?: string; volume?: number };
    sessionId = body.sessionId?.trim() ?? "";
    volume = body.volume;
  } catch {
    sessionId = "";
  }

  if (typeof volume !== "number") {
    return Response.json({ ok: false, error: "invalid volume" }, { status: 400 });
  }

  const query = new URLSearchParams({ volume: String(volume) });
  if (sessionId) query.set("session", sessionId);

  try {
    const res = await fetch(`http://127.0.0.1:${wsPort}/volume?${query}`, {
      method: "POST",
      cache: "no-store",
    });
    const data = (await res.json()) as unknown;
    return Response.json(data, { status: res.ok ? 200 : res.status === 400 ? 400 : 409 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "volume failed";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
