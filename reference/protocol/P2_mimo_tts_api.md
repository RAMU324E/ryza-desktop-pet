# P2-2 MiMo TTS API 调研结论（官方文档 + 官方示例确认）

## 端点（OpenAI 兼容 chat/completions，不是 /audio/speech）
- `POST https://api.xiaomimimo.com/v1/chat/completions`
- 认证：header `api-key: $MIMO_API_KEY`（或 Bearer）
- 模型：
  - `mimo-v2.5-tts`：内置音色 `mimo_default,冰糖,茉莉,苏打,白桦,Mia,Chloe,Milo,Dean`
  - `mimo-v2.5-tts-voiceclone`：`audio.voice` 必传 = 音频样本 base64（mp3/wav）→ **可克隆莱莎游戏语音**
  - `mimo-v2.5-tts-voicedesign`：user 消息传音色文字描述
- 限速 100 RPM，限免免费

## 请求体
```json
{
  "model": "mimo-v2.5-tts",
  "messages": [
    {"role": "user", "content": "<风格指令：语速/情绪/音调>"},
    {"role": "assistant", "content": "<要合成的文本>"}
  ],
  "audio": {"format": "pcm16", "voice": "茉莉"},
  "stream": true
}
```

## 流式响应（SSE）
每个 chunk：`choices[0].delta.audio.data` = **base64 PCM16LE mono 24000Hz** 分片
官方 Python 示例直接 `np.frombuffer(dtype=np.int16)` + `sf.write(samplerate=24000)` 确认。
非流式：`choices[0].message.audio.data`（完整 base64，wav/pcm 均可）。

## 与客户端 audio 事件的映射（P2-1 结论）
MiMo SSE 分片 → 直接转发为客户端 `type:"audio"` 事件：
- `meta: {sample_rate: 24000, channels: 1, sample_format: "int16"}`
- `audio`: 原样 base64（不用解码再编码）
- `chunk_id`/`order`: 递增；最后一片 `is_last: true`
- `synthesis_id`: 一次回复一个 id

## 注意
- 音色以中英文为主，日语文本合成质量未验证 → 优先试 voiceclone（莱莎游戏台词 wav）
- ASR（mimo-v2.5-asr）仅中英，且此前已决定跳过 ASR 改造
- 付费 token plan 用户有备用 base_url：`https://token-plan-cn.xiaomimimo.com/v1`

## 来源
- https://mimo.mi.com/docs/en-US/api/audio/tts
- https://mimo.mi.com/docs/en-US/quick-start/usage-guide/audio/speech-synthesis-v2.5 （官方示例 24kHz PCM16LE）
