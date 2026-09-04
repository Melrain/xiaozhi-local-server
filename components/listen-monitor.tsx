"use client";

import { AudioLines, CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";
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
import { useListenPlayback } from "@/hooks/use-listen-playback";
import type { ConnectedDevice, DeviceStatusSnapshot } from "@/lib/device-registry";
import { cn } from "@/lib/utils";

const STATUS_POLL_MS = 400;
const VOICE_LEVEL = 0.12;
const LIVE_MS = 400;

type ListenMonitorProps = {
  wsPort: number;
  className?: string;
};

function modeLabel(mode: string): string {
  if (mode === "auto") return "auto · 连上就持续上传";
  if (mode === "manual") return "manual · 按键才采集";
  if (mode === "realtime") return "realtime · 边说边传";
  return mode || "未知";
}

function listenLabel(device: ConnectedDevice | undefined, now: number): {
  text: string;
  live: boolean;
  voice: boolean;
} {
  if (!device) return { text: "没有在线设备", live: false, voice: false };
  if (device.listenPaused) return { text: "已暂停接收", live: false, voice: false };
  const recent = device.lastOpusAt > 0 && now - device.lastOpusAt < LIVE_MS;
  const listening = device.listenState === "start";
  const voice = listening && recent && device.level >= VOICE_LEVEL;
  if (device.playing) {
    return {
      text: device.realtimeConnected ? "正在播放（可打断）" : "正在播放，听筒暂停",
      live: false,
      voice: false,
    };
  }
  if (listening && voice) return { text: "听到声音", live: true, voice: true };
  if (listening && recent) return { text: "正在听（偏静音）", live: true, voice: false };
  if (listening) return { text: "听筒已开，等待帧", live: false, voice: false };
  return { text: "未开始听", live: false, voice: false };
}

export function ListenMonitor({ wsPort, className }: ListenMonitorProps) {
  const [status, setStatus] = useState<DeviceStatusSnapshot | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [monitor, setMonitor] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  const device = status?.devices[0];
  const sessionId = device?.sessionId;
  const paused = device?.listenPaused === true;
  const { streamState, streamError } = useListenPlayback({
    enabled: monitor && !paused,
    sessionId,
    wsPort,
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as DeviceStatusSnapshot;
        if (cancelled) return;
        setStatus(data);
        setNow(Date.now());
      } catch {
        // keep last snapshot
      }
    }

    void load();
    const timer = window.setInterval(() => {
      void load();
    }, STATUS_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  async function toggleDenoise() {
    setBusy(true);
    setActionError("");
    try {
      const res = await fetch("/api/denoise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !status?.denoiseEnabled }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setActionError(data.error || "降噪切换失败");
      }
    } catch {
      setActionError("降噪切换失败");
    } finally {
      setBusy(false);
    }
  }

  async function togglePaused() {
    if (!device) return;
    setBusy(true);
    setActionError("");
    try {
      const res = await fetch("/api/listen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: !paused }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setActionError(data.error || "切换失败");
      }
    } catch {
      setActionError("切换失败");
    } finally {
      setBusy(false);
    }
  }

  const label = listenLabel(device, now);
  const history = device?.levelHistory ?? [];
  const levelPct = Math.round((device?.level ?? 0) * 100);

  return (
    <Card className={cn("md:h-full md:min-h-0 md:overflow-hidden", className)}>
      <CardHeader>
        <CardTitle>听筒监听</CardTitle>
        <CardDescription>
          试听会先去工频哼声和底噪，再由 Worker / AudioWorklet 拉流播放。
        </CardDescription>
        <CardAction>
          {label.voice ? (
            <Badge variant="connected">
              <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />
              {label.text}
            </Badge>
          ) : label.live ? (
            <Badge variant="live">
              <span className="size-1.5 rounded-full bg-current" aria-hidden />
              {label.text}
            </Badge>
          ) : (
            <Badge variant="offline">{label.text}</Badge>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-col gap-3 md:flex-1">
        {!device ? (
          <Empty className="gap-3 border-0 p-4 md:flex-1 md:p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <AudioLines />
              </EmptyMedia>
              <EmptyTitle>没有在线设备</EmptyTitle>
              <EmptyDescription>
                先按 BOOT 连上 WebSocket，这里才会开始刷音量。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant={paused ? "default" : "outline"}
                disabled={busy}
                onClick={() => void togglePaused()}
              >
                {paused ? "恢复听筒" : "暂停听筒"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={monitor ? "default" : "outline"}
                disabled={paused}
                onClick={() => {
                  setMonitor((current) => !current);
                  setActionError("");
                }}
              >
                {monitor ? "停止本机试听" : "本机试听音频流"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={status?.denoiseEnabled === false ? "outline" : "default"}
                disabled={busy}
                onClick={() => void toggleDenoise()}
              >
                {status?.denoiseEnabled === false ? "开启降噪" : "关闭降噪"}
              </Button>
            </div>
            {actionError || streamError ? (
              <Alert variant="destructive">
                <CircleAlert />
                <AlertTitle>试听出错</AlertTitle>
                <AlertDescription>{actionError || streamError}</AlertDescription>
              </Alert>
            ) : null}
            {monitor && !paused ? (
              <p className="text-xs text-muted-foreground">
                试听流：
                {streamState === "live"
                  ? "Worker 已连接，AudioWorklet 拉流"
                  : streamState === "connecting"
                    ? "Worker 连接中…"
                    : "未连接"}
                。降噪：
                {status?.denoiseEnabled === false
                  ? "关"
                  : status?.denoiseBackend === "rnnoise"
                    ? "RNNoise"
                    : "高通+门限"}
              </p>
            ) : null}

            <div className="grid gap-2 text-sm sm:grid-cols-3">
              <div className="rounded-lg bg-muted px-3 py-2">
                <p className="text-xs text-muted-foreground">模式</p>
                <p className="mt-1 truncate">{modeLabel(device.listenMode)}</p>
              </div>
              <div className="rounded-lg bg-muted px-3 py-2">
                <p className="text-xs text-muted-foreground">本段 Opus</p>
                <p className="mt-1 font-mono">
                  {device.opusFrames} 帧 · {device.framesPerSec} 帧/秒
                </p>
              </div>
              <div className="rounded-lg bg-muted px-3 py-2">
                <p className="text-xs text-muted-foreground">最近一帧</p>
                <p className="mt-1 font-mono">
                  {device.lastOpusBytes ? `${device.lastOpusBytes} B` : "—"} · 音量 {levelPct}%
                </p>
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>实时音量</span>
                <span>{levelPct}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-150"
                  style={{ width: `${levelPct}%` }}
                />
              </div>
              <div className="flex min-h-12 flex-1 items-end gap-0.5">
                {(history.length > 0 ? history : [0]).map((value, index) => (
                  <div
                    key={index}
                    className="min-h-1.5 flex-1 rounded-t bg-primary/80"
                    style={{ height: `${Math.max(8, Math.round(value * 100))}%` }}
                  />
                ))}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
