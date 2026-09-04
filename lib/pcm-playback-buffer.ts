export type PlaybackMode = "live" | "queue";

export type PlaybackWindow = {
  capacity: number;
  maxLag: number;
  startThreshold: number;
};

export function playbackWindow(outputRate: number, mode: PlaybackMode): PlaybackWindow {
  if (mode === "queue") {
    const capacity = Math.max(2048, Math.ceil(outputRate * 12));
    return {
      capacity,
      maxLag: capacity,
      startThreshold: Math.ceil(outputRate * 0.04),
    };
  }
  return {
    capacity: Math.max(2048, Math.ceil(outputRate * 0.35)),
    maxLag: Math.ceil(outputRate * 0.08),
    startThreshold: Math.ceil(outputRate * 0.03),
  };
}

export function dropForIncoming(
  size: number,
  incoming: number,
  window: PlaybackWindow,
  mode: PlaybackMode,
): number {
  if (mode !== "live") return 0;
  if (size + incoming <= window.maxLag) return 0;
  return Math.min(size, size + incoming - window.startThreshold);
}

export function bufferedSecondsAfterBurst(options: {
  outputRate: number;
  mode: PlaybackMode;
  burstSeconds: number;
  chunkSeconds?: number;
}): number {
  const { outputRate, mode, burstSeconds, chunkSeconds = 0.02 } = options;
  const window = playbackWindow(outputRate, mode);
  let size = 0;
  const total = Math.round(outputRate * burstSeconds);
  const chunk = Math.max(1, Math.round(outputRate * chunkSeconds));

  for (let sent = 0; sent < total; sent += chunk) {
    const incoming = Math.min(chunk, total - sent);
    size -= dropForIncoming(size, incoming, window, mode);
    for (let i = 0; i < incoming; i += 1) {
      if (size < window.capacity) {
        size += 1;
      }
    }
  }

  return size / outputRate;
}
