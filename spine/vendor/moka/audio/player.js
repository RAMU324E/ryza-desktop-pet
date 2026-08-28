// AudioWorklet 环形缓冲播放器：唯一时钟，playedPts 供口型/字幕/打断对表
import { SAMPLE_RATE } from "../protocol.js";
const WORKLET_CODE = `
class MokaPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = ${SAMPLE_RATE} * 60;
    this.buf = new Float32Array(this.cap);
    this.r = 0; this.w = 0; this.played = 0; this.wasEmpty = true; this.lastReported = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.cmd === 'clear') { this.r = this.w; return; }
      const pcm = d.pcm;
      if (this.w - this.r + pcm.length > this.cap) {
        // 写满静默覆盖会让 pts 与内容永久错位，宁可丢块
        this.port.postMessage({ type: 'overflow', dropped: pcm.length });
        return;
      }
      for (let i = 0; i < pcm.length; i++) this.buf[(this.w + i) % this.cap] = pcm[i];
      this.w += pcm.length;
    };
  }
  process(_, outputs) {
    const out = outputs[0][0];
    const avail = this.w - this.r;
    if (avail > 0 && this.wasEmpty) { this.wasEmpty = false; this.port.postMessage({ type: 'started' }); }
    if (avail === 0) this.wasEmpty = true;
    const n = Math.min(out.length, avail);
    let sq = 0;
    for (let i = 0; i < n; i++) {
      const s = this.buf[(this.r + i) % this.cap];
      out[i] = s;
      sq += s * s;
    }
    this.r += n; this.played += n;
    this.sq = (this.sq ?? 0) * 0.7 + (n ? sq / n : 0) * 0.3;
    if (this.played - this.lastReported >= 1280) {
      this.lastReported = this.played;
      this.port.postMessage({ type: 'pos', played: this.played, buffered: this.w, rms: Math.sqrt(this.sq) });
    }
    return true;
  }
}
registerProcessor('moka-player', MokaPlayer);
`;
export class PcmPlayer {
    ctx = null;
    node = null;
    gain = null;
    volume = 1;
    totalWritten = 0;
    playedSamples = 0;
    streams = [];
    rms = 0;
    onStarted = null;
    onOverflow = null;
    async init() {
        this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
        const url = URL.createObjectURL(new Blob([WORKLET_CODE], { type: "application/javascript" }));
        try {
            await this.ctx.audioWorklet.addModule(url);
        }
        finally {
            URL.revokeObjectURL(url);
        }
        this.node = new AudioWorkletNode(this.ctx, "moka-player", { outputChannelCount: [1] });
        this.node.port.onmessage = (e) => {
            if (e.data.type === "pos") {
                this.playedSamples = e.data.played;
                this.rms = e.data.rms ?? 0;
            }
            if (e.data.type === "started")
                this.onStarted?.();
            if (e.data.type === "overflow")
                this.onOverflow?.(e.data.dropped);
        };
        this.gain = this.ctx.createGain();
        this.gain.gain.value = this.volume;
        this.node.connect(this.gain).connect(this.ctx.destination);
    }
    dispose() {
        this.node?.port.close();
        this.node?.disconnect();
        this.gain?.disconnect();
        void this.ctx?.close();
        this.node = null;
        this.gain = null;
        this.ctx = null;
    }
    async resume() {
        if (this.ctx?.state === "suspended")
            await this.ctx.resume();
    }
    beginStream(streamId) {
        // 只留当前在播的那条旧 mark，早已播完的没人再查
        let keepFrom = 0;
        for (let i = 0; i < this.streams.length; i++) {
            if (this.streams[i].startSample <= this.playedSamples)
                keepFrom = i;
        }
        if (keepFrom > 0)
            this.streams = this.streams.slice(keepFrom);
        this.streams.push({ streamId, startSample: this.totalWritten });
    }
    push(pcm) {
        if (!this.node)
            return;
        const f32 = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i++)
            f32[i] = pcm[i] / 32768;
        this.node.port.postMessage({ pcm: f32 }, [f32.buffer]);
        this.totalWritten += pcm.length;
    }
    setVolume(value) {
        this.volume = Math.min(1, Math.max(0, Number(value) || 0));
        if (this.gain && this.ctx)
            this.gain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
    }
    /** 正在播的 streamId 与句内 PTS，打断回执与轨道消费都以它为准 */
    position() {
        let cur = null;
        for (const s of this.streams)
            if (s.startSample <= this.playedSamples)
                cur = s;
        if (!cur)
            return null;
        return {
            streamId: cur.streamId,
            ptsMs: Math.max(0, Math.round(((this.playedSamples - cur.startSample) / SAMPLE_RATE) * 1000)),
        };
    }
    clear() {
        this.node?.port.postMessage({ cmd: "clear" });
        this.totalWritten = this.playedSamples;
        this.streams = [];
        this.rms = 0;
    }
    /** 播放响度 0-1：log10 归一，-40dB 静音、-10dB 全开 */
    loudness() {
        if (this.rms <= 0)
            return 0;
        const db = 20 * Math.log10(this.rms);
        return Math.min(1, Math.max(0, (db + 40) / 30));
    }
}
//# sourceMappingURL=player.js.map