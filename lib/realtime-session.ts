import { DEFAULT_REALTIME_INSTRUCTIONS, type RealtimeConfig } from "./config";
import { DOWNLINK_SAMPLE_RATE, UPLINK_BAILIAN_RATE } from "./opus-audio";

export const INPUT_TRANSCRIPTION_MODEL = "qwen3-asr-flash-realtime";

export function buildRealtimeSessionUpdate(config: RealtimeConfig): Record<string, unknown> {
  return {
    type: "session.update",
    session: {
      modalities: ["text", "audio"],
      voice: config.voice,
      instructions: config.instructions || DEFAULT_REALTIME_INSTRUCTIONS,
      audio: {
        input: { format: { type: "pcm", sample_rate: UPLINK_BAILIAN_RATE } },
        output: { format: { type: "pcm", sample_rate: DOWNLINK_SAMPLE_RATE } },
      },
      input_audio_transcription: { model: INPUT_TRANSCRIPTION_MODEL },
      turn_detection: {
        type: "server_vad",
        threshold: 0.2,
        prefix_padding_ms: 300,
        silence_duration_ms: 600,
        create_response: true,
        interrupt_response: true,
      },
    },
  };
}
