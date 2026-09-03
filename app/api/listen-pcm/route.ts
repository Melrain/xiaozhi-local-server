import { getServerConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { wsPort } = getServerConfig();
  const session = new URL(request.url).searchParams.get("session") ?? "";
  const query = session ? `?session=${encodeURIComponent(session)}` : "";

  try {
    const res = await fetch(`http://127.0.0.1:${wsPort}/listen-pcm${query}`, {
      cache: "no-store",
    });
    const data = (await res.json()) as unknown;
    return Response.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "pcm failed";
    return Response.json({ ok: false, error: message, pcm: "", sampleRate: 16000 }, { status: 500 });
  }
}
