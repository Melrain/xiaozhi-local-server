class ListenPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.srcRate = 16000;
    this.mode = "live";
    this.capacity = 0;
    this.buffer = new Float32Array(0);
    this.readIndex = 0;
    this.writeIndex = 0;
    this.size = 0;
    this.started = false;
    this.last = 0;
    this.emptyBlocks = 0;
    this.phase = 0;
    this.configure(this.srcRate, this.mode);

    this.port.onmessage = (event) => {
      const message = event.data;
      if (message?.type === "bind" && event.ports[0]) {
        event.ports[0].onmessage = (portEvent) => {
          this.handleMessage(portEvent.data);
        };
        return;
      }
      this.handleMessage(message);
    };
  }

  handleMessage(message) {
    if (!message) return;
    if (message.type === "reset") {
      this.clear();
      return;
    }
    if (message.type === "hello" && message.sampleRate) {
      this.configure(Number(message.sampleRate) || 16000, message.mode);
      return;
    }
    if (message.type === "pcm" && message.pcm) {
      this.pushPcm(new Int16Array(message.pcm));
    }
  }

  configure(srcRate, mode) {
    this.srcRate = srcRate;
    this.mode = mode === "queue" ? "queue" : "live";
    const seconds = this.mode === "queue" ? 12 : 0.35;
    this.capacity = Math.max(2048, Math.ceil(sampleRate * seconds));
    this.buffer = new Float32Array(this.capacity);
    this.maxLag = this.mode === "queue" ? this.capacity : Math.ceil(sampleRate * 0.08);
    this.startThreshold = Math.ceil(sampleRate * (this.mode === "queue" ? 0.04 : 0.03));
    this.clear();
  }

  clear() {
    this.readIndex = 0;
    this.writeIndex = 0;
    this.size = 0;
    this.started = false;
    this.last = 0;
    this.emptyBlocks = 0;
    this.phase = 0;
  }

  drop(count) {
    const drop = Math.min(this.size, count);
    this.readIndex = (this.readIndex + drop) % this.capacity;
    this.size -= drop;
  }

  writeSample(value) {
    this.buffer[this.writeIndex] = value;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.size < this.capacity) {
      this.size += 1;
      return;
    }
    this.readIndex = this.writeIndex;
  }

  cubic(samples, pos) {
    const last = samples.length - 1;
    if (last <= 0) return (samples[0] || 0) / 32768;
    const i = Math.max(0, Math.min(last, Math.floor(pos)));
    const f = pos - i;
    const p0 = samples[Math.max(0, i - 1)] / 32768;
    const p1 = samples[i] / 32768;
    const p2 = samples[Math.min(last, i + 1)] / 32768;
    const p3 = samples[Math.min(last, i + 2)] / 32768;
    return p1 + 0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)));
  }

  pushPcm(samples) {
    if (samples.length === 0) return;

    const ratio = sampleRate / this.srcRate;
    const outCount = Math.max(1, Math.round(samples.length * ratio));
    if (this.mode === "live" && this.size + outCount > this.maxLag) {
      this.drop(this.size + outCount - this.startThreshold);
    }

    if (Math.abs(ratio - 1) < 0.001) {
      for (let i = 0; i < samples.length; i += 1) {
        this.writeSample(samples[i] / 32768);
      }
      this.phase = 0;
      return;
    }

    const step = this.srcRate / sampleRate;
    for (let i = 0; i < outCount; i += 1) {
      this.writeSample(this.cubic(samples, this.phase + i * step));
    }
    this.phase += outCount * step - samples.length;
    if (this.phase < 0) this.phase = 0;
    if (this.phase >= 1) this.phase %= 1;
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return true;

    if (!this.started) {
      if (this.size < this.startThreshold) {
        for (let i = 0; i < output.length; i += 1) {
          this.last *= 0.85;
          output[i] = this.last;
        }
        return true;
      }
      this.started = true;
      this.emptyBlocks = 0;
    }

    for (let i = 0; i < output.length; i += 1) {
      if (this.size > 0) {
        this.last = this.buffer[this.readIndex];
        this.readIndex = (this.readIndex + 1) % this.capacity;
        this.size -= 1;
        output[i] = this.last;
      } else {
        this.last *= 0.85;
        output[i] = this.last;
      }
    }

    if (this.size === 0) {
      this.emptyBlocks += 1;
      if (this.emptyBlocks > 3) this.started = false;
    } else {
      this.emptyBlocks = 0;
    }
    return true;
  }
}

registerProcessor("listen-playback-processor", ListenPlaybackProcessor);
