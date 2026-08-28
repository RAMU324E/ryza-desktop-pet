from __future__ import annotations

from pathlib import Path

import yaml

from ryza_moka.agent import RyzaClonothAgentSource
from ryza_moka.clonoth import ClonothRuntimeClient, clonoth_root, sync_clonoth_settings
from ryza_moka.settings import SettingsStore


def test_sync_clonoth_settings_writes_provider_nodes_and_streamable_http_mcp(tmp_path: Path, monkeypatch) -> None:
    root = tmp_path / "clonoth"
    monkeypatch.setenv("RYZA_CLONOTH_ROOT", str(root))
    store = SettingsStore(tmp_path / "settings.json")
    value = store.snapshot()
    value["systemPrompt"] = "保留的人设。\n\n你必须只输出一个 JSON 对象：\n{\"text\":\"回复\"}"
    value["llm"].update({
        "apiMode": "chat-completions",
        "url": "https://api.deepseek.com/chat/completions",
        "key": "test-key",
        "model": "deepseek-v4-pro",
        "extraBody": '{"generationConfig":{"thinkingConfig":{"thinkingLevel":"MEDIUM"}}}',
    })
    value["agent"]["mcp"].update({
        "enabled": True,
        "url": "https://search.test/mcp",
        "headers": '{"Authorization":"Bearer test"}',
    })
    value["agent"]["vision"].update({
        "enabled": True,
        "apiMode": "responses",
        "url": "https://vision.test/v1/responses",
        "key": "vision-key",
        "model": "vision-model",
    })
    store.update(value)

    assert sync_clonoth_settings(store) is True
    assert clonoth_root() == root
    config = yaml.safe_load((root / "data" / "config.yaml").read_text(encoding="utf-8"))
    assert config["provider"] == "deepseek"
    assert config["deepseek"]["base_url"] == "https://api.deepseek.com"
    chat = yaml.safe_load((root / "config" / "nodes" / "ryza.chat.yaml").read_text(encoding="utf-8"))
    assert chat["provider"] == "deepseek"
    assert chat["api_key"] == "test-key"
    assert chat["provider_options"] == {
        "extra_body": {"generationConfig": {"thinkingConfig": {"thinkingLevel": "MEDIUM"}}}
    }
    assert "保留的人设" in chat["prompt"]
    assert "你必须只输出一个 JSON 对象" not in chat["prompt"]
    vision = yaml.safe_load((root / "config" / "nodes" / "ryza.vision.yaml").read_text(encoding="utf-8"))
    assert vision["provider"] == "openai-responses"
    assert vision["base_url"] == "https://vision.test/v1"
    mcp = yaml.safe_load((root / "data" / "mcp_clients.yaml").read_text(encoding="utf-8"))
    assert mcp["clients"]["search"]["transport"] == "streamable_http"
    assert sync_clonoth_settings(store) is False


def test_screenshot_marker_becomes_trusted_clonoth_image_attachment(tmp_path: Path, monkeypatch) -> None:
    root = tmp_path / "clonoth"
    image = root / "data" / "attachments" / "ryza" / "screen.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(b"png")
    monkeypatch.setenv("RYZA_CLONOTH_ROOT", str(root))
    client = ClonothRuntimeClient(SettingsStore(tmp_path / "settings.json"))

    text, attachments, node = client._request(f"[[RYZA_IMAGE:{image}]]\n看看这里")

    assert text == "看看这里"
    assert node == "ryza.vision"
    assert attachments == [{
        "path": "data/attachments/ryza/screen.png",
        "name": "screen.png",
        "type": "image",
        "mime_type": "image/png",
    }]


async def test_clonoth_agent_preserves_exact_reply_while_planning(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("RYZA_CLONOTH_ROOT", str(tmp_path / "clonoth"))
    store = SettingsStore(tmp_path / "settings.json")
    agent = RyzaClonothAgentSource(store)
    agent.set_model_info({
        "motions": [{"name": "group:1", "label": "挥手"}],
        "primitives": {"mood": ["happy.normal"], "hold": ["1800"]},
    })

    async def reply(_text: str) -> str:
        return "第一句。第二句。"

    async def plan(_text: str, *, include_history: bool = True):
        return agent.planner._normalize({
            "text": "被改写的文字",
            "emotion": "happy",
            "beats": [
                {"text": "第一句。", "action": "group:1", "actionHoldMs": 1800},
                {"text": "第二句。"},
            ],
        })

    agent.clonoth.reply = reply
    agent.planner._reply_value = plan

    chunks = [chunk async for chunk in agent.reply("测试")]

    assert chunks == [
        "[MOOD:happy.normal][HOLD:1800][MOTION:group:1]第一句。"
        "[MOOD:happy.normal]第二句。"
    ]
