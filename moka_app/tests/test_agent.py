from __future__ import annotations

import json
from pathlib import Path

import httpx

from ryza_moka.agent import RyzaAgentSource
from ryza_moka.settings import SettingsStore


async def test_agent_turns_structured_reply_into_moka_tags(tmp_path: Path) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["model"] == "test-model"
        assert any("group:1" in message["content"] for message in body["messages"] if message["role"] == "system")
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({
            "text": "欢迎回来！", "emotion": "happy", "intensity": "strong",
            "attitude": "agree", "action": "group:1", "actionHoldMs": 2500, "look": "user"
        }, ensure_ascii=False)}}]})

    store = SettingsStore(tmp_path / "settings.json")
    value = store.snapshot()
    value["llm"].update({"url": "https://llm.test/chat/completions", "model": "test-model"})
    store.update(value)
    agent = RyzaAgentSource(store, transport=httpx.MockTransport(handler))
    agent.set_model_info({
        "name": "test", "motions": [{"name": "group:1", "label": "挥手"}],
        "primitives": {
            "mood": ["neutral.normal", "happy.strong"],
            "pose": ["idle", "agree"], "look": ["user"], "hold": ["2400", "2800"]
        },
    })

    chunks = [chunk async for chunk in agent.reply("你好")]

    assert chunks == ["[MOOD:happy.strong][POSE:agree][LOOK:user][HOLD:2400][MOTION:group:1]欢迎回来！"]
    assert agent.messages[-1] == {"role": "assistant", "content": "欢迎回来！"}


async def test_agent_uses_custom_gemini_thinking_without_generic_fields(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["generationConfig"]["thinkingConfig"]["thinkingLevel"] == "MEDIUM"
        assert "thinking" not in body
        assert "reasoning_effort" not in body
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({
            "text": "推理已开启。", "emotion": "neutral"
        }, ensure_ascii=False)}}]})

    store = SettingsStore(tmp_path / "settings.json")
    value = store.snapshot()
    value["llm"].update({
        "url": "https://llm.test/chat/completions",
        "model": "gemini-3.7-flash",
        "thinking": True,
        "reasoningEffort": "medium",
        "extraBody": "{}",
    })
    store.update(value)
    agent = RyzaAgentSource(store, transport=httpx.MockTransport(handler))
    agent.set_model_info({"primitives": {"mood": ["neutral.normal"]}})

    result = [chunk async for chunk in agent.reply("测试")]

    assert result == ["[MOOD:neutral.normal]推理已开启。"]


async def test_agent_drops_unknown_motion(tmp_path: Path) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({
            "text": "好的。", "emotion": "bad", "action": "invented"
        }, ensure_ascii=False)}}]})

    store = SettingsStore(tmp_path / "settings.json")
    value = store.snapshot()
    value["llm"]["url"] = "https://llm.test/chat/completions"
    store.update(value)
    agent = RyzaAgentSource(store, transport=httpx.MockTransport(handler))
    agent.set_model_info({"motions": ["group:1"], "primitives": {"mood": ["neutral.normal"]}})

    result = [chunk async for chunk in agent.reply("继续")]

    assert result == ["[MOOD:neutral.normal]好的。"]


def test_japanese_speech_mode_still_requires_chinese_agent_text(tmp_path: Path) -> None:
    store = SettingsStore(tmp_path / "settings.json")
    value = store.snapshot()
    value["tts"]["speechMode"] = "zh-ja"
    store.update(value)

    prompt = RyzaAgentSource(store)._capability_prompt()

    assert "text 字段必须使用简体中文" in prompt
    assert "语音层会另行翻译" in prompt


async def test_agent_can_switch_to_cross_legged_sitting(tmp_path: Path) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({
            "text": "好呀，这样坐舒服多了。", "emotion": "happy", "intensity": "normal",
            "stance": "current", "sittingPose": "agura",
            "beats": [{"text": "不应执行旧姿态动作。", "action": "group:1"}],
        }, ensure_ascii=False)}}]})

    store = SettingsStore(tmp_path / "settings.json")
    value = store.snapshot()
    value["llm"]["url"] = "https://llm.test/chat/completions"
    store.update(value)
    agent = RyzaAgentSource(store, transport=httpx.MockTransport(handler))
    agent.set_model_info({
        "primitives": {
            "mood": ["happy.normal"], "pose": ["idle"],
            "stance": ["current", "sitting", "standing"],
            "sittingPose": ["current", "normal", "agura"],
        },
    })

    result = [chunk async for chunk in agent.reply("盘腿坐吧")]

    assert result == ["[POSE:sitting.agura][MOOD:happy.normal]好呀，这样坐舒服多了。"]


async def test_agent_schedules_up_to_three_actions_by_spoken_segment(tmp_path: Path) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({
            "text": "表演一下。", "emotion": "happy", "intensity": "normal",
            "beats": [
                {"text": "先挥挥手。", "look": "user", "action": "group:1", "actionHoldMs": 1800},
                {"text": "再伸个懒腰！", "action": "group:2", "actionHoldMs": 2400},
                {"text": "好啦。", "attitude": "agree"},
                {"text": "这一段不应出现。", "action": "group:1"},
            ],
        }, ensure_ascii=False)}}]})

    store = SettingsStore(tmp_path / "settings.json")
    value = store.snapshot()
    value["llm"]["url"] = "https://llm.test/chat/completions"
    store.update(value)
    agent = RyzaAgentSource(store, transport=httpx.MockTransport(handler))
    agent.set_model_info({
        "motions": [{"name": "group:1", "label": "挥手"}, {"name": "group:2", "label": "伸懒腰"}],
        "primitives": {
            "mood": ["happy.normal"], "pose": ["idle", "agree"], "look": ["user"],
            "hold": ["1800", "2400"], "stance": ["current", "sitting", "standing"],
            "sittingPose": ["current", "normal", "agura"],
        },
    })

    result = [chunk async for chunk in agent.reply("连续做几个动作看看")]

    assert result == [
        "[MOOD:happy.normal][LOOK:user][HOLD:1800][MOTION:group:1]先挥挥手。"
        "[MOOD:happy.normal][HOLD:2400][MOTION:group:2]再伸个懒腰！"
        "[MOOD:happy.normal][POSE:agree]好啦。"
    ]
    assert agent.messages[-1]["content"] == "先挥挥手。再伸个懒腰！好啦。"



async def test_agent_supports_responses_api(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert "messages" not in body
        assert body["instructions"]
        assert body["input"][-1] == {"role": "user", "content": "你好"}
        assert body["max_output_tokens"] == 1200
        return httpx.Response(200, json={"output": [{
            "type": "message",
            "content": [{"type": "output_text", "text": json.dumps({
                "text": "Responses 成功。", "emotion": "happy", "intensity": "normal"
            }, ensure_ascii=False)}],
        }]})

    store = SettingsStore(tmp_path / "settings.json")
    value = store.snapshot()
    value["llm"].update({"apiMode": "responses", "url": "https://llm.test/v1/responses"})
    store.update(value)
    agent = RyzaAgentSource(store, transport=httpx.MockTransport(handler))
    agent.set_model_info({"primitives": {"mood": ["happy.normal"]}})

    result = [chunk async for chunk in agent.reply("你好")]

    assert result == ["[MOOD:happy.normal]Responses 成功。"]
