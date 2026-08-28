export const MIC_SAMPLE_RATE = 16000;
const WORKLET_CODE = `
class MokaMic extends AudioWorkletProcessor {
  constructor() {
    super();
    // 60ms 块：块越小服务端 VAD 判定越及时，帧头开销仍可忽略
    this.buf = new Float32Array(${MIC_SAMPLE_RATE} * 3 / 50);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0][0];
    if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      const take = Math.min(ch.length - i, this.buf.length - this.n);
      this.buf.set(ch.subarray(i, i + take), this.n);
      this.n += take;
      i += take;
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf.slice());
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('moka-mic', MokaMic);
`;
export class MicCapture {
    ctx = null;
    stream = null;
    node = null;
    starting = false;
    get active() {
        return this.ctx !== null || this.starting;
    }
    async start(onChunk) {
        // 哨兵必须在第一个 await 前生效：双击会开出两份 getUserMedia，先到的那份永远关不掉
        if (this.ctx || this.starting)
            return;
        this.starting = true;
        try {
            await this.doStart(onChunk);
        }
        finally {
            this.starting = false;
        }
    }
    async doStart(onChunk) {
        this.stream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        });
        const ctx = new AudioContext({ sampleRate: MIC_SAMPLE_RATE });
        this.ctx = ctx;
        const url = URL.createObjectURL(new Blob([WORKLET_CODE], { type: "application/javascript" }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        const node = new AudioWorkletNode(ctx, "moka-mic", { numberOfOutputs: 0 });
        this.node = node;
        node.port.onmessage = (e) => {
            const f32 = e.data;
            const s16 = new Int16Array(f32.length);
            for (let i = 0; i < f32.length; i++) {
                s16[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)));
            }
            onChunk(s16);
        };
        ctx.createMediaStreamSource(this.stream).connect(node);
    }
    stop() {
        this.node?.port.close();
        this.stream?.getTracks().forEach((t) => t.stop());
        this.ctx?.close();
        this.node = null;
        this.stream = null;
        this.ctx = null;
    }
}
//# sourceMappingURL=mic.js.map