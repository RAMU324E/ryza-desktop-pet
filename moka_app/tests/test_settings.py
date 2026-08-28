from __future__ import annotations

import json
from pathlib import Path

import pytest

from ryza_moka.settings import SettingsError, SettingsStore, default_settings, llm_extra_body


def test_defaults_are_complete(tmp_path: Path) -> None:
    store = SettingsStore(tmp_path / "settings.json")
    value = store.snapshot()
    assert value["llm"]["model"]
    assert value["tts"]["speechMode"] == "zh"
    assert value["character"] == {"stance": "sitting", "sittingPose": "normal"}
    assert value["tts"]["activeProfileId"] == "mimo-bingtang"
    assert value["agent"]["source"] == "clonoth"
    assert value["agent"]["vision"]["apiMode"] == "responses"
    assert {p["adapter"] for p in value["tts"]["profiles"]} == {
        "mimo-sse", "http-wav", "gpt-sovits-stream"
    }
    assert not store.path.exists()


def test_legacy_settings_are_copied_verbatim_in_meaning(tmp_path: Path) -> None:
    legacy = tmp_path / "legacy.json"
    target = tmp_path / "appdata" / "settings.json"
    value = default_settings()
    value["llm"]["key"] = "plain-key"
    value["tts"]["profiles"][0]["key"] = "plain-tts-key"
    legacy.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    store = SettingsStore(target, legacy_path=legacy)

    assert store.snapshot()["llm"]["key"] == "plain-key"
    assert store.active_tts()["key"] == "plain-tts-key"
    saved = json.loads(target.read_text(encoding="utf-8"))
    assert saved["llm"]["key"] == "plain-key"


def test_update_is_immediate_and_persistent(tmp_path: Path) -> None:
    path = tmp_path / "settings.json"
    store = SettingsStore(path)
    value = store.snapshot()
    value["llm"]["model"] = "new-model"
    value["tts"]["activeProfileId"] = "hf-ryza-asmr"
    value["character"] = {"stance": "standing", "sittingPose": "agura"}

    store.update(value)

    assert store.snapshot()["llm"]["model"] == "new-model"
    assert store.active_tts()["adapter"] == "http-wav"
    reloaded = SettingsStore(path).snapshot()
    assert reloaded["llm"]["model"] == "new-model"
    assert reloaded["character"] == {"stance": "standing", "sittingPose": "agura"}


def test_gemini_thinking_level_is_derived_from_model_name() -> None:
    body = llm_extra_body({
        "model": "gemini-3.7-flash",
        "thinking": True,
        "reasoningEffort": "medium",
        "extraBody": "{}",
    })
    assert body == {"generationConfig": {"thinkingConfig": {"thinkingLevel": "MEDIUM"}}}


def test_invalid_character_pose_is_rejected(tmp_path: Path) -> None:
    store = SettingsStore(tmp_path / "settings.json")
    value = store.snapshot()
    value["character"]["sittingPose"] = "unknown"
    with pytest.raises(SettingsError):
        store.update(value)


def test_invalid_speech_mode_is_rejected(tmp_path: Path) -> None:
    store = SettingsStore(tmp_path / "settings.json")
    value = store.snapshot()
    value["tts"]["speechMode"] = "unknown"
    with pytest.raises(SettingsError):
        store.update(value)


def test_invalid_profile_is_rejected(tmp_path: Path) -> None:
    store = SettingsStore(tmp_path / "settings.json")
    value = store.snapshot()
    value["tts"]["profiles"][0]["adapter"] = "unknown"
    with pytest.raises(SettingsError):
        store.update(value)
