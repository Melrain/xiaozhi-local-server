import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import ffmpegStatic from "ffmpeg-static";
import OpusScript from "opusscript";

const OPUS_HEAD = Buffer.from("OpusHead");
const OPUS_TAGS = Buffer.from("OpusTags");

export function extractOpusPackets(ogg: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  let offset = 0;
  let pending: Buffer[] = [];

  while (offset + 27 <= ogg.length) {
    if (ogg.toString("ascii", offset, offset + 4) !== "OggS") {
      offset += 1;
      continue;
    }

    const segmentCount = ogg[offset + 26] ?? 0;
    const tableStart = offset + 27;
    if (tableStart + segmentCount > ogg.length) break;

    let bodyStart = tableStart + segmentCount;
    let parts = pending;
    pending = [];

    for (let i = 0; i < segmentCount; i += 1) {
      const size = ogg[tableStart + i] ?? 0;
      if (bodyStart + size > ogg.length) return packets;
      parts.push(ogg.subarray(bodyStart, bodyStart + size));
      bodyStart += size;
      if (size < 255) {
        packets.push(Buffer.concat(parts));
        parts = [];
      }
    }

    pending = parts;
    offset = bodyStart;
  }

  return packets.filter((packet) => {
    if (packet.length >= 8 && packet.subarray(0, 8).equals(OPUS_HEAD)) return false;
    if (packet.length >= 8 && packet.subarray(0, 8).equals(OPUS_TAGS)) return false;
    return packet.length > 0;
  });
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const err: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited ${code}: ${Buffer.concat(err).toString("utf8").slice(-400)}`));
    });
  });
}

export async function audioFileToOpusFrames(inputPath: string, outputOggPath: string): Promise<Buffer[]> {
  if (!ffmpegStatic) {
    throw new Error("ffmpeg-static binary not found");
  }
  await run(ffmpegStatic, [
    "-y",
    "-i",
    inputPath,
    "-ac",
    "1",
    "-ar",
    "24000",
    "-c:a",
    "libopus",
    "-application",
    "voip",
    "-frame_duration",
    "60",
    "-b:a",
    "24k",
    outputOggPath,
  ]);
  const ogg = await readFile(outputOggPath);
  const frames = extractOpusPackets(ogg);
  if (frames.length === 0) {
    throw new Error(`no opus frames in ${outputOggPath}`);
  }
  return frames;
}

export const DOWNLINK_SAMPLE_RATE = 24000;
export const UPLINK_BAILIAN_RATE = 16000;
export const OPUS_FRAME_MS = 60;
const DOWNLINK_SAMPLES_PER_FRAME = (DOWNLINK_SAMPLE_RATE * OPUS_FRAME_MS) / 1000;
const DOWNLINK_BYTES_PER_FRAME = DOWNLINK_SAMPLES_PER_FRAME * 2;

export function resamplePcmS16le(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate || pcm.length < 2) return pcm;
  const inSamples = Math.floor(pcm.length / 2);
  const outSamples = Math.max(1, Math.round((inSamples * toRate) / fromRate));
  const out = Buffer.alloc(outSamples * 2);
  const last = Math.max(0, inSamples - 1);
  for (let i = 0; i < outSamples; i += 1) {
    const src = (i * fromRate) / toRate;
    const i0 = Math.min(last, Math.floor(src));
    const i1 = Math.min(last, i0 + 1);
    const frac = src - i0;
    const s0 = pcm.readInt16LE(i0 * 2);
    const s1 = pcm.readInt16LE(i1 * 2);
    out.writeInt16LE(
      Math.max(-32768, Math.min(32767, Math.round(s0 + (s1 - s0) * frac))),
      i * 2,
    );
  }
  return out;
}

export class PcmOpusEncoder {
  private readonly encoder: InstanceType<typeof OpusScript>;
  private leftover: Buffer = Buffer.alloc(0);

  constructor(sampleRate: 8000 | 12000 | 16000 | 24000 | 48000 = DOWNLINK_SAMPLE_RATE) {
    this.encoder = new OpusScript(sampleRate, 1, OpusScript.Application.VOIP);
    try {
      this.encoder.setBitrate(24000);
    } catch {
      // some builds reject setBitrate; VOIP defaults are fine
    }
  }

  push(pcm: Buffer): Buffer[] {
    const frames: Buffer[] = [];
    let data = this.leftover.length > 0 ? Buffer.concat([this.leftover, pcm]) : pcm;
    while (data.length >= DOWNLINK_BYTES_PER_FRAME) {
      const slice = data.subarray(0, DOWNLINK_BYTES_PER_FRAME);
      data = data.subarray(DOWNLINK_BYTES_PER_FRAME);
      frames.push(this.encodeFrame(slice));
    }
    this.leftover = data;
    return frames;
  }

  flush(): Buffer[] {
    if (this.leftover.length === 0) return [];
    const padded = Buffer.alloc(DOWNLINK_BYTES_PER_FRAME);
    this.leftover.copy(padded);
    this.leftover = Buffer.alloc(0);
    return [this.encodeFrame(padded)];
  }

  reset(): void {
    this.leftover = Buffer.alloc(0);
  }

  dispose(): void {
    this.reset();
    try {
      this.encoder.delete();
    } catch {
      // ignore
    }
  }

  private encodeFrame(pcm: Buffer): Buffer {
    const encoded = this.encoder.encode(pcm, DOWNLINK_SAMPLES_PER_FRAME);
    return Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded);
  }
}
