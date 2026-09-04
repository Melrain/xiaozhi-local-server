"use client";

import { CircleAlert, Mic } from "lucide-react";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { useRealtimeTester } from "@/hooks/use-realtime-tester";
import type { DeviceStatusSnapshot } from "@/lib/device-registry";
import { cn } from "@/lib/utils";

type RealtimeTesterProps = {
  wsPort: number;
  className?: string;
};

export function RealtimeTester({ wsPort, className }: RealtimeTesterProps) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [statusModel, setStatusModel] = useState("");
  const [statusVoice, setStatusVoice] = useState("");
  const { state, error, micWarning, model, voice, lines, listening, connect, disconnect } =
    useRealtimeTester({ wsPort });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as DeviceStatusSnapshot;
        if (cancelled) return;
        setConfigured(data.realtime?.configured ?? false);
        setStatusModel(data.realtime?.model ?? "");
        setStatusVoice(data.realtime?.voice ?? "");
      } catch {
        // keep last
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const live = state === "live";
  const connecting = state === "connecting";
  const displayModel = model || statusModel;
  const displayVoice = voice || statusVoice;

  return (
    <Card className={cn("md:h-full md:min-h-0 md:overflow-hidden", className)}>
      <CardHeader>
        <CardTitle>Qwen-Omni Realtime 测试</CardTitle>
        <CardDescription>
          用浏览器麦克风直接连百炼，不经过 ESP32。说完后模型会在本机播回复。
        </CardDescription>
        <CardAction>
          {live ? (
            <Badge variant="connected">
              <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />
              {listening ? "正在听" : "已连接"}
            </Badge>
          ) : connecting ? (
            <Badge variant="live">连接中</Badge>
          ) : (
            <Badge variant="offline">{configured === false ? "未配置" : "未连接"}</Badge>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-col gap-3 md:flex-1">
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={configured === false || connecting || live}
            onClick={() => void connect()}
          >
            {connecting ? "正在连接…" : "开始测试"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!connecting && !live}
            onClick={() => disconnect()}
          >
            断开
          </Button>
        </div>

        <p className="text-xs leading-6 text-muted-foreground">
          {configured === false
            ? "先在 .env.local 填 DASHSCOPE_API_KEY，以及 WORKSPACE_ID 或 DASHSCOPE_REALTIME_URL。"
            : `${displayModel || "qwen3.5-omni-flash-realtime"}${displayVoice ? ` · 音色 ${displayVoice}` : ""}`}
        </p>

        {error ? (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>连接失败</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {micWarning ? (
          <Alert>
            <CircleAlert />
            <AlertTitle>麦克风</AlertTitle>
            <AlertDescription>{micWarning}</AlertDescription>
          </Alert>
        ) : null}

        {lines.length > 0 ? (
          <ScrollArea className="min-h-40 flex-1 rounded-lg bg-muted px-3 py-3">
            <div className="flex flex-col gap-2">
              {lines.map((line, index) => (
                <p key={`${line.role}-${index}`} className="text-sm leading-6">
                  <span className="text-xs text-muted-foreground">
                    {line.role === "user" ? "你" : "模型"}
                    {line.partial ? " · 识别中" : ""}
                  </span>
                  <span className="mt-0.5 block">{line.text || "…"}</span>
                </p>
              ))}
            </div>
          </ScrollArea>
        ) : (
          <Empty className="gap-3 border-0 p-4 md:flex-1 md:p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Mic />
              </EmptyMedia>
              <EmptyTitle>{live ? "等待说话" : "尚未开始"}</EmptyTitle>
              <EmptyDescription>
                {live ? "对着麦克风说话，转写会出现在这里。" : "开始测试后，对话会显示在这里。"}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </CardContent>
    </Card>
  );
}
