import { getServerConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { wsPort } = getServerConfig();
  let paused = true;
  try {
    const body = (await request.json()) as { paused?: boolean };
    paused = body.paused !== false;
  } catch {
    paused = true;
  }

  try {
    const res = await fetch(
      `http://127.0.0.1:${wsPort}/listen?paused=${paused ? "1" : "0"}`,
      { method: "POST", cache: "no-store" },
    );
    const data = (await res.json()) as unknown;
    return Response.json(data, { status: res.ok ? 200 : 409 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "listen failed";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
