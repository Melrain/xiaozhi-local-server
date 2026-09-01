import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getOtaUrl, getServerConfig, getUiUrl, getWebsocketUrl } from "@/lib/config";

export const dynamic = "force-dynamic";

export default function Home() {
  const config = getServerConfig();
  const otaUrl = getOtaUrl(config);
  const wsUrl = getWebsocketUrl(config);
  const uiUrl = getUiUrl(config);

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-border bg-card/70">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-5 py-4">
          <div>
            <p className="text-[11px] tracking-[0.18em] uppercase text-muted-foreground">
              XiaoZhi · ESP32-S3
            </p>
            <h1 className="text-xl font-semibold tracking-tight">小智本地服务</h1>
          </div>
          <Badge variant="live">
            <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />
            服务运行中
          </Badge>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 px-5 py-8">
        <section className="space-y-2">
          <p className="text-sm leading-7 text-muted-foreground">
            设备 OTA 已指向{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[13px] text-foreground">
              http://192.168.50.188:8002/xiaozhi/ota/
            </code>
            。本页只做状态确认，看板功能之后再加。
          </p>
        </section>

        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>OTA HTTP</CardTitle>
              <CardDescription>固件用这条地址拿 WebSocket 配置，不会下发升级包。</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="break-all font-mono text-sm leading-6">{otaUrl}</p>
              <p className="mt-3 text-xs text-muted-foreground">
                监听 {config.otaPort} · GET / POST /xiaozhi/ota/
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>WebSocket</CardTitle>
              <CardDescription>按 BOOT 后设备连上来，立刻回 hello，再收 listen / opus。</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="break-all font-mono text-sm leading-6">{wsUrl}</p>
              <p className="mt-3 text-xs text-muted-foreground">
                监听 {config.wsPort} · /xiaozhi/v1/
              </p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>当前进程</CardTitle>
            <CardDescription>
              npm run dev 会同时拉起 UI、OTA、WebSocket，都绑在 0.0.0.0。
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm sm:grid-cols-3">
            <div className="rounded-lg bg-muted px-3 py-3">
              <p className="text-xs text-muted-foreground">界面</p>
              <p className="mt-1 break-all font-mono text-[13px]">{uiUrl}</p>
            </div>
            <div className="rounded-lg bg-muted px-3 py-3">
              <p className="text-xs text-muted-foreground">通告主机</p>
              <p className="mt-1 font-mono text-[13px]">{config.advertiseHost}</p>
            </div>
            <div className="rounded-lg bg-muted px-3 py-3">
              <p className="text-xs text-muted-foreground">ASR / TTS</p>
              <p className="mt-1">尚未接入，只记日志并回占位 JSON</p>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
