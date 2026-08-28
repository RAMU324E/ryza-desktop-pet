from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator
from typing import Any

import httpx

from .clonoth import ClonothRuntimeClient
from .settings import SettingsStore, llm_extra_body

EMOTIONS = {"neutral", "happy", "laughing", "angry", "sad", "crying", "shy", "tease", "cuddle"}
INTENSITIES = {"weak", "normal", "strong"}
ATTITUDES = {"idle", "agree", "deny", "question"}
STANCES = {"current", "sitting", "standing"}
SITTING_POSES = {"current", "normal", "agura"}


def _json_content(content: Any) -> dict[str, Any]:
    if not isinstance(content, str):
        raise ValueError("LLM 没有返回文本")
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", content.strip(), flags=re.I)
    try:
        value = json.loads(cleaned)
    except json.JSONDecodeError:
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("LLM 没有返回有效 JSON") from None
        value = json.loads(cleaned[start:end + 1])
    if not isinstance(value, dict):
        raise ValueError("LLM 回复必须是 JSON 对象")
    return value


def _fallback_text(content: Any) -> str:
    if not isinstance(content, str):
        return "刚才有点走神了，不过我还在听。"
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", content.strip(), flags=re.I)
    match = re.search(r'"text"\s*:\s*"((?:\\.|[^"\\])*)"', cleaned, flags=re.S)
    if match:
        try:
            return json.loads(f'"{match.group(1)}"')
        except json.JSONDecodeError:
            pass
    if cleaned and not cleaned.startswith(("{", "[")):
        return cleaned[:5000]
    return "刚才有点走神了，不过我还在听。"


def _items(info: dict[str, Any], key: str) -> list[tuple[str, str]]:
    result: list[tuple[str, str]] = []
    for item in info.get(key) or []:
        if isinstance(item, dict):
            name = str(item.get("name") or "")
            label = str(item.get("label") or item.get("displayName") or name)
        else:
            name = label = str(item)
        if name:
            result.append((name, label))
    return result


def _primitive_names(info: dict[str, Any], key: str) -> list[str]:
    primitives = info.get("primitives")
    if not isinstance(primitives, dict):
        return []
    return [name for name, _ in _items({key: primitives.get(key)}, key)]


class RyzaAgentSource:
    def __init__(self, store: SettingsStore, *, transport: httpx.AsyncBaseTransport | None = None):
        self.store = store
        self.transport = transport
        self.model_info: dict[str, Any] = {}
        self.messages: list[dict[str, str]] = []
        self._last_assistant_index: int | None = None
        self._pending_generated = ""

    def set_model_info(self, info: dict[str, Any]) -> None:
        self.model_info = info if isinstance(info, dict) else {}

    def _capability_prompt(self) -> str:
        motions = _items(self.model_info, "motions")
        motion_lines = "\n".join(f"- {name} = {label}" for name, label in motions)
        moods = _primitive_names(self.model_info, "mood") or [
            f"{emotion}.{intensity}" for emotion in sorted(EMOTIONS) for intensity in ("weak", "normal", "strong")
        ]
        poses = _primitive_names(self.model_info, "pose") or sorted(ATTITUDES)
        stances = _primitive_names(self.model_info, "stance") or sorted(STANCES)
        sitting_poses = _primitive_names(self.model_info, "sittingPose") or sorted(SITTING_POSES)
        looks = _primitive_names(self.model_info, "look")
        language_rule = (
            "\n当前为“中文显示 / 日语语音”模式：text 字段必须使用简体中文；不要输出日语，语音层会另行翻译。"
            if self.store.snapshot()["tts"].get("speechMode") == "zh-ja" else ""
        )
        return (
            "你必须只输出一个 JSON 对象，不能附加 Markdown 或解释。格式：\n"
            '{"text":"回复","emotion":"neutral","intensity":"normal","attitude":"idle",'
            '"stance":"current","sittingPose":"current","action":"none","actionHoldMs":2600,"look":"none"}\n'
            f"emotion 只能选：{', '.join(sorted(EMOTIONS))}。\n"
            f"intensity 只能选：{', '.join(sorted(INTENSITIES))}。\n"
            f"attitude 只能选：{', '.join(poses)}。\n"
            f"stance 只能选：{', '.join(stances)}；用户明确要求站起/坐下时才改变，否则 current。\n"
            f"sittingPose 只能选：{', '.join(sitting_poses)}；用户明确要求普通坐姿/盘腿时才改变，否则 current。盘腿时 stance 使用 sitting。切换 stance 或 sittingPose 时 action 必须是 none。\n"
            f"look 只能选：{', '.join(looks) if looks else 'none'}。\n"
            "action 只能是 none 或下列动作的准确 id，不要编造：\n"
            f"{motion_lines or '- 当前没有动作，必须使用 none'}\n"
            f"客户端可用 mood 原语：{', '.join(moods)}。\n"
            "仅当用户明确要求连续表演或回复自然需要多个连续动作时，可增加 beats 数组（最多 3 段）；每段格式为 "
            '{"text":"完整短句","emotion":"neutral","intensity":"normal","attitude":"idle","action":"none","actionHoldMs":2600,"look":"none"}。'
            "每段动作随该段台词开始触发，只能使用当前动作目录；普通回复不要使用 beats。切换 stance/sittingPose 时不得使用 beats。"
            f"{language_rule}"
        )

    def _headers(self, llm: dict[str, Any]) -> dict[str, str]:
        headers = {str(k): str(v) for k, v in json.loads(llm["headers"] or "{}").items()}
        if llm.get("key") and not any(name.lower() == "authorization" for name in headers):
            headers["Authorization"] = f"Bearer {llm['key']}"
        headers.setdefault("Content-Type", "application/json")
        return headers

    async def _call(self, text: str, *, strict: bool = False, include_history: bool = True) -> str:
        settings = self.store.snapshot()
        llm = settings["llm"]
        messages = [
            {"role": "system", "content": settings["systemPrompt"]},
            {"role": "system", "content": self._capability_prompt()},
        ]
        if strict:
            messages.append({"role": "system", "content": "上一次格式无效。这次只能输出可被 JSON.parse 解析的单个 JSON 对象。"})
        if include_history:
            messages.extend(self.messages[-24:])
        messages.append({"role": "user", "content": text})
        temperature = min(0.2, llm["temperature"]) if strict else llm["temperature"]
        extra_body = llm_extra_body(llm)
        gemini_thinking = bool(llm.get("thinking")) and "gemini" in str(llm.get("model") or "").lower()
        responses_api = llm.get("apiMode") == "responses" or llm["url"].rstrip("/").endswith("/responses")
        if responses_api:
            body: dict[str, Any] = {
                "model": llm["model"],
                "instructions": "\n\n".join(message["content"] for message in messages if message["role"] == "system"),
                "input": [message for message in messages if message["role"] != "system"],
                "temperature": temperature,
                "max_output_tokens": llm["maxTokens"],
            }
            if llm.get("responseFormat"):
                body["text"] = {"format": {"type": "json_object"}}
            if llm.get("thinking") and llm.get("reasoningEffort"):
                body["reasoning"] = {"effort": llm["reasoningEffort"]}
        else:
            body = {
                "model": llm["model"],
                "messages": messages,
                "temperature": temperature,
                "max_tokens": llm["maxTokens"],
            }
            if llm.get("responseFormat"):
                body["response_format"] = {"type": "json_object"}
            if not gemini_thinking:
                if llm.get("thinking"):
                    body["thinking"] = {"type": "enabled"}
                    if llm.get("reasoningEffort"):
                        body["reasoning_effort"] = llm["reasoningEffort"]
                else:
                    body["thinking"] = {"type": "disabled"}
        body.update(extra_body)
        async with httpx.AsyncClient(transport=self.transport, timeout=llm["timeout"]) as client:
            response = await client.request(llm["method"], llm["url"], headers=self._headers(llm), json=body)
        if response.is_error:
            raise RuntimeError(f"{llm['name']} HTTP {response.status_code}: {response.text[:300]}")
        try:
            payload = response.json()
        except ValueError:
            raise RuntimeError(f"{llm['name']} 返回的响应不是有效 JSON") from None
        if responses_api:
            content = payload.get("output_text")
            if not isinstance(content, str):
                content = "".join(
                    str(block.get("text") or "")
                    for item in payload.get("output") or [] if isinstance(item, dict) and item.get("type") == "message"
                    for block in item.get("content") or [] if isinstance(block, dict) and block.get("type") == "output_text"
                )
        else:
            content = (payload.get("choices") or [{}])[0].get("message", {}).get("content")
            if isinstance(content, list):
                content = "".join(str(part.get("text") or "") for part in content if isinstance(part, dict))
        return str(content or "")

    def _normalize(self, value: dict[str, Any], fallback: str = "") -> dict[str, Any]:
        text = str(value.get("text") or "").strip() or _fallback_text(fallback)
        emotion = str(value.get("emotion") or "neutral").lower()
        intensity = str(value.get("intensity") or "normal").lower()
        attitude = str(value.get("attitude") or "idle").lower()
        stance = str(value.get("stance") or "current").lower()
        sitting_pose = str(value.get("sittingPose") or "current").lower()
        if emotion not in EMOTIONS:
            emotion = "neutral"
        if intensity not in INTENSITIES:
            intensity = "normal"
        poses = set(_primitive_names(self.model_info, "pose") or ATTITUDES)
        if attitude not in poses:
            attitude = "idle"
        if stance not in STANCES:
            stance = "current"
        if sitting_pose not in SITTING_POSES:
            sitting_pose = "current"
        if sitting_pose != "current":
            stance = "sitting"
        motion_names = {name for name, _ in _items(self.model_info, "motions")}
        action = str(value.get("action") or value.get("motion") or "none")
        if stance != "current" or sitting_pose != "current":
            action = "none"
        if action not in motion_names:
            action = "none"
        look_names = set(_primitive_names(self.model_info, "look"))
        look = str(value.get("look") or "none").lower()
        if look not in look_names:
            look = "none"
        try:
            hold = max(800, min(8000, round(float(value.get("actionHoldMs", 2600)))))
        except (TypeError, ValueError):
            hold = 2600
        reply = {
            "text": text[:5000], "emotion": emotion, "intensity": intensity,
            "attitude": attitude, "stance": stance, "sittingPose": sitting_pose,
            "action": action, "actionHoldMs": hold, "look": look, "beats": [],
        }
        raw_beats = value.get("beats")
        if stance == "current" and sitting_pose == "current" and isinstance(raw_beats, list):
            for item in raw_beats[:3]:
                if not isinstance(item, dict) or not str(item.get("text") or "").strip():
                    continue
                beat = self._normalize({
                    **reply, "attitude": "idle", "action": "none", "look": "none", **item,
                    "stance": "current", "sittingPose": "current", "beats": [],
                })
                reply["beats"].append(beat)
            if reply["beats"]:
                reply["text"] = "".join(beat["text"] for beat in reply["beats"])[:5000]
        return reply

    async def _reply_value(self, text: str, *, include_history: bool = True) -> dict[str, Any]:
        first = await self._call(text, include_history=include_history)
        try:
            return self._normalize(_json_content(first), first)
        except (ValueError, json.JSONDecodeError):
            try:
                retry = await self._call(text, strict=True, include_history=include_history)
                return self._normalize(_json_content(retry), retry)
            except (ValueError, json.JSONDecodeError):
                return self._normalize({}, first)

    def _tagged(self, reply: dict[str, Any]) -> str:
        if reply.get("beats"):
            return "".join(self._tagged(beat) for beat in reply["beats"])
        mood_options = set(_primitive_names(self.model_info, "mood"))
        mood = f"{reply['emotion']}.{reply['intensity']}"
        if mood_options and mood not in mood_options:
            mood = reply["emotion"] if reply["emotion"] in mood_options else next(iter(mood_options))
        tags = []
        if reply["sittingPose"] != "current":
            tags.append(f"[POSE:sitting.{reply['sittingPose']}]")
        elif reply["stance"] != "current":
            tags.append(f"[POSE:stance.{reply['stance']}]")
        tags.append(f"[MOOD:{mood}]")
        if reply["attitude"] != "idle":
            tags.append(f"[POSE:{reply['attitude']}]")
        if reply["look"] != "none":
            tags.append(f"[LOOK:{reply['look']}]")
        if reply["action"] != "none":
            holds = _primitive_names(self.model_info, "hold")
            hold = str(reply["actionHoldMs"])
            if holds:
                numeric = [item for item in holds if item.isdigit()]
                if numeric:
                    hold = min(numeric, key=lambda item: abs(int(item) - reply["actionHoldMs"]))
                if hold in holds:
                    tags.append(f"[HOLD:{hold}]")
            tags.append(f"[MOTION:{reply['action']}]")
        return "".join(tags) + reply["text"]

    async def reply(self, text: str) -> AsyncIterator[str]:
        self._last_assistant_index = None
        reply = await self._reply_value(text)
        self.messages.append({"role": "user", "content": text})
        self.messages[:] = self.messages[-24:]
        self._pending_generated = reply["text"]
        tagged = self._tagged(reply)
        yield tagged
        self.messages.append({"role": "assistant", "content": reply["text"]})
        self._last_assistant_index = len(self.messages) - 1
        self._pending_generated = ""

    async def interrupt(self, heard_text: str) -> None:
        heard = heard_text.strip()
        if self._last_assistant_index is not None and self._last_assistant_index < len(self.messages):
            self.messages[self._last_assistant_index]["content"] = heard or "（回复被打断）"
        elif heard:
            self.messages.append({"role": "assistant", "content": f"{heard}…（说到这里被打断）"})
        self._pending_generated = ""

    async def context(self, text: str) -> None:
        self.messages.append({"role": "user", "content": f"（环境信息，无需直接回复）{text}"})
        self.messages[:] = self.messages[-24:]

    async def test(self, _payload: dict[str, Any] | None = None) -> dict[str, Any]:
        reply = await self._reply_value("请只回复：连接测试成功。", include_history=False)
        return {"text": reply["text"], "performance": reply}


class RyzaClonothAgentSource:
    """Clonoth-backed conversation with the existing direct agent as fallback."""

    def __init__(self, store: SettingsStore, *, transport: httpx.AsyncBaseTransport | None = None):
        self.store = store
        self.clonoth = ClonothRuntimeClient(store)
        self.direct = RyzaAgentSource(store, transport=transport)
        self.planner = RyzaAgentSource(store, transport=transport)
        self.model_info: dict[str, Any] = {}

    def set_model_info(self, info: dict[str, Any]) -> None:
        self.model_info = info if isinstance(info, dict) else {}
        self.direct.set_model_info(self.model_info)
        self.planner.set_model_info(self.model_info)

    async def _performance(self, exact_text: str) -> dict[str, Any]:
        instruction = (
            "为下面已经定稿的回复规划表情、姿态和动作。不得改写、增删或翻译回复文字。"
            "text 必须逐字等于原文；如使用 beats，最多三段，按原文顺序切分且拼接后必须逐字等于原文。\n"
            f"原文：{json.dumps(exact_text, ensure_ascii=False)}"
        )
        try:
            planned = await self.planner._reply_value(instruction, include_history=False)
        except Exception:
            planned = self.planner._normalize({"text": exact_text})
        beats = planned.get("beats") if isinstance(planned.get("beats"), list) else []
        if beats and "".join(str(beat.get("text") or "") for beat in beats) != exact_text:
            beats = []
        planned["beats"] = beats
        planned["text"] = exact_text
        return planned

    @staticmethod
    def _without_image_marker(text: str) -> str:
        return re.sub(r"^\[\[RYZA_IMAGE:.+?\]\]\n?", "", text, count=1, flags=re.S).lstrip()

    async def reply(self, text: str) -> AsyncIterator[str]:
        source = self.store.snapshot().get("agent", {}).get("source", "clonoth")
        if source == "direct":
            async for chunk in self.direct.reply(self._without_image_marker(text)):
                yield chunk
            return
        try:
            exact_text = await self.clonoth.reply(text)
        except Exception:
            async for chunk in self.direct.reply(self._without_image_marker(text)):
                yield chunk
            return
        performance = await self._performance(exact_text)
        yield self.planner._tagged(performance)

    async def interrupt(self, heard_text: str) -> None:
        await self.clonoth.interrupt()
        await self.direct.interrupt(heard_text)

    async def context(self, text: str) -> None:
        await self.direct.context(text)

    async def test(self, _payload: dict[str, Any] | None = None) -> dict[str, Any]:
        source = self.store.snapshot().get("agent", {}).get("source", "clonoth")
        if source == "direct":
            return await self.direct.test(_payload)
        exact_text = await self.clonoth.reply("请只回复：连接测试成功。")
        performance = await self._performance(exact_text)
        return {"text": exact_text, "performance": performance, "source": "clonoth"}
