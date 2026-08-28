(() => {
  'use strict';

  function decodeBase64(base64, format, channels, remainder = new Uint8Array()) {
    const binary = atob(base64);
    const incoming = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) incoming[index] = binary.charCodeAt(index);
    const bytes = new Uint8Array(remainder.length + incoming.length);
    bytes.set(remainder);
    bytes.set(incoming, remainder.length);
    const width = format === 'float32' ? 4 : 2;
    const frameWidth = width * Math.max(1, channels);
    const completeLength = bytes.length - (bytes.length % frameWidth);
    const complete = bytes.subarray(0, completeLength);
    const pending = bytes.slice(completeLength);
    const view = new DataView(complete.buffer, complete.byteOffset, complete.byteLength);
    const samples = new Float32Array(Math.floor(complete.length / width));
    for (let index = 0; index < samples.length; index++) {
      samples[index] = format === 'float32'
        ? view.getFloat32(index * 4, true)
        : view.getInt16(index * 2, true) / 32768;
    }
    if (channels <= 1) return { samples, pending };
    const frames = Math.floor(samples.length / channels);
    const mono = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame++) {
      let sum = 0;
      for (let channel = 0; channel < channels; channel++) sum += samples[frame * channels + channel];
      mono[frame] = sum / channels;
    }
    return { samples: mono, pending };
  }

  function resample(input, sourceRate, targetRate) {
    if (!input.length || sourceRate === targetRate) return input;
    const outputLength = Math.max(1, Math.round(input.length * targetRate / sourceRate));
    const output = new Float32Array(outputLength);
    const ratio = sourceRate / targetRate;
    for (let index = 0; index < outputLength; index++) {
      const position = index * ratio;
      const left = Math.floor(position);
      const right = Math.min(left + 1, input.length - 1);
      const fraction = position - left;
      output[index] = input[left] + (input[right] - input[left]) * fraction;
    }
    return output;
  }

  class RyzaPcmAudio {
    constructor({ onLevel, onDrained } = {}) {
      this.onLevel = onLevel ?? (() => {});
      this.onDrained = onDrained ?? (() => {});
      this.context = null;
      this.node = null;
      this.gain = null;
      this.readyPromise = null;
      this.meta = { sampleRate: 24000, channels: 1, format: 'int16' };
      this.pendingBytes = new Uint8Array();
      this.volume = 1;
    }

    async ensureStarted() {
      if (!this.readyPromise) {
        this.readyPromise = (async () => {
          if (!this.context) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            this.context = new AudioContext({ latencyHint: 'interactive' });
          }
          await this.context.audioWorklet.addModule('pcm-worklet.js');
          if (!this.node) {
            this.node = new AudioWorkletNode(this.context, 'pcm-queue', { outputChannelCount: [2] });
            this.gain = this.context.createGain();
            this.gain.gain.value = this.volume;
            this.node.connect(this.gain).connect(this.context.destination);
            this.node.port.onmessage = event => {
              if (event.data.type === 'rms') this.onLevel(event.data.value);
              if (event.data.type === 'drained') this.onDrained();
            };
          }
        })().catch(error => {
          this.readyPromise = null;
          throw error;
        });
      }
      await this.readyPromise;
      if (this.context.state !== 'running') await this.context.resume();
    }

    async start(meta) {
      await this.ensureStarted();
      this.stop(false);
      this.meta = {
        sampleRate: Number(meta.sampleRate) || 24000,
        channels: Math.max(1, Number(meta.channels) || 1),
        format: meta.format === 'float32' ? 'float32' : 'int16',
      };
      this.pendingBytes = new Uint8Array();
    }

    push(base64) {
      if (!this.node || !base64) return;
      const decoded = decodeBase64(base64, this.meta.format, this.meta.channels, this.pendingBytes);
      this.pendingBytes = decoded.pending;
      if (!decoded.samples.length) return;
      const samples = resample(decoded.samples, this.meta.sampleRate, this.context.sampleRate);
      this.node.port.postMessage({ type: 'push', samples }, [samples.buffer]);
    }

    end() {
      if (this.pendingBytes.length) {
        const bytes = this.pendingBytes.length;
        this.stop();
        throw new Error(`PCM 响应结尾缺少完整音频帧（残留 ${bytes} 字节）`);
      }
      this.node?.port.postMessage({ type: 'end' });
    }

    stop(notify = true) {
      this.pendingBytes = new Uint8Array();
      this.node?.port.postMessage({ type: 'stop' });
      if (notify) this.onDrained();
    }

    setVolume(value) {
      this.volume = Math.min(1, Math.max(0, Number(value) || 0));
      if (this.gain) this.gain.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.02);
    }
  }

  window.RyzaPcmAudio = RyzaPcmAudio;
})();
