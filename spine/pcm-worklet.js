class PcmQueueProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.ended = false;
    this.drained = false;
    this.rmsSum = 0;
    this.rmsCount = 0;
    this.reportFrames = Math.max(256, Math.round(sampleRate / 25));
    this.port.onmessage = event => {
      const message = event.data;
      if (message.type === 'push' && message.samples?.length) {
        this.queue.push(message.samples);
        this.ended = false;
        this.drained = false;
      } else if (message.type === 'end') {
        this.ended = true;
      } else if (message.type === 'stop') {
        this.queue.length = 0;
        this.offset = 0;
        this.ended = false;
        this.drained = true;
        this.rmsSum = 0;
        this.rmsCount = 0;
        this.port.postMessage({ type: 'rms', value: 0 });
      }
    };
  }

  nextSample() {
    while (this.queue.length) {
      const current = this.queue[0];
      if (this.offset < current.length) return current[this.offset++];
      this.queue.shift();
      this.offset = 0;
    }
    return 0;
  }

  process(_inputs, outputs) {
    const channels = outputs[0];
    const frames = channels[0]?.length ?? 0;
    for (let index = 0; index < frames; index++) {
      const sample = this.nextSample();
      for (const channel of channels) channel[index] = sample;
      this.rmsSum += sample * sample;
      this.rmsCount++;
    }

    if (this.rmsCount >= this.reportFrames) {
      this.port.postMessage({ type: 'rms', value: Math.sqrt(this.rmsSum / this.rmsCount) });
      this.rmsSum = 0;
      this.rmsCount = 0;
    }

    if (this.ended && !this.queue.length && !this.drained) {
      this.drained = true;
      this.port.postMessage({ type: 'drained' });
    }
    return true;
  }
}

registerProcessor('pcm-queue', PcmQueueProcessor);
