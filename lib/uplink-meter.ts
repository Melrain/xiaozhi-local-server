import OpusScript from "opusscript";
import { denoisePcm, disposeDenoise } from "./denoise";
import { broadcastUplinkPcm } from "./listen-stream";

const DECODER_KEY = Symbol.for("xiaozhi.uplink-decoders");
const WINDOW_KEY = Symbol.for("xiaozhi.uplink-windows");
const PCM_KEY = Symbol.for("xiaozhi.uplink-pcm");
const HINT_KEY = Symbol.for("xiaozhi.uplink-rate-hint");
const SAMPLE_RATES = [16000, 24000] as const;
const FPS_WINDOW_MS = 1000;
const PCM_MAX_BYTES = 16000 * 2 * 2; // keep ~2 frames for HTTP fallback only

type DecoderSlot = {
  sampleRate: number;
  decoder: InstanceType<typeof OpusScript>;
};

function decoderMap(): Map<string, DecoderSlot> {
  const globalWithStore = globalThis as typeof globalThis & {
    [DECODER_KEY]?: Map<string, DecoderSlot>;
  };
  if (!globalWithStore[DECODER_KEY]) {
    globalWithStore[DECODER_KEY] = new Map();
  }
  return globalWithStore[DECODER_KEY];
}

function windowMap(): Map<string, number[]> {
  const globalWithStore = globalThis as typeof globalThis & {
    [WINDOW_KEY]?: Map<string, number[]>;
  };
  if (!globalWithStore[WINDOW_KEY]) {
    globalWithStore[WINDOW_KEY] = new Map();
  }
  return globalWithStore[WINDOW_KEY];
}

type PcmBucket = {
  chunks: Buffer[];
  bytes: number;
};

function pcmMap(): Map<string, PcmBucket> {
  const globalWithStore = globalThis as typeof globalThis & {
    [PCM_KEY]?: Map<string, PcmBucket>;
  };
  if (!globalWithStore[PCM_KEY]) {
    globalWithStore[PCM_KEY] = new Map();
  }
  return globalWithStore[PCM_KEY];
}

function hintMap(): Map<string, number> {
  const globalWithStore = globalThis as typeof globalThis & {
    [HINT_KEY]?: Map<string, number>;
  };
  if (!globalWithStore[HINT_KEY]) {
    globalWithStore[HINT_KEY] = new Map();
  }
  return globalWithStore[HINT_KEY];
}

export function setUplinkSampleRateHint(sessionId: string, sampleRate: number): void {
  if (sampleRate === 16000 || sampleRate === 24000) {
    hintMap().set(sessionId, sampleRate);
  }
}

function ratesToTry(sessionId: string): number[] {
  const hint = hintMap().get(sessionId);
  if (hint === 24000) return [24000, 16000];
  return [16000, 24000];
}

function frameMatchesRate(pcm: Buffer, sampleRate: number): boolean {
  const samples = pcm.length / 2;
  return [20, 40, 60].some((ms) => Math.abs(samples - Math.round((sampleRate * ms) / 1000)) <= 8);
}

function pushPcm(sessionId: string, pcm: Buffer): void {
  const bucket = pcmMap().get(sessionId) ?? { chunks: [], bytes: 0 };
  bucket.chunks.push(pcm);
  bucket.bytes += pcm.length;
  while (bucket.bytes > PCM_MAX_BYTES && bucket.chunks.length > 1) {
    const dropped = bucket.chunks.shift();
    if (dropped) bucket.bytes -= dropped.length;
  }
  pcmMap().set(sessionId, bucket);
}

function pcmRms(pcm: Buffer): number {
  const samples = pcm.length / 2;
  if (samples <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 2) {
    const sample = pcm.readInt16LE(i);
    sum += sample * sample;
  }
  return Math.min(1, Math.sqrt(sum / samples) / 4000);
}

function tryDecode(decoder: InstanceType<typeof OpusScript>, frame: Buffer): Buffer | null {
  try {
    const pcm = decoder.decode(frame);
    if (!pcm || pcm.length < 320) return null;
    return Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  } catch {
    return null;
  }
}

function createDecoder(sampleRate: (typeof SAMPLE_RATES)[number]): InstanceType<typeof OpusScript> {
  return new OpusScript(sampleRate, 1, OpusScript.Application.VOIP);
}

function decodeFrame(sessionId: string, frame: Buffer): Buffer | null {
  const existing = decoderMap().get(sessionId);
  if (existing) {
    const pcm = tryDecode(existing.decoder, frame);
    if (pcm && frameMatchesRate(pcm, existing.sampleRate)) return pcm;
    try {
      existing.decoder.delete();
    } catch {
      // ignore
    }
    decoderMap().delete(sessionId);
  }

  for (const sampleRate of ratesToTry(sessionId)) {
    const decoder = createDecoder(sampleRate);
    const pcm = tryDecode(decoder, frame);
    if (pcm && frameMatchesRate(pcm, sampleRate)) {
      decoderMap().set(sessionId, { sampleRate, decoder });
      console.log(`[UPLINK] decode ${sampleRate} Hz session=${sessionId.slice(0, 8)}`);
      return pcm;
    }
    try {
      decoder.delete();
    } catch {
      // ignore
    }
  }
  return null;
}

export function resetUplinkMeter(sessionId: string): void {
  windowMap().set(sessionId, []);
  pcmMap().delete(sessionId);
  disposeDenoise(sessionId);
}

export function disposeUplinkMeter(sessionId: string): void {
  const slot = decoderMap().get(sessionId);
  if (slot) {
    try {
      slot.decoder.delete();
    } catch {
      // ignore
    }
    decoderMap().delete(sessionId);
  }
  windowMap().delete(sessionId);
  pcmMap().delete(sessionId);
  hintMap().delete(sessionId);
  disposeDenoise(sessionId);
}

export function takeUplinkPcm(sessionId: string): { pcm: Buffer; sampleRate: number } {
  const bucket = pcmMap().get(sessionId);
  const sampleRate = decoderMap().get(sessionId)?.sampleRate ?? 16000;
  pcmMap().set(sessionId, { chunks: [], bytes: 0 });
  if (!bucket || bucket.chunks.length === 0) {
    return { pcm: Buffer.alloc(0), sampleRate };
  }
  return { pcm: Buffer.concat(bucket.chunks), sampleRate };
}

export function getUplinkSampleRate(sessionId: string): number {
  return decoderMap().get(sessionId)?.sampleRate ?? 16000;
}

export function measureUplinkFrame(sessionId: string, frame: Buffer): {
  level: number;
  framesPerSec: number;
} {
  const now = Date.now();
  const times = windowMap().get(sessionId) ?? [];
  times.push(now);
  const recent = times.filter((ts) => ts >= now - FPS_WINDOW_MS);
  windowMap().set(sessionId, recent);

  const pcm = decodeFrame(sessionId, frame);
  if (pcm) {
    const sampleRate = decoderMap().get(sessionId)?.sampleRate ?? 16000;
    const cleaned = denoisePcm(sessionId, pcm, sampleRate);
    pushPcm(sessionId, cleaned);
    broadcastUplinkPcm(sessionId, cleaned, sampleRate);
    return {
      level: pcmRms(cleaned),
      framesPerSec: recent.length,
    };
  }
  return {
    level: 0,
    framesPerSec: recent.length,
  };
}
