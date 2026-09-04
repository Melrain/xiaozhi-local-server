"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { DeviceStatusSnapshot } from "@/lib/device-registry";

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

export function DeviceStatus() {
  const [status, setStatus] = useState<DeviceStatusSnapshot | null>(null);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [playing, setPlaying] = useState(false);
  const [playMessage, setPlayMessage] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        if (!res.ok) throw new Error("status failed");
        const data = (await res.json()) as DeviceStatusSnapshot;
        if (cancelled) return;
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

  async function playTest() {
    setPlaying(true);
    setPlayMessage("");
    try {
      const res = await fetch("/api/play", { method: "POST" });
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

  const connectedCount = status?.connectedCount ?? 0;
  const online = connectedCount > 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle>ESP32 设备</CardTitle>
            <CardDescription>
              WebSocket 连上才算出在线。开机后的 OTA 请求会记在下面，方便确认板子有没有找到这台机器。
            </CardDescription>
          </div>
          {error ? (
            <Badge variant="offline">状态读取失败</Badge>
          ) : online ? (
            <Badge variant="connected">
              <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
              {connectedCount} 台在线
            </Badge>
          ) : (
            <Badge variant="offline">
              <span className="size-1.5 rounded-full bg-muted-foreground/50" aria-hidden />
              暂无设备
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {status?.realtime ? (
          <div className="rounded-lg border border-border bg-background px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium">Qwen-Omni Realtime</p>
              {status.realtime.configured ? (
                <Badge variant={status.realtime.connected ? "connected" : "offline"}>
                  {status.realtime.connected ? "已连接" : "未连接"}
                </Badge>
              ) : (
                <Badge variant="offline">未配置</Badge>
              )}
            </div>
            <p className="mt-2 text-xs leading-6 text-muted-foreground">
              模型 {status.realtime.model || "-"}
              {status.realtime.voice ? ` · 音色 ${status.realtime.voice}` : ""}
            </p>
            <p className="text-xs text-muted-foreground">
              上次打断：{status.realtime.lastInterruptReason || "无"}
            </p>
          </div>
        ) : null}

        {status === null && !error ? (
          <p className="text-sm text-muted-foreground">正在检查连接…</p>
        ) : null}

        {status && status.devices.length === 0 ? (
          <p className="text-sm leading-6 text-muted-foreground">
            还没有 ESP32 连上 WebSocket。板子会先打 OTA 拿地址，按 BOOT 才会建立音频通道。
          </p>
        ) : null}

        {status?.devices.map((device) => (
          <div
            key={device.sessionId}
            className="rounded-lg border border-border bg-muted/60 px-3 py-3"
          >
            <div className="flex items-center justify-between gap-3">
              <p className="font-mono text-sm break-all">
                {shortId(device.deviceId)}
              </p>
              <Badge variant="connected">在线</Badge>
            </div>
            <p className="mt-2 text-xs leading-6 text-muted-foreground">
              {device.remoteAddress || "未知 IP"} · {formatDuration(device.connectedAt, now)} ·
              Opus {device.opusFrames} 帧 · 最近活动 {formatRelative(device.lastMessageAt, now)}
            </p>
            <p className="text-xs text-muted-foreground">
              Client {shortId(device.clientId)}
              {device.protocolVersion ? ` · 协议 ${device.protocolVersion}` : ""}
            </p>
            {status?.realtime ? (
              <p className="mt-1 text-xs leading-6 text-muted-foreground">
                Realtime {device.realtimeConnected || status.realtime.connected ? "已连接" : "未连接"}
                {status.realtime.model ? ` · ${status.realtime.model}` : ""}
                {status.realtime.lastInterruptReason || device.lastInterruptReason
                  ? ` · 上次打断 ${device.lastInterruptReason || status.realtime.lastInterruptReason}`
                  : ""}
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => void playTest()}
              disabled={playing}
              className="mt-3 rounded-lg bg-foreground px-3 py-1.5 text-xs text-background disabled:opacity-50"
            >
              {playing ? "正在下发…" : "播放测试语音"}
            </button>
            {playMessage ? (
              <p className="mt-2 text-xs text-muted-foreground">{playMessage}</p>
            ) : null}
          </div>
        ))}

        {status && status.recentOta.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs tracking-wide text-muted-foreground uppercase">
              最近 OTA（尚未建立音频通道）
            </p>
            <ul className="space-y-2">
              {status.recentOta.map((sighting) => (
                <li
                  key={`${sighting.deviceId}:${sighting.clientId}:${sighting.lastSeenAt}`}
                  className="rounded-lg bg-muted px-3 py-3 text-sm"
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
