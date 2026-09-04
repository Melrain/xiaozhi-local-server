"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  LISTEN_PLAYBACK_WORKLET_URL,
  MIC_CAPTURE_WORKLET_URL,
} from "@/worker/urls";

export type RealtimeTesterState = "idle" | "connecting" | "live";

export type RealtimeLine = {
  role: "user" | "assistant";
  text: string;
  partial: boolean;
};

type UseRealtimeTesterOptions = {
  wsPort: number;
};

function upsertLine(
  lines: RealtimeLine[],
  role: RealtimeLine["role"],
  transcript: string,
  partial: boolean,
): RealtimeLine[] {
  const last = lines[lines.length - 1];
  const samePartial = last && last.role === role && last.partial;
  if (partial) {
    const text = role === "user" || !samePartial || !last ? transcript : last.text + transcript;
    if (samePartial) return [...lines.slice(0, -1), { role, text, partial: true }];
    return [...lines, { role, text, partial: true }];
  }
  if (samePartial) {
    return [...lines.slice(0, -1), { role, text: transcript || last.text, partial: false }];
  }
  if (!transcript) return lines;
  return [...lines, { role, text: transcript, partial: false }];
}

export function useRealtimeTester({ wsPort }: UseRealtimeTesterOptions) {
  const [state, setState] = useState<RealtimeTesterState>("idle");
  const [error, setError] = useState("");
  const [micWarning, setMicWarning] = useState("");
  const [model, setModel] = useState("");
  const [voice, setVoice] = useState("");
  const [lines, setLines] = useState<RealtimeLine[]>([]);
  const [listening, setListening] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const playbackRef = useRef<AudioWorkletNode | null>(null);
  const captureRef = useRef<AudioWorkletNode | null>(null);
  const muteRef = useRef<GainNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletsReadyRef = useRef<Promise<void> | null>(null);

  const stopMedia = useCallback(() => {
    captureRef.current?.disconnect();
    captureRef.current = null;
    muteRef.current?.disconnect();
    muteRef.current = null;
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    playbackRef.current?.port.postMessage({ type: "reset" });
  }, []);

  const disconnect = useCallback(() => {
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "disconnect" }));
        }
      } catch {
        // ignore
      }
      socket.close();
    }
    stopMedia();
    setListening(false);
    setState("idle");
  }, [stopMedia]);

  const connect = useCallback(async () => {
    if (state === "connecting" || state === "live") return;
    setError("");
    setMicWarning("");
    setLines([]);
    setListening(false);
    setState("connecting");

    const ctx = audioRef.current ?? new AudioContext();
    audioRef.current = ctx;
    try {
      workletsReadyRef.current ??= Promise.all([
        ctx.audioWorklet.addModule(LISTEN_PLAYBACK_WORKLET_URL),
        ctx.audioWorklet.addModule(MIC_CAPTURE_WORKLET_URL),
      ]).then(() => undefined);
      await workletsReadyRef.current;
      await ctx.resume();
    } catch (err) {
      workletsReadyRef.current = null;
      setError(err instanceof Error ? err.message : "音频模块加载失败");
      setState("idle");
      return;
    }

    playbackRef.current?.disconnect();
    const playback = new AudioWorkletNode(ctx, "listen-playback-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    playback.connect(ctx.destination);
    playbackRef.current = playback;

    const url = `ws://${window.location.hostname}:${wsPort}/realtime-test`;
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;

    socket.onmessage = (event) => {
      if (socketRef.current !== socket) return;
      if (typeof event.data !== "string") {
        const pcm = event.data;
        if (pcm instanceof ArrayBuffer && pcm.byteLength >= 2) {
          playback.port.postMessage({ type: "pcm", pcm }, [pcm]);
        }
        return;
      }
      let payload: {
        type?: string;
        model?: string;
        voice?: string;
        outputRate?: number;
        transcript?: string;
        partial?: boolean;
        started?: boolean;
        message?: string;
      };
      try {
        payload = JSON.parse(event.data) as typeof payload;
      } catch {
        return;
      }
      if (payload.type === "ready") {
        setModel(payload.model ?? "");
        setVoice(payload.voice ?? "");
        playback.port.postMessage({
          type: "hello",
          sampleRate: payload.outputRate || 24000,
          mode: "queue",
        });
        setState("live");
        return;
      }
      if (payload.type === "user") {
        setLines((current) => upsertLine(current, "user", payload.transcript ?? "", payload.partial === true));
        return;
      }
      if (payload.type === "assistant") {
        setLines((current) =>
          upsertLine(current, "assistant", payload.transcript ?? "", payload.partial === true),
        );
        return;
      }
      if (payload.type === "speech") {
        setListening(payload.started === true);
        return;
      }
      if (payload.type === "error") {
        setError(payload.message || "连接失败");
        return;
      }
      if (payload.type === "closed") {
        stopMedia();
        setListening(false);
        setState("idle");
      }
    };

    socket.onerror = () => {
      if (socketRef.current !== socket) return;
      setError("WebSocket 连接失败");
    };

    socket.onclose = () => {
      if (socketRef.current !== socket) return;
      socketRef.current = null;
      stopMedia();
      setListening(false);
      setState("idle");
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
      if (socketRef.current !== socket) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const source = ctx.createMediaStreamSource(stream);
      const capture = new AudioWorkletNode(ctx, "mic-capture-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      const mute = ctx.createGain();
      mute.gain.value = 0;
      capture.port.onmessage = (portEvent: MessageEvent) => {
        const message = portEvent.data as { type?: string; pcm?: ArrayBuffer };
        if (message.type !== "pcm" || !message.pcm) return;
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(message.pcm);
      };
      source.connect(capture);
      capture.connect(mute);
      mute.connect(ctx.destination);
      sourceRef.current = source;
      captureRef.current = capture;
      muteRef.current = mute;
    } catch {
      setMicWarning("麦克风不可用，会话已建立但无法说话");
    }
  }, [state, stopMedia, wsPort]);

  useEffect(() => {
    return () => {
      disconnect();
      void audioRef.current?.close();
      audioRef.current = null;
      playbackRef.current?.disconnect();
      playbackRef.current = null;
      workletsReadyRef.current = null;
    };
  }, [disconnect]);

  return {
    state,
    error,
    micWarning,
    model,
    voice,
    lines,
    listening,
    connect,
    disconnect,
  };
}
