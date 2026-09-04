'use client';

import { useEffect, useRef, useState } from 'react';
import {
  LISTEN_PLAYBACK_WORKLET_URL,
  LISTEN_WS_WORKER_URL,
} from '@/worker/urls';

export type ListenStreamState = 'idle' | 'connecting' | 'live';

type UseListenPlaybackOptions = {
  enabled: boolean;
  sessionId?: string;
  wsPort: number;
};

export function useListenPlayback({
  enabled,
  sessionId,
  wsPort,
}: UseListenPlaybackOptions) {
  const listenKey = enabled && sessionId ? `${sessionId}:${wsPort}` : '';
  const [streamState, setStreamState] = useState<ListenStreamState>('idle');
  const [streamError, setStreamError] = useState('');
  const [prevListenKey, setPrevListenKey] = useState(listenKey);
  const audioRef = useRef<AudioContext | null>(null);
  const workletReadyRef = useRef<Promise<void> | null>(null);

  if (prevListenKey !== listenKey) {
    setPrevListenKey(listenKey);
    setStreamState('idle');
  }

  useEffect(() => {
    if (!listenKey || !sessionId) {
      return;
    }

    const activeSessionId = sessionId;
    let cancelled = false;
    let worker: Worker | null = null;
    let node: AudioWorkletNode | null = null;

    async function start() {
      const ctx = audioRef.current ?? new AudioContext({ sampleRate: 16000 });
      audioRef.current = ctx;
      try {
        workletReadyRef.current ??= ctx.audioWorklet.addModule(
          LISTEN_PLAYBACK_WORKLET_URL
        );
        await workletReadyRef.current;
      } catch (error) {
        workletReadyRef.current = null;
        throw error;
      }
      await ctx.resume();
      if (cancelled) return;

      node = new AudioWorkletNode(ctx, 'listen-playback-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      node.connect(ctx.destination);

      worker = new Worker(LISTEN_WS_WORKER_URL);
      if (cancelled) {
        worker.terminate();
        node.disconnect();
        return;
      }
      const channel = new MessageChannel();
      node.port.postMessage({ type: 'bind' }, [channel.port1]);
      worker.postMessage({ type: 'bind-playback' }, [channel.port2]);
      worker.onmessage = (event: MessageEvent) => {
        const message = event.data as {
          type?: string;
          state?: ListenStreamState;
          message?: string;
        };
        if (message.type === 'state' && message.state) {
          setStreamState(message.state);
        } else if (message.type === 'error' && message.message) {
          setStreamError(message.message);
          setStreamState('idle');
        }
      };

      const url = `ws://${
        window.location.hostname
      }:${wsPort}/listen-stream?session=${encodeURIComponent(activeSessionId)}`;
      setStreamError('');
      setStreamState('connecting');
      worker.postMessage({ type: 'connect', url });
    }

    void start().catch((error: unknown) => {
      if (cancelled) return;
      setStreamError(error instanceof Error ? error.message : '试听启动失败');
      setStreamState('idle');
    });

    return () => {
      cancelled = true;
      worker?.postMessage({ type: 'disconnect' });
      worker?.terminate();
      node?.port.postMessage({ type: 'reset' });
      node?.disconnect();
    };
  }, [listenKey, sessionId, wsPort]);

  useEffect(() => {
    return () => {
      void audioRef.current?.close();
      audioRef.current = null;
      workletReadyRef.current = null;
    };
  }, []);

  return { streamState, streamError };
}
