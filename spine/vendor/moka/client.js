// MOKA 客户端状态机：连接、回复生命周期、轨道存储、双向打断。播放器是唯一时钟。
import { MIC_SAMPLE_RATE, MicCapture } from "./audio/mic.js";
import { PcmPlayer } from "./audio/player.js";
import { ERR_AUTH_FAILED, ERR_VERSION_MISMATCH, decodeMsg, encodeMsg, packFrame, unpackFrame, } from "./protocol.js";
/** 打断后仍保留的 utterance 上限，防长会话状态无界增长 */
const MAX_KEPT_UTTERANCES = 32;
export class MokaClient {
    player;
    ws = null;
    utterances = new Map();
    cb;
    playbackTimer = null;
    interruptedSent = false;
    url = "";
    token = "";
    sessionId = "";
    retryDelay = 1000;
    closedByUser = false;
    mic;
    micStreamId = 0;
    micSeq = 0;
    micSentSamples = 0;
    staleStreams = new Set();
    fatalClose = false;
    fatalDetail = {};
    socketError = false;
    voiceAvailable = false;
    constructor(cb, opts = {}) {
        this.cb = cb;
        this.player = opts.player ?? new PcmPlayer();
        this.mic = opts.mic ?? new MicCapture();
        this.player.onOverflow = (dropped) => this.cb.onWarning?.("playback_overflow", { droppedSamples: dropped });
    }
    async connect(url, token) {
        this.url = url;
        this.token = token;
        this.closedByUser = false;
        await this.player.init();
        this.open();
    }
    close() {
        this.closedByUser = true;
        this.stopMic();
        this.stopPlaybackReport();
        this.ws?.close();
        this.player.dispose();
    }
    get micActive() {
        return this.mic.active;
    }
    safeSend(data) {
        if (this.ws?.readyState === WebSocket.OPEN)
            this.ws.send(data);
    }
    /** 开麦：声明收音流后持续推音频帧，服务端负责 VAD 与端点判定。
     *  speakerName 用于多说话人场景的识别归属，单说话人省略即可 */
    async startMic(speakerName) {
        if (this.mic.active || !this.voiceAvailable)
            return;
        // 开麦是用户手势：顺路解除 autoplay 挂起，纯语音对话也得出得了声
        await this.player.resume();
        this.micStreamId += 1;
        this.micSeq = 0;
        this.micSentSamples = 0;
        const sid = this.micStreamId;
        const begin = { streamId: sid, sampleRate: MIC_SAMPLE_RATE };
        if (speakerName)
            begin.speaker = { name: speakerName };
        this.safeSend(encodeMsg("input.audio.begin", begin));
        await this.mic.start((pcm) => {
            const ptsMs = Math.round((this.micSentSamples / MIC_SAMPLE_RATE) * 1000);
            this.safeSend(packFrame(sid, this.micSeq++, ptsMs, pcm));
            this.micSentSamples += pcm.length;
        });
    }
    /** 收音停止的唯一出口：主动关麦与连接断开都走这里，消费方只需听 onMicStopped */
    stopMic() {
        if (!this.mic.active)
            return;
        this.mic.stop();
        const ptsMs = Math.round((this.micSentSamples / MIC_SAMPLE_RATE) * 1000);
        this.safeSend(packFrame(this.micStreamId, this.micSeq++, ptsMs, new Int16Array(0), true));
        this.cb.onMicStopped?.();
    }
    open() {
        this.cb.onStatus?.("connecting");
        const ws = new WebSocket(this.url);
        ws.binaryType = "arraybuffer";
        this.ws = ws;
        this.socketError = false;
        ws.onopen = () => {
            const payload = { token: this.token, debug: true };
            if (this.sessionId)
                payload.resumeSessionId = this.sessionId;
            ws.send(encodeMsg("hello", payload));
        };
        ws.onclose = () => {
            this.stopPlaybackReport();
            // 收音流随连接失效，重连后由用户重新开麦
            this.stopMic();
            if (this.fatalClose) {
                this.cb.onStatus?.("fatal", this.fatalDetail);
                return;
            }
            if (this.closedByUser) {
                this.cb.onStatus?.("disconnected");
                return;
            }
            const retryInMs = this.retryDelay;
            this.cb.onStatus?.("reconnecting", {
                retryInMs,
                message: this.socketError ? "socket error" : undefined,
            });
            setTimeout(() => this.open(), retryInMs);
            this.retryDelay = Math.min(this.retryDelay * 2, 10000);
        };
        // onerror 之后必然 onclose，细节留给 close 一并上报，避免状态闪烁
        ws.onerror = () => {
            this.socketError = true;
        };
        ws.onmessage = (e) => {
            if (typeof e.data === "string") {
                this.handleText(decodeMsg(e.data));
            }
            else {
                this.handleFrame(e.data);
            }
        };
    }
    /** interrupt: "soft" = 皮套说完当前句再回应新输入；默认立即打断 */
    sendText(text, opts) {
        void this.player.resume();
        const payload = { text };
        if (opts?.interrupt === "soft")
            payload.interrupt = "soft";
        this.safeSend(encodeMsg("input.text", payload));
    }
    /** 环境信息注入。silent=true 只入 agent 记忆不触发回复 */
    sendContext(text, silent = true) {
        this.safeSend(encodeMsg("input.context", { text, silent }));
    }
    sendModelInfo(info) {
        this.safeSend(encodeMsg("model.info", { ...info }));
    }
    /** 用户主动打断：立即停播并上报 interrupted */
    interruptByUser() {
        const pos = this.player.position();
        this.discardPending();
        this.safeSend(encodeMsg("interrupted", {
            streamId: pos?.streamId ?? 0,
            playedPtsMs: pos?.ptsMs ?? 0,
            reason: "user",
        }));
        this.interruptedSent = true;
        this.cb.onInterrupted?.();
    }
    /** 清播放缓冲并把现有 utterance 全标失效：在途二进制帧不得再进新缓冲 */
    discardPending() {
        this.player.clear();
        // 整体替换而非累加：更早的 stale 帧早已流干，长会话集合不膨胀
        this.staleStreams = new Set(this.utterances.keys());
    }
    utterance(streamId) {
        return this.utterances.get(streamId);
    }
    position() {
        return this.player.position();
    }
    /** 在渲染循环里每帧调用，按播放位置派发到点的表演事件 */
    pumpEvents() {
        const pos = this.player.position();
        if (!pos)
            return;
        const u = this.utterances.get(pos.streamId);
        if (u)
            this.fireEvents(u, pos.ptsMs);
    }
    /** 只前进不回放：下标进 firedEvents 后不再触发，track 追加的新事件下轮自然扫到 */
    fireEvents(u, ptsMs) {
        for (let k = 0; k < u.events.length; k++) {
            if (!u.firedEvents.has(k) && u.events[k].ptsMs <= ptsMs) {
                u.firedEvents.add(k);
                this.cb.onEvent?.(u.events[k]);
            }
        }
    }
    handleText(msg) {
        const p = msg.payload ?? {};
        switch (msg.op) {
            case "welcome": {
                this.retryDelay = 1000;
                const sid = String(p.session?.sessionId ?? "");
                if (this.sessionId && sid !== this.sessionId) {
                    // 服务端没认出旧会话，本地播放队列作废
                    this.player.clear();
                    this.utterances.clear();
                    this.staleStreams.clear();
                }
                this.sessionId = sid;
                const uplink = p.audio?.uplink;
                this.voiceAvailable = Boolean(uplink?.enabled);
                this.cb.onVoiceAvailable?.(this.voiceAvailable);
                this.cb.onStatus?.("connected");
                this.cb.onWelcome?.(p);
                this.startPlaybackReport();
                break;
            }
            case "reply.begin": {
                this.interruptedSent = false;
                // 软切换的旧句可能还在播：状态保留到自然播完（硬打断路径已在 interrupt 里标 stale），
                // 只按容量修剪防长会话累积
                const ids = [...this.utterances.keys()].sort((a, b) => a - b);
                for (const sid of ids.slice(0, Math.max(0, ids.length - MAX_KEPT_UTTERANCES))) {
                    this.utterances.delete(sid);
                }
                this.cb.onReplyBegin?.(String(p.replyId ?? ""));
                break;
            }
            case "reply.end":
                this.cb.onReplyEnd?.(p);
                break;
            case "utterance.begin": {
                const u = p;
                const state = {
                    streamId: u.streamId,
                    text: u.text,
                    mouth: u.mouth ?? [],
                    subtitle: [],
                    events: u.events ?? [],
                    firedEvents: new Set(),
                    done: false,
                };
                this.utterances.set(u.streamId, state);
                this.player.beginStream(u.streamId);
                this.cb.onUtterance?.(state);
                // 纯事件句没有音频，没有播放位置可等，收到即派发
                if (!state.text)
                    this.fireEvents(state, Infinity);
                break;
            }
            case "utterance.track": {
                const state = this.utterances.get(Number(p.streamId));
                if (!state)
                    break;
                state.mouth.push(...(p.mouth ?? []));
                state.subtitle.push(...(p.subtitle ?? []));
                // 只追加不重排：消费方按下标记已触发，插队会让旧事件重放
                state.events.push(...(p.events ?? []));
                break;
            }
            case "utterance.end": {
                const state = this.utterances.get(Number(p.streamId));
                if (state)
                    state.done = true;
                break;
            }
            case "interrupt": {
                // 服务端打断：停播清缓冲，回执实际听到的位置
                const pos = this.player.position();
                this.discardPending();
                if (!this.interruptedSent) {
                    this.safeSend(encodeMsg("interrupted", {
                        streamId: pos?.streamId ?? 0,
                        playedPtsMs: pos?.ptsMs ?? 0,
                        reason: "server",
                    }));
                }
                this.cb.onInterrupted?.();
                break;
            }
            case "asr.partial":
                this.cb.onAsrPartial?.(String(p.text ?? ""), p.speaker ? String(p.speaker) : undefined);
                break;
            case "asr.final":
                this.cb.onAsrFinal?.(String(p.text ?? ""), p.speaker ? String(p.speaker) : undefined);
                break;
            case "debug.metrics":
                this.cb.onMetrics?.(p);
                break;
            case "error": {
                const code = msg.error?.code ?? 0;
                const message = msg.error?.message ?? "";
                // 鉴权/版本错误重试也没用，按协议不再重连
                if (code === ERR_AUTH_FAILED || code === ERR_VERSION_MISMATCH) {
                    this.fatalClose = true;
                    this.fatalDetail = { code, message };
                }
                this.cb.onError?.(code, message);
                break;
            }
        }
    }
    handleFrame(data) {
        const frame = unpackFrame(data);
        if (this.staleStreams.has(frame.streamId))
            return; // 打断后在途的旧流帧
        if (frame.pcm.length)
            this.player.push(frame.pcm);
    }
    startPlaybackReport() {
        this.playbackTimer = setInterval(() => {
            const pos = this.player.position();
            if (pos)
                this.safeSend(encodeMsg("state.playback", { ...pos }));
        }, 1000);
    }
    stopPlaybackReport() {
        if (this.playbackTimer !== null)
            clearInterval(this.playbackTimer);
        this.playbackTimer = null;
    }
}
/** 逐字字幕：精确轨缺失时整句直出 */
export function subtitleAt(u, ptsMs) {
    if (!u.subtitle.length)
        return u.text;
    let shown = 0;
    for (const seg of u.subtitle) {
        if (seg.ptsMs > ptsMs)
            break;
        shown += seg.len;
    }
    return u.text.slice(0, shown);
}
/** 口型混合：只留赢家+亚军，次高×0.6、上限 0.7 */
export function mixMouth(frames, ptsMs) {
    if (!frames.length)
        return { a: 0, i: 0, u: 0, e: 0, o: 0 };
    let prev = frames[0];
    let next = frames[frames.length - 1];
    for (let k = 0; k < frames.length; k++) {
        if (frames[k].ptsMs <= ptsMs)
            prev = frames[k];
        if (frames[k].ptsMs >= ptsMs) {
            next = frames[k];
            break;
        }
    }
    const span = next.ptsMs - prev.ptsMs;
    const t = span > 0 ? Math.min(1, Math.max(0, (ptsMs - prev.ptsMs) / span)) : 0;
    const raw = ["a", "i", "u", "e", "o"].map((k) => [
        k,
        prev[k] + (next[k] - prev[k]) * t,
    ]);
    raw.sort((x, y) => y[1] - x[1]);
    const out = { a: 0, i: 0, u: 0, e: 0, o: 0 };
    out[raw[0][0]] = raw[0][1];
    out[raw[1][0]] = Math.min(0.7, raw[1][1] * 0.6);
    return out;
}
//# sourceMappingURL=client.js.map