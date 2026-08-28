# 已整理资产

```text
reference/
├─ protocol/       协议与 TTS 文档
└─ fixtures/       WebSocket 演出抓包

assets/
├─ audio/
│  ├─ tap_voice/   触摸语音
│  ├─ ambient/     环境音
│  └─ se/          触摸音效
└─ images/skins/   现有角色预览图
```

## 数量

| 内容 | 数量 |
|---|---:|
| 协议与资产文档 | 3 |
| WebSocket 演出抓包 | 1 |
| 日语普通触摸语音 | 21 |
| 日语 ASMR 触摸语音 | 21 |
| 繁中普通触摸语音 | 21 |
| 繁中 ASMR 触摸语音 | 21 |
| 环境音 | 74 |
| 触摸音效 | 1 |
| 01/99 角色预览图 | 2 |
| **合计（不含本 README）** | **165** |

## 后续接入顺序

1. 结构化 LLM 回复：`text + emotion + intensity + attitude + tension`。
2. 流式 TTS：SSE PCM → AudioWorklet。
3. PCM RMS → Spine 嘴型，播放结束恢复默认闭嘴。
4. 点击角色 → touch 动作 + 触摸音效 + 对应触摸语音。
5. 场景环境音与 TTS 音量压低。
