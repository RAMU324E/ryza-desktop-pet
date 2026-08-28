# P2-1 客户端 audio 事件格式（逆向自 blutter asm）

## WS 事件分发
`event.response` 的 `events[]` 里 `type: "audio"` → `YorisoiWebsocketTalk::_handleAudioMessage` (0x654d98)
→ `MarionetteAudio::enqueueChunk` (0x6558b8) 流式入队播放。

## audio 事件字段（enqueueChunk 读取）
| 字段 | 类型 | 说明 |
|---|---|---|
| `meta.sample_rate` | int | 采样率 |
| `meta.channels` | int | 声道数（fallback: `num_channels`, `channel_count`）|
| `meta.sample_format` | "int16" / "float32" | PCM 格式 |
| `synthesis_id` | String? | 缺省 "default"，同一次合成共用 |
| `chunk_id` | num? | 分片序号 |
| `order` | int? | 播放顺序 |
| `is_last` | bool | 最后一片标记 |
| `exp_delay` | num? | 预期延迟 |
| `audio` | **String (base64)** | PCM 分片数据，`_decodePcmToInt16` → base64Decode |
| `total_audio_seconds` | num? | 总时长（isComplete 统计）|
| lipsync 包络 | Map<int, Int16List/Float64List>? | 可选，缺省 `_emptyLipsyncEnvelope` |

## 相关辅助字段
- `audioReadySlots` / `audioCompletedSlots`：List<int> 槽位同步
- `degraded`（bool）：TTS 降级标记（文本模式，见 "talk.ttsDegradedTextMode"）
- `text`：caption 同步用

## 后端推音频的要点
1. LLM 文本 → TTS → PCM16 (如 24kHz mono) → 按 chunk base64 推 `type:"audio"` 事件
2. 每片带递增 `chunk_id`/`order`，最后一片 `is_last: true`
3. lipsync 可选——不给就走空包络（模型可能不动嘴，P2 再研究 gesture/tension 联动）
4. actorder 与 segment 对齐

## 证据
- pp.txt 0x2de78–0x2df88 字符串簇
- audio.dart L1565 `_decodePcmToInt16` → `base64Decode`（dart:convert）
- websocket_talk.dart L10772 `_handleAudioMessage`（读 synthesis_id/actorder/is_last/degraded）
