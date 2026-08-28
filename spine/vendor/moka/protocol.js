// MOKA 协议编解码，与 PROTOCOL.md 对齐；二进制帧 16 字节头小端
export const PROTOCOL_VERSION = 0;
export const SAMPLE_RATE = 32000;
export const FLAG_FINAL = 0x01;
export const ERR_AUTH_FAILED = 4001;
export const ERR_VERSION_MISMATCH = 4002;
export const ERR_BAD_PACKET = 4100;
export const ERR_INTERNAL = 5000;
let msgSerial = 0;
export function encodeMsg(op, payload) {
    return JSON.stringify({
        v: PROTOCOL_VERSION,
        op,
        id: crypto.randomUUID ? crypto.randomUUID() : String(++msgSerial) + Date.now(),
        ts: Date.now(),
        payload,
    });
}
export function decodeMsg(data) {
    return JSON.parse(data);
}
export function packFrame(streamId, seq, ptsMs, pcm, final = false) {
    const buf = new ArrayBuffer(16 + pcm.byteLength);
    const view = new DataView(buf);
    view.setUint32(0, streamId, true);
    view.setUint32(4, seq, true);
    view.setUint32(8, ptsMs, true);
    view.setUint8(12, final ? FLAG_FINAL : 0);
    new Int16Array(buf, 16).set(pcm);
    return buf;
}
export function unpackFrame(data) {
    const view = new DataView(data);
    return {
        streamId: view.getUint32(0, true),
        seq: view.getUint32(4, true),
        ptsMs: view.getUint32(8, true),
        final: (view.getUint8(12) & FLAG_FINAL) !== 0,
        pcm: new Int16Array(data, 16),
    };
}
//# sourceMappingURL=protocol.js.map