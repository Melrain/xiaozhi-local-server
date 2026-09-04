import { getServerConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { wsPort } = getServerConfig();
  let sessionId = "";
  try {
    const body = (await request.json()) as { sessionId?: string };
    sessionId = body.sessionId?.trim() ?? "";
  } catch {
    sessionId = "";
  }

  const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : "";
  try {
    const res = await fetch(`http://127.0.0.1:${wsPort}/disconnect${query}`, {
      method: "POST",
      cache: "no-store",
    });
    const data = (await res.json()) as unknown;
    return Response.json(data, { status: res.status });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "disconnect failed";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
