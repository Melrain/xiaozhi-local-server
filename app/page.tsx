import { AppShell } from "@/components/app-shell";
import { DeviceStatus } from "@/components/device-status";
import { ListenMonitor } from "@/components/listen-monitor";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getOtaUrl, getRealtimeConfig, getServerConfig, getUiUrl, getWebsocketUrl } from "@/lib/config";

export const dynamic = "force-dynamic";

export default function Home() {
  const config = getServerConfig();
  const realtime = getRealtimeConfig();
  const otaUrl = getOtaUrl(config);
  const wsUrl = getWebsocketUrl(config);
  const uiUrl = getUiUrl(config);

  return (
    <AppShell otaUrl={otaUrl} wsUrl={wsUrl}>
      <section className="space-y-2">
        <p className="text-sm leading-7 text-muted-foreground">
          设备 OTA 已指向{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[13px] text-foreground">
            {otaUrl}
          </code>
          。下面会轮询 WebSocket 连接，看有没有 ESP32 连上这台机器。
        </p>
      </section>

      <DeviceStatus />

      <ListenMonitor wsPort={config.wsPort} />

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
            <p className="text-xs text-muted-foreground">Qwen-Omni Realtime</p>
            <p className="mt-1">{realtime.configured ? realtime.model : "未配置，走本地占位"}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {realtime.configured ? `音色 ${realtime.voice}` : "填 DASHSCOPE_API_KEY 与 WORKSPACE_ID"}
            </p>
          </div>
        </CardContent>
      </Card>
    </AppShell>
  );
}
