# Ryza Desktop Pet

基于 **Spine 4.2.43 + MOKAMOKA + Clonoth + Tauri 2** 的本地莱莎桌宠与聊天应用。当前主线是 Windows 桌面版；浏览器开发入口使用同一套 Spine 前端和 Python sidecar。

> 当前状态基准：2026-08-28。本文是项目现况、架构、资产和开发命令的权威说明；日常操作见 [docs/使用指南.md](docs/使用指南.md)。

## 当前能力

- Windows 透明、无装饰、始终置顶桌宠窗口；主窗口关闭原生 shadow，不显示 Windows 11 的 1 px 白边。
- 顶部橙色短条拖动窗口；托盘提供显示、隐藏、设置和退出。
- 透明空白区使用 Windows 原生点击穿透；角色边界、拖动条、聊天按钮和展开抽屉保留交互。
- 底部聊天抽屉可由右下角按钮展开/收起，托盘始终可恢复窗口。
- 两套 Spine 角色：01 坐姿、99 站姿；坐姿支持普通坐姿和盘腿坐姿。
- 读取官方 `*_gesture.json`，驱动表情、情绪强度、动作组、姿态、视线、点击反应和嘴型。
- Clonoth 负责主对话、持久会话、长期记忆、自动记忆提取/dream、取消和 MCP 工具调用；不可用时自动回退到原 Direct Provider Agent。
- Provider 支持 OpenAI-compatible Chat Completions 与 Responses API；截图可选择独立视觉 Provider。
- 独立低温度表演规划器在主回复完成后编排最多 3 个 `beats`，并强制保持主回复文字逐字不变。
- 可手动调用 Windows 系统截图选区；图片经剪贴板保存后只附加到下一条消息。不会定时、自动或截取应用自身画布。
- 每条消息可附带最近一次非 Ryza 前台进程/窗口标题；可配置一个带 Headers 的 Streamable HTTP 搜索 MCP。
- TTS Profiles 可新增、复制、删除和热切换，支持 MiMo SSE、HTTP WAV、GPT-SoVITS 流式 WAV 和 raw PCM。
- 支持“中文回复 → 中文语音”及“中文回复 → 日语语音”；后者保留中文聊天文本，仅在合成前翻译朗读内容。
- PCM 实时播放、重采样、单声道混合、RMS 连续嘴型擦洗、停止/打断和音量控制。
- 全部运行时前端、Spine Player、角色、场景和触摸音频均随项目/安装包提供，不依赖 CDN；LLM/TTS Provider 仍可能需要网络。

## 快速开始

### Windows 安装版

安装包输出位置：

```text
desktop\src-tauri\target\release\bundle\nsis\Ryza Desktop Pet_0.1.0_x64-setup.exe
```

运行安装包后启动 **Ryza Desktop Pet**。当前构建未签名；若 SmartScreen 拦截，需要确认文件来自本项目构建，再选择“更多信息 → 仍要运行”。

第一次使用建议：

1. 从托盘或聊天抽屉打开“设置”。
2. 填写 LLM 的精确 API URL、Key 和模型名。
3. 保持对话 Agent 为 Clonoth；如需截图识图，填写独立视觉 Provider。
4. 可选配置一个 Streamable HTTP MCP URL 与 Headers。
5. 选择并配置一个 TTS Profile。
6. 分别点击“测试 LLM”和“测试并播放 TTS”，保存后返回聊天。

完整操作、配置和故障排查见 [使用指南](docs/使用指南.md)。

### 浏览器开发版

已创建项目虚拟环境时，可双击：

```text
启动聊天软件.bat
```

或执行：

```powershell
.\.venv\Scripts\python.exe -m ryza_moka
```

然后访问：

```text
http://127.0.0.1:18766/
http://127.0.0.1:18766/settings.html
```

按 `Ctrl+C` 停止。若 18766 端口被安装版占用，请先用托盘“退出”，不能只关闭窗口。

## 系统结构

```text
用户输入
  ↓
spine/chat.js（MOKAMOKA WebSocket 客户端）
  ↓  ws://127.0.0.1:18766/moka
moka_app/ryza_moka（aiohttp 本地 sidecar）
  ├─ RyzaClonothAgentSource → Clonoth 127.0.0.1:18767
  │    ├─ 主对话 / 长期记忆 / MCP / 视觉附件
  │    └─ 失败时回退 Direct Provider
  ├─ 独立表演规划器 → 白名单动作 / 最多 3 段 beats
  ├─ CloudTTSRouter → 当前 TTS Profile
  └─ MOKAMOKA      → 字幕、音频帧和带时间事件
  ↓
Spine 前端
  ├─ app.js          → 模型、场景和多轨动画调度
  ├─ audio-engine.js → PCM 播放、重采样和 RMS
  └─ pcm-worklet.js  → AudioWorklet 播放队列
  ↓
Tauri 2 WebView 主窗口 / 普通设置窗口 / 系统托盘
```

### 运行进程

- `ryza-desktop-pet.exe`：Tauri 桌面壳、两个窗口和托盘。
- `ryza-moka.exe`：PyInstaller 打包的 MOKAMOKA/Python sidecar，只监听 `127.0.0.1:18766`。
- `ryza-clonoth.exe`：PyInstaller onedir runtime；Supervisor 监听 `127.0.0.1:18767`，并派生一个 Engine worker。
- Tauri 依次拉起 Clonoth 与 MOKAMOKA；托盘“退出”用进程树方式终止全部子进程。
- 若对应端口已有可用服务，Tauri 不重复启动。

### 窗口

- `main`：520 × 760，透明、无装饰、无原生 shadow、始终置顶。
- `settings`：1080 × 820，保留系统装饰和普通窗口行为。
- 对任意窗口点关闭都会隐藏窗口；完整退出必须使用托盘“退出”。

## 目录说明

```text
ryza_spine_all\
├─ assets\                     # 环境音、触摸语音、音效、皮肤预览
├─ bridge\                     # 旧 Node Bridge 与首次迁移兼容配置；不是当前桌面运行主链
├─ desktop\                    # Tauri 2 桌面壳、图标和 NSIS 构建
├─ docs\                       # 当前用户文档
├─ moka_app\                   # Ryza Python sidecar、Provider、设置与宿主测试
├─ reference\                  # 抓包、协议与资产研究记录
├─ research\open-source\      # 第三方研究仓库；MOKAMOKA 与固定 Clonoth 是运行/构建依赖
├─ spine\                      # 原生 HTML/CSS/JS 前端、Spine Runtime 和角色/场景
├─ 启动聊天软件.bat            # 浏览器开发入口
├─ package.json                # 根级脚本
└─ README.md                   # 当前权威项目说明
```

`bridge/settings.json` 只用于旧版本兼容和首次迁移。AppData 配置存在后，当前运行时只以 AppData 文件为准。

## 内置资产

### Spine 角色

| 目录 | 姿态 | 当前记录 |
|---|---|---:|
| `spine/crf_chr_002/crf_skn_002_0001_01` | 01 坐姿 | 867 个原始动画；普通坐姿 122 个可用动作组；盘腿 119 个可用动作组 |
| `spine/crf_chr_002/crf_skn_002_0001_99` | 99 站姿 | 164 个原始动画；53 个动作组 |

每套角色包含标准 Spine 4.2 的 `.skel + .atlas + .png`，以及官方私有调度文件 `*_gesture.json`。后者包含 Emotion Profiles、Motion Groups、Tap Reactions、LookAt 骨骼、口型比例和坐姿适用范围等信息，不是 Spine 通用格式。

### 场景、物件和媒体

| 位置 | 数量 | 内容 |
|---|---:|---|
| `spine/scenes` | 200 套 | 50 个场景基底 × `mor/aft/eve/ngt` 四个时段 |
| `spine/objects` | 1 套 | Spine 小物件资源 |
| `assets/audio/ambient` | 74 段 | 环境音 |
| `assets/audio/se` | 1 段 | 通用音效 |
| `assets/audio/tap_voice/jp/normal` | 21 段 | 日语普通触摸语音 |
| `assets/audio/tap_voice/jp/asmr` | 21 段 | 日语 ASMR 触摸语音 |
| `assets/audio/tap_voice/zh-tw/normal` | 21 段 | 繁中普通触摸语音 |
| `assets/audio/tap_voice/zh-tw/asmr` | 21 段 | 繁中 ASMR 触摸语音 |
| `assets/images/skins` | 2 张 | 当前内置皮肤预览 |

场景目录每套包含入口 JSON 及 Spine 三件套。命名后缀：`mor` 早晨、`aft` 白天、`eve` 傍晚、`ngt` 夜晚。

### 外部相关资产

以下资源存在于当前工作机，但不随本项目安装包复制：

| 位置 | 内容 |
|---|---|
| `E:\DL\laisha\ryza_ja_voices` | 莱莎日语语音样本与台词表 |
| `E:\DL\laisha\ryza_skin_previews` | 皮肤 0001–0004 预览图 |
| `E:\DL\laisha\ryza_spine_models.zip` | 精选 Spine 资源打包 |
| `E:\TTS\GPT-SoVITS-V2\HF-Ryza-Cloud\ryza-api` | HF 莱莎云端 API 源码参考 |
| `E:\TTS\GPT-SoVITS-V2\GPT-SoVITS-v2pro` | 本地 GPT-SoVITS API v2 源码/服务 |

模型和音频的使用、修改与分发需遵守各自权利方及 Spine Runtime 的许可要求；本仓库结构本身不授予额外素材许可。

## 配置与安全

当前配置与 Clonoth 状态目录：

```text
%APPDATA%\RyzaPet\settings.json
%APPDATA%\RyzaPet\clonoth\
├─ config\nodes\              # Ryza 对话/视觉节点
└─ data\                      # Provider/MCP、会话、长期记忆、dream、截图附件
```

首次启动时，如果 `settings.json` 不存在且 `bridge/settings.json` 存在，sidecar 会迁移旧配置。保存使用临时文件加原子替换，避免写到一半损坏配置。Clonoth 固定源码模板会按版本同步到独立工作区；应用升级不会清除 `data/` 中的会话和记忆。

配置包含：

```text
llm
├─ name / url / method / apiMode / key
├─ headers / model / extraBody
├─ thinking / reasoningEffort
└─ temperature / maxTokens / responseFormat / timeout

tts
├─ speechMode
├─ activeProfileId
└─ profiles[]
   ├─ id / name / adapter / url / method / key
   ├─ model / voice / instruction
   ├─ headers / bodyTemplate / responseContentType
   └─ format / sampleRate / channels / concurrency / streaming / timeout

character
├─ stance: sitting | standing
└─ sittingPose: normal | agura

performance
├─ mouthSensitivity
├─ mouthAttackMs / mouthReleaseMs
└─ mouthMinHoldMs / mouthMixMs

agent
├─ source: clonoth | direct
├─ vision: enabled / apiMode / url / key / model
└─ mcp: enabled / url / headers

systemPrompt
```

Key 和自定义 Authorization 当前按用户要求**明文保存在本机 JSON/YAML**；Clonoth 会话、记忆、MCP 结果和手动截图附件也保存在本机 AppData。不要上传、提交或粘贴这些文件到日志/文档。`bridge/settings.json` 已被根 `.gitignore` 忽略；AppData 文件不在项目目录内。

## Provider 和表演协议

### 主回复与表演规划

Clonoth 主节点只返回自然语言正文，并把会话、长期记忆、图片和 MCP 工具结果持久化到本地工作区。随后独立低温度规划器返回单个 JSON 对象；运行时会再次校验，保证 `text` 与主回复逐字相同。普通规划使用顶层字段：

```json
{
  "text": "回复文本",
  "emotion": "happy",
  "intensity": "normal",
  "attitude": "agree",
  "stance": "current",
  "sittingPose": "current",
  "action": "准确动作 id 或 none",
  "actionHoldMs": 2600,
  "look": "user"
}
```

明确要求连续表演时可返回最多 3 个 `beats`。每段必须有完整短句，可独立指定 `emotion / intensity / attitude / action / actionHoldMs / look`。动作必须来自客户端发送的当前模型动作目录；未知动作会被丢弃。切换站姿或坐姿时禁止同轮动作 beats，避免旧模型动作落到新模型。

sidecar 把结构化回复转为 MOKAMOKA 标签，例如：

```text
[MOOD:happy.normal][LOOK:user][HOLD:1800][MOTION:group:wave]先挥挥手。
```

MOKAMOKA 再把标签变成与字幕/PCM 时间轴对齐的事件。

### TTS Adapter

| Adapter | 输入/输出 | 典型用途 |
|---|---|---|
| `mimo-sse` | SSE 内 base64 PCM | MiMo TTS |
| `http-wav` | 完整 RIFF/WAV | HF 云端或普通 WAV API |
| `gpt-sovits-stream` | 流式 WAV header + PCM，或非流式 WAV/raw | 本地 GPT-SoVITS API v2 |
| `raw-pcm` | 直接 PCM 响应 | 已知格式的自定义服务 |

WAV parser 会读取实际 `fmt ` 与 `data` chunk；支持 PCM16/Float32、多声道下混和采样率转换。当前不解码 OGG/AAC TTS 响应。

## 开发环境

建议版本：

- Windows 10/11 x64
- Python 3.11
- Node.js 20+
- Rust stable 与 Cargo
- WebView2 Runtime

初始化：

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r moka_app\requirements.txt pyinstaller
npm --prefix desktop install
```

MOKAMOKA 与 Clonoth 通过 `moka_app/requirements.txt` 从本地固定研究仓库安装：

```text
research/open-source/MOKAMOKA/server
research/open-source/Clonoth
```

固定提交：`MOKAMOKA 6bdaf86`、`Clonoth 7f9adbb6dd1ebce9f3664c6c6bcf55d351cb73bd`。两个上游工作区保持 clean；Ryza 定制位于 `moka_app/ryza_moka`、`desktop/clonoth_config` 和构建入口。

### 常用命令

```powershell
# Python 宿主测试
.\.venv\Scripts\python.exe -m pytest moka_app\tests -q

# 前端语法检查
npm run test:web

# Tauri Rust 检查
cargo check --manifest-path desktop\src-tauri\Cargo.toml

# 桌面开发
npm run desktop:dev

# sidecar + NSIS 完整构建
npm run desktop:build
```

完整构建会先生成携带固定上游源码模板的 `desktop/src-tauri/bin/ryza-clonoth/` onedir runtime，再生成 `ryza-moka.exe`，随后由 Tauri 打包前端、`assets/` 和两个 sidecar，最后生成 NSIS。Clonoth 首次启动把源码/节点同步到 `%APPDATA%\RyzaPet\clonoth`；升级代码不会覆盖 `data/` 下的会话和记忆，Provider/MCP/节点则由 `settings.json` 原子同步。

## 跨电脑恢复

大型角色、场景、音频和可选预构建 sidecar 通过 `resource-packs/` 清单单独打包，不进入 Git。完整步骤见 [RESTORE.md](RESTORE.md)：克隆 submodule、下载网盘 ZIP、校验并解压，然后在设置页重新填写 API Key。当前人设随源码保存，聊天记录和长期记忆不会上传。

## 当前验证基线

- Ryza Python 宿主：29 项测试通过，覆盖 Clonoth 配置/截图附件/逐字不变规划、Chat/Responses Direct 与日语翻译契约、配置原子保存与迁移、Provider 适配、WAV/PCM、姿态持久化、最多三段 beats 和 MOKAMOKA 时间事件。
- MOKAMOKA 上游历史基线：server 160 passed / 8 skipped；JS SDK 33 passed，并通过 build/typecheck。
- Spine 运行记录：01 模型 867 个原始动画，普通坐姿 122、盘腿 119 个可用动作组；99 模型 164 个原始动画、53 个动作组。
- Clonoth 可行性与集成：Windows Supervisor+Engine、鉴权 SDK WebSocket 流/最终回复、精准取消、完整重启后记忆召回、stdio/Streamable HTTP MCP、Chat/Responses/视觉契约和 AppData 源码引导版 frozen runtime 均通过；真实 DeepSeek 主回复和独立表演规划已连通。文档和日志不保存凭据。
- Windows 主窗口已在 Tauri Builder 层关闭 undecorated-window shadow，从根因去除原生 1 px 白边；设置窗口不受影响。

每次发布仍应重新执行测试、NSIS 安装、sidecar 健康、媒体读取、托盘退出和透明窗口实机冒烟；历史结果不替代本次构建验证。

## 已知边界

- 当前只发布 Windows x64 NSIS；Android、自动更新和代码签名未实现。
- 没有麦克风/ASR、摄像头、人脸识别、云同步、多用户或插件市场。
- LLM 一轮最多 3 段 beats；姿态切换与动作编排不能在同一轮混用。
- 服装 0002/0003/0004 只有外部预览图，本项目没有对应完整 Spine 模型。
- 环境音和物件资产已归档，但当前聊天主链未把全部资源做成自动场景状态机。
- 本地 GPT-SoVITS 需要用户自行启动服务，并补齐参考音频、提示文本等请求模板字段。
- Provider 与 MCP 的可用性、余额、速率限制和响应延迟由上游决定。Clonoth 主回复和独立规划可能产生两次模型调用；MOKAMOKA 总等待预算按两次 LLM timeout 加 20 秒计算。

## 参考资料

- [日常使用指南](docs/使用指南.md)
- `reference/README.md`：抓包和协议资料索引
- `reference/protocol/`：音频事件、MiMo 协议和资产记录
- `spine/交接文档_Spine前端原型_当前问题.md`：前端历史调试记录，不是当前项目状态文档
- `research/open-source/`：第三方研究仓库；各自 README 和许可证保持原样
