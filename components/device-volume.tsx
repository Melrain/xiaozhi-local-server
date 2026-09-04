"use client";

import { Volume1, Volume2, VolumeX } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Slider } from "@/components/ui/slider";

const DEFAULT_VOLUME = 70;
const DEBOUNCE_MS = 280;

type DeviceVolumeProps = {
  sessionId: string;
  speakerVolume?: number;
  mcpReady?: boolean;
  mcpError?: string;
  disabled?: boolean;
};

export function DeviceVolume({
  sessionId,
  speakerVolume,
  mcpReady,
  mcpError,
  disabled,
}: DeviceVolumeProps) {
  const labelId = useId();
  const known = typeof speakerVolume === "number";
  const [draft, setDraft] = useState(speakerVolume ?? DEFAULT_VOLUME);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");
  const lastNonZeroRef = useRef(
    speakerVolume && speakerVolume > 0 ? speakerVolume : DEFAULT_VOLUME,
  );
  const [pending, setPending] = useState<number | null>(null);
  const seqRef = useRef(0);
  const timerRef = useRef(0);

  useEffect(() => {
    return () => window.clearTimeout(timerRef.current);
  }, []);

  useEffect(() => {
    if (typeof speakerVolume === "number" && speakerVolume > 0 && !dragging && pending === null) {
      lastNonZeroRef.current = speakerVolume;
    }
  }, [speakerVolume, dragging, pending]);

  if (pending !== null && speakerVolume === pending) {
    setPending(null);
  }
  const awaitingEcho = pending !== null && speakerVolume !== pending;
  const sliderValue = dragging || awaitingEcho ? draft : (speakerVolume ?? draft);

  async function commit(next: number) {
    const volume = Math.max(0, Math.min(100, Math.round(next)));
    const seq = ++seqRef.current;
    setPending(volume);
    setSending(true);
    setMessage("");
    try {
      const res = await fetch("/api/volume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, volume }),
      });
      const data = (await res.json()) as { ok?: boolean; volume?: number; error?: string };
      if (seq !== seqRef.current) return;
      if (!res.ok || !data.ok) {
        setPending(null);
        setMessage(data.error || "调音失败");
        return;
      }
      const applied = data.volume ?? volume;
      setPending(applied);
      setDraft(applied);
      if (applied > 0) lastNonZeroRef.current = applied;
      setMessage(`已设为 ${applied}%`);
    } catch {
      if (seq !== seqRef.current) return;
      setPending(null);
      setMessage("调音失败");
    } finally {
      if (seq === seqRef.current) setSending(false);
    }
  }

  function schedule(next: number) {
    setPending(next);
    setDraft(next);
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      void commit(next);
    }, DEBOUNCE_MS);
  }

  function flush(next: number) {
    window.clearTimeout(timerRef.current);
    void commit(next);
  }

  const muted = sliderValue === 0;
  const VolumeIcon = muted ? VolumeX : sliderValue < 40 ? Volume1 : Volume2;
  const hint = message
    ? message
    : mcpError
      ? "还没读到板子音量，拖动仍会下发"
      : mcpReady
        ? "拖动即可改喇叭音量"
        : "正在读取板子音量…";

  return (
    <FieldGroup className="gap-1.5">
      <Field className="gap-2" data-disabled={disabled ? true : undefined}>
        <div className="flex items-center justify-between gap-2">
          <FieldLabel htmlFor={labelId}>喇叭音量</FieldLabel>
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {known || sending || awaitingEcho ? `${sliderValue}%` : "—"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="icon-xs"
            variant="outline"
            aria-label={muted ? "取消静音" : "静音"}
            disabled={disabled}
            onClick={() => {
              const next = muted ? lastNonZeroRef.current : 0;
              setPending(next);
              setDraft(next);
              flush(next);
            }}
          >
            <VolumeIcon />
          </Button>
          <Slider
            id={labelId}
            min={0}
            max={100}
            step={1}
            value={[sliderValue]}
            disabled={disabled}
            aria-label="喇叭音量"
            onValueChange={(value) => {
              setDragging(true);
              schedule(value[0] ?? 0);
            }}
            onValueCommit={(value) => {
              setDragging(false);
              flush(value[0] ?? sliderValue);
            }}
          />
        </div>
        <FieldDescription className="text-xs">{hint}</FieldDescription>
      </Field>
    </FieldGroup>
  );
}
