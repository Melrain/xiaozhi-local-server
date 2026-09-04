"use client";

import { Cpu, CircleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { DeviceVolume } from "@/components/device-volume";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import type { ConnectedDevice, DeviceStatusSnapshot } from "@/lib/device-registry";
import { cn } from "@/lib/utils";

const POLL_MS = 2000;

function formatRelative(ts: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - ts) / 1000));
  if (sec < 5) return "刚刚";
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  return `${hr} 小时前`;
}

function formatDuration(ts: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - ts) / 1000));
  if (sec < 60) return `已连 ${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `已连 ${min} 分 ${sec % 60} 秒`;
  const hr = Math.floor(min / 60);
  return `已连 ${hr} 小时 ${min % 60} 分`;
}

function shortId(value: string): string {
  if (!value || value === "-") return "未知";
  return value;
}

function sameDevice(a: ConnectedDevice, b: ConnectedDevice): boolean {
  return a.deviceId !== "-" && b.deviceId !== "-" && a.deviceId === b.deviceId;
}

function nextKicked(
  prev: ConnectedDevice | null,
  live: ConnectedDevice[],
  previous: ConnectedDevice[],
): ConnectedDevice | null {
  if (prev) {
    const replaced = live.some(
      (device) => device.sessionId !== prev.sessionId && sameDevice(device, prev),
    );
    return replaced ? null : prev;
  }
  if (live.length > 0) return null;
  return previous.find((device) => !live.some((current) => current.sessionId === device.sessionId)) ?? null;
}

type DeviceStatusProps = {
  className?: string;
};

export function DeviceStatus({ className }: DeviceStatusProps) {
  const [status, setStatus] = useState<DeviceStatusSnapshot | null>(null);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [playing, setPlaying] = useState(false);
  const [playMessage, setPlayMessage] = useState("");
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [kicked, setKicked] = useState<ConnectedDevice | null>(null);
  const lastDevicesRef = useRef<ConnectedDevice[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        if (!res.ok) throw new Error("status failed");
        const data = (await res.json()) as DeviceStatusSnapshot;
        if (cancelled) return;
        setKicked((prev) => nextKicked(prev, data.devices, lastDevicesRef.current));
        lastDevicesRef.current = data.devices;
        setStatus(data);
        setError(false);
        setNow(Date.now());
      } catch {
        if (!cancelled) setError(true);
      }
    }

    void load();
    const timer = window.setInterval(() => {
      void load();
    }, POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  async function disconnectWs(device: ConnectedDevice) {
    setDisconnectingId(device.sessionId);
    setKicked(device);
    try {
      const res = await fetch("/api/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: device.sessionId }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        if (res.status === 409) return;
        setKicked(null);
        setPlayMessage(data.error || "断开失败");
      }
    } catch {
      setKicked(null);
      setPlayMessage("断开失败");
    } finally {
      setDisconnectingId(null);
    }
  }

  async function playTest(sessionId: string) {
    setPlaying(true);
    setPlayMessage("");
    try {
      const res = await fetch("/api/play", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const data = (await res.json()) as { ok?: boolean; queued?: boolean; frames?: number; error?: string };
      if (!res.ok || !data.ok) {
        setPlayMessage(data.error || "下发失败");
        return;
      }
      if (data.queued) {
        setPlayMessage("当前没设备在线，连上后会自动播");
        return;
      }
      setPlayMessage(`已下发 ${data.frames ?? 0} 帧，听喇叭`);
    } catch {
      setPlayMessage("下发失败");
    } finally {
      setPlaying(false);
    }
  }

  const liveDevices = (status?.devices ?? []).filter(
    (device) => device.sessionId !== kicked?.sessionId,
  );
  const replacement = kicked
    ? liveDevices.find(
        (device) =>
          device.deviceId !== "-" &&
          kicked.deviceId !== "-" &&
          device.deviceId === kicked.deviceId,
      )
    : undefined;
  const displayDevices = replacement
    ? liveDevices
    : liveDevices.length > 0
      ? liveDevices
      : kicked
        ? [kicked]
        : [];
  const kickedVisible = Boolean(kicked && !replacement && liveDevices.length === 0);
  const connectedCount = liveDevices.length;
  const online = connectedCount > 0;

  return (
    <Card className={cn("md:h-full md:min-h-0 md:overflow-hidden", className)}>
      <CardHeader>
        <CardTitle>ESP32 设备</CardTitle>
        <CardDescription>
          WebSocket 连上才算出在线。空闲 30 秒会自动断开，再说唤醒词即可连上。
        </CardDescription>
        <CardAction>
          {error ? (
            <Badge variant="offline">状态读取失败</Badge>
          ) : online ? (
            <Badge variant="connected">
              <span className="size-1.5 rounded-full bg-current" aria-hidden />
              {connectedCount} 台在线
            </Badge>
          ) : kickedVisible ? (
            <Badge variant="offline">已断开</Badge>
          ) : (
            <Badge variant="offline">
              <span className="size-1.5 rounded-full bg-muted-foreground/50" aria-hidden />
              暂无设备
            </Badge>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-col gap-3 md:flex-1 md:overflow-y-auto">
        {status === null && !error ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-10 w-2/3" />
          </div>
        ) : null}

        {error ? (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>状态读取失败</AlertTitle>
            <AlertDescription>稍后会自动重试 /api/status。</AlertDescription>
          </Alert>
        ) : null}

        {status && displayDevices.length === 0 ? (
          <Empty className="gap-3 border-0 p-4 md:flex-1 md:p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Cpu />
              </EmptyMedia>
              <EmptyTitle>还没有设备</EmptyTitle>
              <EmptyDescription>
                板子会先打 OTA 拿地址，说唤醒词后会建立音频通道。按 BOOT 也可以手动连上。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        {displayDevices.map((device) => {
          const disconnected = kickedVisible && device.sessionId === kicked?.sessionId;
          return (
          <div
            key={device.deviceId !== "-" ? device.deviceId : device.sessionId}
            className="flex flex-col gap-3 rounded-lg border border-border bg-muted/60 px-3 py-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-mono text-sm break-all">{shortId(device.deviceId)}</p>
              <div className="flex items-center gap-2">
                <Badge variant={disconnected ? "offline" : "connected"}>
                  {disconnected ? "已断开" : "在线"}
                </Badge>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="min-w-20"
                  onClick={() => void disconnectWs(device)}
                  disabled={playing || disconnected || disconnectingId === device.sessionId}
                >
                  {disconnected
                    ? "已断开"
                    : disconnectingId === device.sessionId
                      ? "正在断开…"
                      : "断开连接"}
                </Button>
              </div>
            </div>
            <DeviceVolume
              sessionId={device.sessionId}
              speakerVolume={device.speakerVolume}
              mcpReady={device.mcpReady}
              mcpError={device.mcpError}
              disabled={disconnected || disconnectingId === device.sessionId}
            />
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{device.remoteAddress || "未知 IP"}</span>
              <span>{disconnected ? "已断开" : formatDuration(device.connectedAt, now)}</span>
              <span>Opus {device.opusFrames} 帧</span>
              <span>最近 {formatRelative(device.lastMessageAt, now)}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Client {shortId(device.clientId)}
              {device.protocolVersion ? ` · 协议 ${device.protocolVersion}` : ""}
              {status?.realtime
                ? ` · Realtime ${
                    disconnected || !(device.realtimeConnected || status.realtime.connected)
                      ? "未连接"
                      : "已连接"
                  }`
                : ""}
              {status?.realtime?.lastInterruptReason || device.lastInterruptReason
                ? ` · 上次打断 ${device.lastInterruptReason || status?.realtime?.lastInterruptReason}`
                : ""}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => void playTest(device.sessionId)}
                disabled={playing || disconnected || disconnectingId === device.sessionId}
              >
                {playing ? "正在下发…" : "播放测试语音"}
              </Button>
              {playMessage ? (
                <p className="text-xs text-muted-foreground">{playMessage}</p>
              ) : null}
            </div>
          </div>
          );
        })}

        {status && status.recentOta.length > 0 ? (
          <div className="flex flex-col gap-2">
            <Separator />
            <p className="text-xs tracking-wide text-muted-foreground uppercase">
              最近 OTA（尚未建立音频通道）
            </p>
            <ul className="flex flex-col gap-2">
              {status.recentOta.map((sighting) => (
                <li
                  key={`${sighting.deviceId}:${sighting.clientId}:${sighting.lastSeenAt}`}
                  className="rounded-lg bg-muted px-3 py-2 text-sm"
                >
                  <p className="font-mono text-[13px] break-all">
                    {shortId(sighting.deviceId)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatRelative(sighting.lastSeenAt, now)} · 固件{" "}
                    {sighting.firmwareVersion || "-"}
                    {sighting.clientId ? ` · Client ${shortId(sighting.clientId)}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
