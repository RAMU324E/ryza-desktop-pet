# Spine 前端原型交接文档（当前状态与已知问题）

> 更新时间：2026-08-25
> 项目目录：`E:\DL\laisha\ryza_spine_all\spine`
> 目标需求：参见上级目录 `E:\DL\laisha\ryza_spine_all\需求文档_Spine角色调度系统.md`

## 1. 先说结论

当前网页只能算**资源浏览与调度实验原型**，不能作为正确的角色调度实现继续堆功能。

用户确认仍有两个关键错误：

1. 默认状态嘴巴张开，不符合预期。
2. 从 Spine 动画列表选择大量眼部、嘴部、面部动画时，看起来不生效。

此前的截图和像素差测试只能证明“画面发生过变化”，**不能证明表情语义和调度逻辑正确**。接手者应以用户实际观察为准。

---

## 2. 启动方式

双击：

```text
E:\DL\laisha\ryza_spine_all\spine\启动控制台.bat
```

访问：

```text
http://127.0.0.1:18765/
```

说明：

- 启动脚本使用本机 Python `http.server`。
- 必须保持命令行窗口开启，`Ctrl+C` 停止。
- 原端口 8080 已被本机 `mitmdump` 占用，所以改为 18765。
- Spine Runtime 从 UNPKG CDN 加载，需要联网：`@esotericsoftware/spine-player@4.2.119`。

---

## 3. 现有文件

| 文件 | 作用 |
|---|---|
| `index.html` | 控制台页面结构 |
| `style.css` | 页面视觉样式 |
| `assets.js` | 2 个角色、200 个场景的静态资源清单 |
| `app.js` | Spine Player 初始化、场景切换、当前实验性表情调度 |
| `启动控制台.bat` | 本地 HTTP 服务启动脚本 |

未修改任何原始 `.skel`、`.atlas`、`.png`、`*_gesture.json` 文件。

---

## 4. 资源情况

### 角色 01：坐姿

```text
crf_chr_002\crf_skn_002_0001_01\
```

- Spine 导出版本：`4.2.43`
- 动画数量：约 867
- Gesture 配置：约 2.3 MB
- 默认身体动画：`motion_A_001_idle`

### 角色 99：站姿

```text
crf_chr_002\crf_skn_002_0001_99\
```

- Spine 导出版本：`4.2.43`
- 动画数量：约 164
- Gesture 配置：约 816 KB

两份 gesture 配置都包含：

```text
EmotionProfilesV4:
angry / crying / cuddle / happy / laughing / neutral / sad / shy / tease

Intensity:
weak / normal / strong
```

---

## 5. 当前 `app.js` 的调度实验

关键位置（后续编辑后行号可能变化）：

| 位置 | 当前作用 |
|---|---|
| `app.js:49` | 轨道定义 |
| `app.js:55` | 强制隐藏的面部槽位 |
| `app.js:105` | `setExpressionTrack()` |
| `app.js:128` | `setFacialFx()` |
| `app.js:188` | `applyExpression()` |
| `app.js:217` | `setupExpressionControls()` |
| `app.js:242` | `loadCharacter()` |
| `app.js:276` | 每帧面部兼容处理 |

当前轨道划分：

```js
body: 0,
eye: 1,
eyebrow: 2,
mouth: 3,
fx: 4
```

当前会加载：

```text
*_gesture.json
  -> emotionalGesture
  -> EmotionProfilesV4
  -> intensityProfiles
  -> expressionSets
```

然后将：

```text
eyeOpen -> Track 1
eyebrow -> Track 2
mouth -> Track 3
effectSets -> Track 4
```

这是为了向需求文档的 M2/M3 分层靠拢，但目前行为不正确。

---

## 6. 为什么“大量眼/嘴动画不生效”

### 原因 A：高轨道会覆盖 Spine Player 控制条的 Track 0

官方 Spine Player 底部动画列表调用的是基础动画轨道。网页同时在 Track 1–4 常驻眼睛、眉毛、嘴巴和 FX。

因此用户在底部列表中选择：

```text
facial_eye_*
facial_eyebrow_*
facial_mouth_*
facial_add_*
```

即使动画在 Track 0 播放，也可能被更高的 Track 1–4 覆盖，所以看起来“没反应”。

**接手建议：**

- 不要再让官方 Player 的完整动画列表充当总控制器。
- 底部列表应只保留 L0 身体/姿态动画；或者彻底隐藏官方控制条。
- 眼、眉、嘴、FX 必须通过自己的轨道控件或调度指令驱动。

### 原因 B：`active -> idle` 的真实语义还没有确认

当前 `setExpressionTrack()` 会尝试：

```text
facial_xxx_active（一次）
    -> facial_xxx_idle（循环）
```

资源是否要求：

- active 播完再进入 idle；
- active 与 idle 混合；
- active 只负责切换附件；
- idle 只负责眨眼/微动；
- 由事件或专用调度器控制退出；

目前没有完全确认。

不能仅凭动画名字推断。

### 原因 C：ExpressionSet 是组合池，不是单个“完整表情动画”

Gesture JSON 中一个 ExpressionSet 由多个局部动画组成：

```json
{
  "eyeOpen": "facial_eye_005",
  "eyeClosed": "facial_eye_002_idle",
  "eyebrow": "facial_eyebrow_001_idle",
  "mouth": "facial_mouth_002"
}
```

需要同时处理：

- 眼睛 open/closed 与眨眼；
- 眉毛；
- 嘴型；
- FX；
- 重抽间隔；
- 当前情绪和强度；
- 轨道互斥与过渡。

现在只完成了最小组合，没有完成完整状态机。

---

## 7. 默认嘴巴张开的重点问题

需求文档 M5 明确写了：

```text
无音频时嘴型回归 idle 嘴型（facial_mouth_009_idle）
```

当前代码却从 neutral ExpressionSet 中选择 mouth，首组通常是：

```text
facial_mouth_001
```

并尝试播放：

```text
facial_mouth_001_active
-> facial_mouth_001_idle
```

这很可能就是默认张嘴的直接原因。

**建议优先改成：**

1. 无音频、无说话状态时，Track 3 固定回落到：

   ```text
   facial_mouth_009_idle
   ```

2. Emotion ExpressionSet 的 `mouth` 只能作为表情偏置或候选，不应无条件替代“闭嘴 idle”。
3. 说话时才由 LipSync/Mouth Track 接管嘴型。
4. 说话结束后清理 Track 3，再回到 `facial_mouth_009_idle`。

修改前必须实际确认 `facial_mouth_009_idle` 在两个模型中的视觉和持续时间。

---

## 8. 白块问题与当前危险补丁

原 PNG 为普通 Alpha，不是预乘 Alpha。像素分析显示大量半透明边缘 RGB 大于 Alpha，所以播放器已经改为：

```js
premultipliedAlpha: false
```

这个修改应保留。

但为了消除面颊/鼻子白块，当前代码还会每帧卸载以下附件：

```text
019_face_eyehilight_L
020_face_eyehilight_R
027_face_eyewhite_L
028_face_eyewhite_R
032_face_nose_hi
```

部分状态还会卸载：

```text
037_face_cheek_line
038_face_cheek
```

这会直接破坏：

- 眼白；
- 眼部高光；
- 鼻子高光；
- 脸红/脸颊效果；
- 部分依赖这些附件的表情。

所以“白块消失”和“表情不生效”目前是同一补丁的两面。

**不要继续扩大隐藏名单。**

正确方向应是查清：

- 原项目是否使用自定义 shader/合成层；
- clipping 附件与结束槽位是否正确；
- 眼球/眼白控制骨骼是否需要 LookAt 驱动才能进入正确位置；
- `control_aim_eye/head/body` 的 setup 值是否需要初始化；
- 是否需要应用 gesture 中的驱动轴、脸部 active 初始化和 FX off 动画；
- 原运行时是否有额外的灯光/rim/face compositing 逻辑。

---

## 9. 建议接手顺序

### 第一步：保留一个干净基线

建立分支或备份，然后先移除：

- `alwaysHiddenFacialSlots`；
- `cheekSlots`；
- `update(player)` 中每帧 `setAttachment(null)`；
- 自动表情调度。

只保留：

```text
模型加载
premultipliedAlpha: false
motion_A_001_idle
```

记录干净基线的所有异常。

### 第二步：使用低层 Runtime，不要继续依赖 SpinePlayer 控制条

建议从：

```text
@esotericsoftware/spine-webgl 4.2.x
```

直接管理：

- `Skeleton`；
- `AnimationStateData`；
- `AnimationState`；
- `SceneRenderer`；
- 每条 Track 的生命周期。

`SpinePlayer` 适合播放器演示，不适合需求文档中的完整调度器。

### 第三步：逐组件验证

每次只验证一个组件：

1. 仅身体 `motion_A_001_idle`。
2. 仅眉毛轨道。
3. 仅嘴型轨道，先确认闭嘴 idle。
4. 仅眼部 active/idle。
5. 加眨眼状态机。
6. 再加 cheek/tear/pale/sweat FX。
7. 最后做情绪 ExpressionSet 组合。

每一步都保存截图或短视频，不要只做像素差。

### 第四步：建立可观察性

调试 UI 至少显示：

```text
Track 0 当前动画 / time / alpha / mix
Track 1 当前动画
Track 2 当前动画
Track 3 当前动画
Track 4 当前动画
当前 ExpressionSet ID
当前 effect ID
当前可见附件
```

否则无法判断“动画没播”还是“被高轨覆盖”。

### 第五步：再实现需求文档中的调度器

按需求文档继续：

- L0 idle；
- L1 情绪姿态；
- L2 additive；
- L3 oneshot；
- 眼/眉/嘴/FX 子轨；
- blink；
- LookAt；
- LipSync；
- 点击反应；
- JSON/WebSocket 指令接口。

---

## 10. 最小验收用例

接手者先完成以下 6 条，再继续扩展：

1. 页面加载后嘴巴闭合。
2. 播放 `facial_mouth_XXX` 时嘴型明显变化，结束后回到闭嘴。
3. 播放 `facial_eye_XXX` 时眼睛明显变化，不被其他轨道覆盖。
4. 切换 neutral/happy/sad 时身体 idle 不停，脸部组合变化正确。
5. 中性状态没有面颊/鼻子白块。
6. 角色 01 和 99 均通过以上测试。

---

## 11. 已做过但不能当成正确性证明的测试

此前做过：

- Spine/scene/PNG/atlas/skel HTTP 200 检查；
- JavaScript 语法检查；
- 两套模型加载检查；
- 9 种情绪截图；
- 面部区域像素差统计；
- gesture JSON 配置解析；
- active/idle 动画存在性检查。

这些测试证明资源能加载、代码能执行，但**没有证明调度语义正确**。

---

## 12. 当前不要做的事

- 不要继续用更多 `setAttachment(null)` 掩盖问题。
- 不要把“截图有变化”当成表情正确。
- 不要让 Track 1–4 常驻动画覆盖用户在 Track 0 上测试的 facial 动画。
- 不要修改原始 gesture JSON。
- 不要在没确认默认闭嘴动画前继续做 LipSync。

---

## 13. 推荐的第一个修复提交

建议第一个提交只做：

```text
fix(face): restore track observability and closed-mouth baseline
```

范围：

1. 隐藏或过滤官方 Player 的 facial 动画下拉项，避免与调度轨冲突。
2. 默认 Track 3 使用 `facial_mouth_009_idle`。
3. 添加 Track 0–4 当前动画调试显示。
4. 临时关闭自动 ExpressionSet 随机选择。
5. 移除每帧强制隐藏附件，重新定位白块根因。

完成这一步后再继续 EmotionProfilesV4。

---

## 14. 变更记录：2026-08-25 第一个修复提交已完成

`fix(face): restore track observability and closed-mouth baseline`（即 §13 全部 5 项），改动仅限 `app.js` / `index.html` / `style.css`：

1. **已移除每帧附件隐藏补丁**：`alwaysHiddenFacialSlots`、`cheekSlots`、`hideCheekFx` 与 `update()` 中的 `setAttachment(null)` 全部删除；`premultipliedAlpha: false` 保留。**白块预计会重新出现**，这是有意还原的干净基线，根因排查见 §8。
2. **官方控制条已过滤**：加载成功后将 `player.config.animations` 设为所有非 `facial_` 前缀动画，底部列表只剩 L0 身体/姿态动画。
3. **默认闭嘴基线**：加载后 Track 3 固定播放默认嘴型，候选顺序 `facial_mouth_009_idle` → `facial_mouth_001_idle`。**已核实：模型 01 有 009；模型 99 嘴型只到 008，会回退到 001_idle，其视觉是否闭嘴待用户目视确认**（调试面板会显示实际使用的动画名）。
4. **自动表情调度已关闭**：加载后不再自动 `applyExpression()`，Track 1/2/4 保持空；“最远距离”随机选择逻辑已删除，“换一组表情”改为顺序循环；新增“表情接管嘴型”开关（默认关，ExpressionSet 的 mouth 不再无条件替代闭嘴 idle）与“清除表情（回基线）”按钮；清轨改用 `setEmptyAnimation(track, 0.2)` 避免残留姿势。
5. **调试面板**：视口左上角实时显示 Track 0–4 当前动画名与 trackTime、当前表情组 E/B/M 编号、当前 FX id、默认嘴型动画名。

已做验证：`node --check app.js` 通过；页面/脚本/gesture/skel/atlas 均 HTTP 200。

### 待用户目视验收（对应 §10）

- 页面加载后是否闭嘴（模型 01 看 009_idle，模型 99 看 001_idle 回退效果）；
- 手动应用表情时眼/眉变化是否可见、调试面板轨道状态是否对得上；
- 白块在哪些状态下重新出现（用于 §8 根因定位，不要再用隐藏附件掩盖）。

### 遗留事项

- 白块根因未查（§8 方向：clipping/LookAt 骨骼初始化/FX off 初始化/合成层）；
- `active -> idle` 语义仍未确认（§6-B）；
- 长期方向仍应迁移到 `@esotericsoftware/spine-webgl` 自管 AnimationState（§9 第二步）；
- `player.config.animations` 是对播放器内部配置的运行时修改，升级 spine-player 版本时需回验下拉过滤是否仍生效。

---

## 15. 变更记录：2026-08-25 白块根因与可读动作列表

本节**覆盖 §14 中 `premultipliedAlpha: false` 与 `player.config.animations` 过滤方案**。

### 白块根因与修复

已使用 Spine 4.2 Runtime 直接解析 `.skel` 并检查原 PNG：

- `037_face_cheek_line`、`032_face_nose_hi` 的 Slot BlendMode 为 `Multiply`；
- 原 PNG 是直通 Alpha，透明像素存在 `RGB > Alpha`；
- Spine WebGL 的 Multiply 混合会直接使用源 RGB，导致透明边缘被叠亮为脸颊/鼻子白块；
- `facial_add_blush_000_off` 只会令 `038_face_cheek` 附件为空，不能关闭 `032_face_nose_hi`，因此播放 FX off 不是根治方式。

现已保留原资源不动，并为两个角色生成派生资源：

```text
crf_skn_002_0001_01_pma.png / _pma.atlas
crf_skn_002_0001_99_pma.png / _pma.atlas
```

派生 PNG 执行 `RGB = RGB × Alpha`；角色播放器改用 `_pma.atlas` 且设 `premultipliedAlpha: true`。两个派生 PNG 均验证 `RGB > Alpha` 像素数为 0。场景仍使用原 atlas 与 `premultipliedAlpha: false`。

不要恢复任何 `setAttachment(null)` 隐藏补丁。

### 动作列表改造

官方 Player 的 Animations 按钮已隐藏（播放/暂停、进度、速度等控制仍保留），不再显示顶部被裁切的几百条内部剪辑名。

右侧新增“动作测试”：

1. **基础 / 一次性动作**：只列可独立播放的待机、oneshot 和 touch 动作；隐藏 `in/out/up/down` 内部过渡片段；按“待机动作 / 一次性动作 / 点击反应”中文分组。
2. **叠加动作组**：直接读取 gesture JSON 的 `MotionGroups`、`Label`、`AnimName_1/2`、`Alpha1/2`、`Speed1/2`，在 Track 5/6 叠加播放；常见日文标签用轻量替换规则显示成中文，例如转肩、双手交叠、抱臂、双腿晃动、挥手等。
3. **表情部件测试**：眼睛、眉毛、嘴型和脸部 FX 分开列出；名称格式为“部件 + 编号 + 原始代码”，不再要求从 motion 列表猜哪些是表情。
4. Track 调试浮层扩展到 Track 0–6。

资源没有提供每个眼睛/眉毛编号的具体视觉语义名称；本次不凭动画名猜“微笑眼/生气眉”。待用户目视确认常用编号后，再补少量中文别名即可，不维护另一份完整动作数据库。

### 验证

- `node --check app.js` 通过；
- `app.js` 引用的 39 个 UI id 全部存在；
- 两个 `_pma.atlas` 首行均正确指向各自 `_pma.png`；
- 页面、脚本、样式与两个角色的 PMA atlas/png 均 HTTP 200；
- 诊断用临时 `spine/tools` 已删除。

---

## 16. 变更记录：2026-08-26 LLM + TTS 初版闭环

### 新增文件

```text
bridge/server.mjs
bridge/character-prompt.md
bridge/.env.example
bridge/.env                 # 本机测试 Key，已 gitignore
spine/chat.js
spine/audio-engine.js
spine/pcm-worklet.js
启动聊天软件.bat
.gitignore
```

### 已实现

- Node 22 标准库本地 Bridge，同时提供静态网页与 `POST /api/chat`；
- DeepSeek `deepseek-v4-flash` 返回严格 JSON：`text/emotion/intensity/attitude/tension`；
- 非法表演枚举回退到安全默认值；
- MiMo `mimo-v2.5-tts` + `冰糖` SSE 音频转为 NDJSON `audio.start/chunk/end`；
- 聊天消息、本地历史、发送、停止、清空、TTS 开关和音量；
- `window.RYZA_SPINE_API`：应用 emotion/intensity、嘴型开合、恢复闭嘴；
- AudioWorklet PCM 队列、PCM16/Float32 解码、单声道混合和线性重采样；
- Worklet RMS 回传，约 25 Hz 驱动 `facial_mouth_001～008_idle`；音频结束/停止恢复默认闭嘴；
- API Key 仅位于 `bridge/.env`，不进入静态前端与示例配置。

### 真实接口验证

- DeepSeek 结构化 JSON 调用成功；
- MiMo 冰糖流式 TTS 调用成功；
- Bridge 无 TTS：`turn.start → reply → turn.end`；
- Bridge 开启 TTS：收到 7 个有效 PCM 分片、完整 `audio.start/chunk/end`，无 error 事件；
- 页面、新增 JS 与 Worklet 均 HTTP 200；所有 JS 通过 `node --check`。

### 当前边界

- `attitude/tension` 已生成并传到前端，但 agree/deny/question 的正式 oneshot 生命周期尚未接入；
- 嘴型当前按 RMS 量化到 001～008，需用户试听后确认视觉顺序与灵敏度；
- 尚未接入触摸语音、环境音、Electron、AstrBot/Pi 等 harness；
- 聊天版固定使用 18766，旧 Python 静态预览可继续使用 18765。

---

## 17. 变更记录：2026-08-26 设置页、LLM 动作与嘴型修复

### 设置页

新增：

```text
spine/settings.html
spine/settings.js
bridge/settings.json
```

聊天页右上角齿轮进入设置。设置页通过 `GET/POST /api/settings` 直接读取和明文保存：

- LLM URL、完整 Key、模型；
- 推理开关、low/medium/high、temperature、max tokens；
- TTS URL、完整 Key、模型、声线；
- 嘴型灵敏度；
- 完整系统提示词。

保存后 Bridge 内存配置立即更新；下一条消息生效。URL 可填 base URL，也可填完整 `/chat/completions` URL。

### LLM 连续聊天容错

DeepSeek 默认改为 `thinking=enabled`、`reasoning_effort=low`。

非 JSON 时自动严格低温重试一次；重试仍失败时提取纯文本，并回退 `neutral/normal/idle/0.5/none`，不再因格式错误中断聊天。Mock 已验证两次非 JSON 响应产生正常 reply，无 error。

### LLM 身体动作

结构化回复新增：

```text
action: none | group:N
actionHoldMs: 800～8000
```

当前模型的可用 MotionGroups 由前端动态发送给 Bridge，LLM 只能选择目录内 id：

- 01 模型：133 个可用动作组；
- 99 模型：53 个可用动作组；
- 资源标签中明确“使わない/不使用”的 7 项已过滤。

`action` 在 Track 5/6 播放，到时淡出；`attitude=agree/deny/question` 从当前 EmotionProfile 的 fixedGestureBindings 中选有效 oneshot，在 Track 7 播放并自动清理。新回复/停止会清理旧动作。

### 闭嘴说话修复

闭嘴说话属于本地嘴型链路，不是 LLM 智力问题。修复包括：

- 嘴型从只播放 `_idle` 改为 `_active → _idle`；
- MiMo PCM 实测：2.08 秒、6 分片、P50 `-20.2dB`、P90 `-13.1dB`；
- 默认灵敏度提高到 1.6，可在设置页调整 0.25～4；
- 聊天状态实时显示嘴型档位和开合值；
- 音频 end/stop/drained 均恢复默认闭嘴。

真实 Chrome + Spine Runtime 验证：

```text
01: Track 5 = motion_add_B_009_active
01: Track 7 = motion_oneshot_D_002_active
01: 嘴型 0.8 → facial_mouth_007_active
01: actionHoldMs 到时 Track 5/6 = 空
99: 动作目录 53 项；嘴型 0.7 → level 6
```

### 其他

- `WEBGL · LIVE` 已默认隐藏；
- 聊天状态显示 emotion / attitude / action；
- 网络流结束但音频仍播放时，停止按钮保持可用；
- 当前 DeepSeek 测试 Key 在进一步多轮测试时返回 HTTP 402 `Insufficient Balance`。设置页已可直接更换 Key；MiMo 冰糖仍正常。
