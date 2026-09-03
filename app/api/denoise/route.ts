import { getServerConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { wsPort } = getServerConfig();
  let enabled = true;
  try {
    const body = (await request.json()) as { enabled?: boolean };
    enabled = body.enabled !== false;
  } catch {
    enabled = true;
  }

  try {
    const res = await fetch(
      `http://127.0.0.1:${wsPort}/denoise?on=${enabled ? "1" : "0"}`,
      { method: "POST", cache: "no-store" },
    );
    const data = (await res.json()) as unknown;
    return Response.json(data);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "denoise failed";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
