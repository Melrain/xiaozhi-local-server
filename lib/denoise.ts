const DENOISE_KEY = Symbol.for("xiaozhi.denoise");
const FRAME = 480;
const RN_RATE = 48000;

type WasmModule = {
  ready: Promise<WasmModule>;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  _rnnoise_create: () => number;
  _rnnoise_destroy: (ctx: number) => void;
  _rnnoise_process_frame: (ctx: number, input: number, output: number) => number;
  HEAPF32: Float32Array;
};

type Biquad = {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
};

type SessionDenoise = {
  sampleRate: number;
  filters: Biquad[];
  leftover: Float32Array;
  ctx: number;
  inputPtr: number;
  inputF32Index: number;
  makeup: number;
};

type DenoiseStore = {
  enabled: boolean;
  wasm: WasmModule | null;
  sessions: Map<string, SessionDenoise>;
};

function store(): DenoiseStore {
  const globalWithStore = globalThis as typeof globalThis & {
    [DENOISE_KEY]?: DenoiseStore;
  };
  if (!globalWithStore[DENOISE_KEY]) {
    globalWithStore[DENOISE_KEY] = {
      enabled: true,
      wasm: null,
      sessions: new Map(),
    };
  }
  return globalWithStore[DENOISE_KEY];
}

export function isDenoiseEnabled(): boolean {
  return store().enabled;
}

export function setDenoiseEnabled(enabled: boolean): void {
  store().enabled = enabled;
}

function biquad(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): Biquad {
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
    x1: 0,
    x2: 0,
    y1: 0,
    y2: 0,
  };
}

function highpass(sr: number, fc: number, q = Math.SQRT1_2): Biquad {
  const w0 = (2 * Math.PI * fc) / sr;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  return biquad((1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
}

function notch(sr: number, fc: number, q: number): Biquad {
  const w0 = (2 * Math.PI * fc) / sr;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  return biquad(1, -2 * cos, 1, 1 + alpha, -2 * cos, 1 - alpha);
}

function lowpass(sr: number, fc: number, q = Math.SQRT1_2): Biquad {
  const w0 = (2 * Math.PI * fc) / sr;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  return biquad((1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
}

function runBiquad(filter: Biquad, x: number): number {
  const y = filter.b0 * x + filter.b1 * filter.x1 + filter.b2 * filter.x2 - filter.a1 * filter.y1 - filter.a2 * filter.y2;
  filter.x2 = filter.x1;
  filter.x1 = x;
  filter.y2 = filter.y1;
  filter.y1 = y;
  return y;
}

function makeFilters(sampleRate: number): Biquad[] {
  const nyquist = sampleRate / 2 - 200;
  return [
    highpass(sampleRate, 95),
    notch(sampleRate, 50, 10),
    notch(sampleRate, 60, 10),
    notch(sampleRate, 100, 8),
    notch(sampleRate, 120, 8),
    lowpass(sampleRate, Math.min(7200, nyquist)),
  ];
}

function applyFilters(samples: Float32Array, filters: Biquad[]): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    let x = samples[i] ?? 0;
    for (const filter of filters) {
      x = runBiquad(filter, x);
    }
    out[i] = x;
  }
  return out;
}

function toFloat(pcm: Buffer): Float32Array {
  const n = pcm.length / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = pcm.readInt16LE(i * 2) / 32768;
  }
  return out;
}

function fromFloat(samples: Float32Array): Buffer {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const clipped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    out.writeInt16LE(Math.round(clipped * 32767), i * 2);
  }
  return out;
}

function cubicAt(samples: Float32Array, pos: number): number {
  const last = samples.length - 1;
  if (last <= 0) return samples[0] ?? 0;
  const i = Math.max(0, Math.min(last, Math.floor(pos)));
  const f = pos - i;
  const p0 = samples[Math.max(0, i - 1)] ?? 0;
  const p1 = samples[i] ?? 0;
  const p2 = samples[Math.min(last, i + 1)] ?? 0;
  const p3 = samples[Math.min(last, i + 2)] ?? 0;
  return (
    p1 +
    0.5 *
      f *
      (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)))
  );
}

function resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const outLen = Math.max(1, Math.round((samples.length * toRate) / fromRate));
  const out = new Float32Array(outLen);
  const step = fromRate / toRate;
  for (let i = 0; i < outLen; i += 1) {
    out[i] = cubicAt(samples, i * step);
  }
  return out;
}

function processRnnoise(state: SessionDenoise, wasm: WasmModule, at48k: Float32Array): Float32Array {
  const merged = new Float32Array(state.leftover.length + at48k.length);
  merged.set(state.leftover, 0);
  merged.set(at48k, state.leftover.length);

  const frames = Math.floor(merged.length / FRAME);
  const out = new Float32Array(frames * FRAME);
  const heap = wasm.HEAPF32;
  const index = state.inputF32Index;

  for (let f = 0; f < frames; f += 1) {
    const off = f * FRAME;
    for (let i = 0; i < FRAME; i += 1) {
      heap[index + i] = (merged[off + i] ?? 0) * 32768;
    }
    wasm._rnnoise_process_frame(state.ctx, state.inputPtr, state.inputPtr);
    for (let i = 0; i < FRAME; i += 1) {
      out[off + i] = (heap[index + i] ?? 0) / 32768;
    }
  }

  state.leftover = merged.subarray(frames * FRAME);
  return out;
}

function rmsOf(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i] ?? 0;
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}

function peakOf(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const a = Math.abs(samples[i] ?? 0);
    if (a > peak) peak = a;
  }
  return peak;
}

function scale(samples: Float32Array, gain: number): Float32Array {
  if (Math.abs(gain - 1) < 0.001) return samples;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    out[i] = (samples[i] ?? 0) * gain;
  }
  return out;
}

function mix(wet: Float32Array, dry: Float32Array, wetGain: number): Float32Array {
  const n = Math.min(wet.length, dry.length);
  const out = new Float32Array(n);
  const dryGain = 1 - wetGain;
  for (let i = 0; i < n; i += 1) {
    out[i] = (wet[i] ?? 0) * wetGain + (dry[i] ?? 0) * dryGain;
  }
  return out;
}

function applyMakeup(samples: Float32Array, state: SessionDenoise): Float32Array {
  const peak = peakOf(samples);
  const rms = rmsOf(samples);
  let target = 1;
  if (peak >= 0.01 && peak < 0.35) {
    target = Math.min(5, 0.28 / peak);
  } else if (rms >= 0.006 && rms < 0.08) {
    target = Math.min(4, 0.1 / rms);
  }
  state.makeup += (target - state.makeup) * 0.25;
  return scale(samples, state.makeup);
}

function attachWasm(state: SessionDenoise, wasm: WasmModule): void {
  if (state.ctx) return;
  state.inputPtr = wasm._malloc(FRAME * 4);
  state.inputF32Index = state.inputPtr >> 2;
  state.ctx = wasm._rnnoise_create();
}

function getSession(sessionId: string, wasm: WasmModule | null, sampleRate: number): SessionDenoise {
  const current = store().sessions.get(sessionId);
  if (current) {
    if (current.sampleRate !== sampleRate) {
      current.sampleRate = sampleRate;
      current.filters = makeFilters(sampleRate);
    }
    if (wasm) attachWasm(current, wasm);
    return current;
  }

  const next: SessionDenoise = {
    sampleRate,
    filters: makeFilters(sampleRate),
    leftover: new Float32Array(0),
    ctx: 0,
    inputPtr: 0,
    inputF32Index: 0,
    makeup: 1,
  };
  if (wasm) attachWasm(next, wasm);
  store().sessions.set(sessionId, next);
  return next;
}

export function disposeDenoise(sessionId: string): void {
  const current = store().sessions.get(sessionId);
  const wasm = store().wasm;
  if (current && wasm) {
    try {
      if (current.inputPtr) wasm._free(current.inputPtr);
      if (current.ctx) wasm._rnnoise_destroy(current.ctx);
    } catch {
      // ignore
    }
  }
  store().sessions.delete(sessionId);
}

export function denoisePcm(sessionId: string, pcm: Buffer, sampleRate: number): Buffer {
  if (pcm.length < 4) return pcm;
  const wasm = store().wasm;
  const state = getSession(sessionId, wasm, sampleRate);
  const filtered = applyMakeup(applyFilters(toFloat(pcm), state.filters), state);

  if (!store().enabled) {
    return fromFloat(filtered);
  }

  if (!wasm || !state.ctx) {
    return fromFloat(filtered);
  }

  const cleaned = processRnnoise(state, wasm, resample(filtered, sampleRate, RN_RATE));
  if (cleaned.length === 0) {
    return fromFloat(filtered);
  }
  const timed = resample(cleaned, RN_RATE, sampleRate);
  return fromFloat(mix(timed, filtered, 0.72));
}

export async function startDenoise(): Promise<"rnnoise" | "gate"> {
  if (store().wasm) return "rnnoise";
  try {
    const mod = await import("@jitsi/rnnoise-wasm/dist/rnnoise-sync.js");
    const create = mod.default ?? mod.createRNNWasmModuleSync;
    if (typeof create !== "function") {
      throw new Error("rnnoise sync loader missing");
    }
    const wasm = create() as WasmModule;
    await wasm.ready;
    if (typeof wasm._rnnoise_create !== "function") {
      throw new Error("rnnoise exports missing");
    }
    store().wasm = wasm;
    console.log("[DENOISE] RNNoise WASM ready");
    return "rnnoise";
  } catch (error) {
    console.warn("[DENOISE] RNNoise unavailable, using high-pass + gate", error);
    return "gate";
  }
}

export function denoiseBackend(): "rnnoise" | "gate" | "off" {
  if (!store().enabled) return "off";
  return store().wasm ? "rnnoise" : "gate";
}
