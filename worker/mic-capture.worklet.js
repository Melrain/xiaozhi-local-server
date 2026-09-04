class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.phase = 0;
    this.port.onmessage = (event) => {
      const rate = Number(event.data?.targetRate);
      if (rate > 0) this.targetRate = rate;
    };
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;

    const ratio = this.targetRate / sampleRate;
    let pcm;
    if (Math.abs(ratio - 1) < 0.001) {
      pcm = new Int16Array(input.length);
      for (let i = 0; i < input.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, input[i]));
        pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
    } else {
      const outCount = Math.max(1, Math.round(input.length * ratio));
      pcm = new Int16Array(outCount);
      const step = sampleRate / this.targetRate;
      for (let i = 0; i < outCount; i += 1) {
        const src = this.phase + i * step;
        const i0 = Math.min(input.length - 1, Math.floor(src));
        const i1 = Math.min(input.length - 1, i0 + 1);
        const frac = src - i0;
        const sample = Math.max(-1, Math.min(1, input[i0] + (input[i1] - input[i0]) * frac));
        pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      this.phase += outCount * step - input.length;
      if (this.phase < 0) this.phase = 0;
      if (this.phase >= 1) this.phase %= 1;
    }

    this.port.postMessage({ type: "pcm", pcm: pcm.buffer }, [pcm.buffer]);
    return true;
  }
}

registerProcessor("mic-capture-processor", MicCaptureProcessor);
