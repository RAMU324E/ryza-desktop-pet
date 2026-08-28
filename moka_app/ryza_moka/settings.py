from __future__ import annotations

import copy
import json
import os
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

ADAPTERS = {"mimo-sse", "http-wav", "gpt-sovits-stream", "raw-pcm"}
SPEECH_MODES = {"zh", "zh-ja"}
STANCES = {"sitting", "standing"}
SITTING_POSES = {"normal", "agura"}
AGENT_SOURCES = {"clonoth", "direct"}
API_MODES = {"auto", "chat-completions", "responses"}


class SettingsError(ValueError):
    pass


def llm_extra_body(llm: dict[str, Any]) -> dict[str, Any]:
    body = json.loads(str(llm.get("extraBody") or "{}"))
    if llm.get("thinking") and "gemini" in str(llm.get("model") or "").lower():
        level = str(llm.get("reasoningEffort") or "medium").upper()
        if level not in {"LOW", "MEDIUM", "HIGH"}:
            level = "MEDIUM"
        generation = body.setdefault("generationConfig", {})
        if not isinstance(generation, dict):
            generation = body["generationConfig"] = {}
        thinking = generation.setdefault("thinkingConfig", {})
        if not isinstance(thinking, dict):
            thinking = generation["thinkingConfig"] = {}
        thinking.setdefault("thinkingLevel", level)
    return body


def _default_path() -> Path:
    base = Path(os.environ.get("APPDATA") or Path.home())
    return base / "RyzaPet" / "settings.json"


def _profile_presets() -> list[dict[str, Any]]:
    return [
        {
            "id": "mimo-bingtang",
            "name": "MiMo 冰糖",
            "adapter": "mimo-sse",
            "url": "https://api.xiaomimimo.com/v1/chat/completions",
            "method": "POST",
            "key": "",
            "model": "mimo-v2.5-tts",
            "voice": "冰糖",
            "instruction": "请使用自然、亲切、清晰的中文语音朗读。",
            "headers": '{"Content-Type":"application/json"}',
            "bodyTemplate": '{"model":{{JSON.stringify(model)}},"messages":[{"role":"user","content":{{JSON.stringify(instruction)}}},{"role":"assistant","content":{{JSON.stringify(speakText)}}}],"audio":{"format":"pcm16","voice":{{JSON.stringify(voice)}}},"stream":true}',
            "responseContentType": "text/event-stream",
            "format": "int16",
            "sampleRate": 24000,
            "channels": 1,
            "concurrency": 1,
            "streaming": True,
        },
        {
            "id": "hf-ryza-asmr",
            "name": "莱莎 CN（ASMR）- HF 云端",
            "adapter": "http-wav",
            "url": "https://example.invalid/v1/tts",
            "method": "POST",
            "key": "",
            "model": "",
            "voice": "zh_ryza_asmr",
            "instruction": "",
            "headers": '{"Content-Type":"application/json"}',
            "bodyTemplate": '{"text":{{JSON.stringify(speakText)}},"voice_id":"zh_ryza_asmr","language":{{JSON.stringify(speechLanguage)}},"response_format":"wav","speed_factor":1.0,"text_split_method":"cut0"}',
            "responseContentType": "audio/wav",
            "format": "int16",
            "sampleRate": 32000,
            "channels": 1,
            "concurrency": 1,
            "streaming": False,
        },
        {
            "id": "gpt-sovits-v2-local",
            "name": "本地 GPT-SoVITS v2",
            "adapter": "gpt-sovits-stream",
            "url": "http://127.0.0.1:9880/tts",
            "method": "POST",
            "key": "",
            "model": "GPT-SoVITS v2",
            "voice": "莱莎",
            "instruction": "",
            "headers": '{"Content-Type":"application/json"}',
            "bodyTemplate": '{"text":{{JSON.stringify(speakText)}},"text_lang":{{JSON.stringify(speechLanguage)}},"ref_audio_path":"","prompt_lang":"zh","prompt_text":"","text_split_method":"cut5","batch_size":1,"media_type":"wav","streaming_mode":true}',
            "responseContentType": "audio/wav",
            "format": "int16",
            "sampleRate": 32000,
            "channels": 1,
            "concurrency": 1,
            "streaming": True,
        },
    ]


def _read_default_prompt() -> str:
    return (Path(__file__).with_name("default_prompt.md").read_text(encoding="utf-8")).strip()


def default_settings() -> dict[str, Any]:
    profiles = _profile_presets()
    return {
        "llm": {
            "name": "OpenAI Compatible",
            "apiMode": "auto",
            "url": "https://api.deepseek.com/chat/completions",
            "method": "POST",
            "key": "",
            "headers": "{}",
            "model": "deepseek-chat",
            "extraBody": "{}",
            "thinking": False,
            "reasoningEffort": "",
            "temperature": 0.8,
            "maxTokens": 1200,
            "responseFormat": True,
            "timeout": 60,
        },
        "tts": {"speechMode": "zh", "activeProfileId": profiles[0]["id"], "profiles": profiles},
        "character": {"stance": "sitting", "sittingPose": "normal"},
        "performance": {
            "mouthSensitivity": 1.6,
            "mouthAttackMs": 90,
            "mouthReleaseMs": 150,
            "mouthMinHoldMs": 0,
            "mouthMixMs": 140,
        },
        "agent": {
            "source": "clonoth",
            "vision": {
                "enabled": False,
                "apiMode": "responses",
                "url": "https://api.openai.com/v1/responses",
                "key": "",
                "model": "gpt-4.1-mini",
            },
            "mcp": {"enabled": False, "url": "", "headers": "{}"},
        },
        "systemPrompt": _read_default_prompt(),
    }


def _text(value: Any, fallback: str = "") -> str:
    return value if isinstance(value, str) else fallback


def _json_object_text(value: Any, label: str) -> str:
    text = value if isinstance(value, str) else json.dumps(value or {}, ensure_ascii=False)
    try:
        parsed = json.loads(text or "{}")
    except json.JSONDecodeError as exc:
        raise SettingsError(f"{label} 不是有效 JSON：{exc.msg}") from None
    if not isinstance(parsed, dict):
        raise SettingsError(f"{label} 必须是 JSON 对象")
    return text or "{}"


def _http_url(value: Any, label: str) -> str:
    text = _text(value).strip()
    parsed = urlparse(text)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise SettingsError(f"{label} 不是有效的 HTTP URL")
    return text


def _number(value: Any, fallback: float, minimum: float, maximum: float, label: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = fallback
    if not minimum <= number <= maximum:
        raise SettingsError(f"{label} 必须在 {minimum:g} 到 {maximum:g} 之间")
    return number


def normalize_settings(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise SettingsError("settings 必须是对象")
    defaults = default_settings()

    source_llm = value.get("llm") if isinstance(value.get("llm"), dict) else {}
    llm_default = defaults["llm"]
    method = _text(source_llm.get("method"), llm_default["method"]).strip().upper()
    if not method.isalpha():
        raise SettingsError("llm.method 无效")
    llm = {
        "name": _text(source_llm.get("name"), llm_default["name"]).strip() or llm_default["name"],
        "apiMode": _text(source_llm.get("apiMode"), llm_default["apiMode"]).strip().lower(),
        "url": _http_url(source_llm.get("url", llm_default["url"]), "llm.url"),
        "method": method,
        "key": _text(source_llm.get("key")),
        "headers": _json_object_text(source_llm.get("headers", "{}"), "llm.headers"),
        "model": _text(source_llm.get("model"), llm_default["model"]).strip(),
        "extraBody": _json_object_text(source_llm.get("extraBody", "{}"), "llm.extraBody"),
        "thinking": bool(source_llm.get("thinking", llm_default["thinking"])),
        "reasoningEffort": _text(source_llm.get("reasoningEffort")),
        "temperature": _number(source_llm.get("temperature"), 0.8, 0, 2, "llm.temperature"),
        "maxTokens": int(_number(source_llm.get("maxTokens"), 1200, 1, 1_000_000, "llm.maxTokens")),
        "responseFormat": bool(source_llm.get("responseFormat", True)),
        "timeout": _number(source_llm.get("timeout"), 60, 1, 600, "llm.timeout"),
    }
    if llm["apiMode"] not in API_MODES:
        raise SettingsError(f"不支持的 LLM API 模式：{llm['apiMode']}")
    if not llm["model"]:
        raise SettingsError("llm.model 不能为空")

    source_tts = value.get("tts") if isinstance(value.get("tts"), dict) else defaults["tts"]
    speech_mode = _text(source_tts.get("speechMode"), "zh").strip()
    if speech_mode not in SPEECH_MODES:
        raise SettingsError(f"不支持的语音模式：{speech_mode}")
    source_profiles = source_tts.get("profiles")
    if not isinstance(source_profiles, list) or not source_profiles:
        raise SettingsError("tts.profiles 至少需要一个档案")
    profiles: list[dict[str, Any]] = []
    ids: set[str] = set()
    for index, source in enumerate(source_profiles):
        if not isinstance(source, dict):
            raise SettingsError(f"tts.profiles[{index}] 必须是对象")
        profile_id = _text(source.get("id")).strip()
        adapter = _text(source.get("adapter"), "raw-pcm").strip()
        if not profile_id or profile_id in ids:
            raise SettingsError("TTS 档案 id 必须存在且唯一")
        if adapter not in ADAPTERS:
            raise SettingsError(f"不支持的 TTS adapter：{adapter}")
        ids.add(profile_id)
        profile = {
            "id": profile_id,
            "name": _text(source.get("name"), profile_id).strip() or profile_id,
            "adapter": adapter,
            "url": _http_url(source.get("url"), f"tts.profiles[{index}].url"),
            "method": _text(source.get("method"), "POST").strip().upper() or "POST",
            "key": _text(source.get("key")),
            "model": _text(source.get("model")),
            "voice": _text(source.get("voice")),
            "instruction": _text(source.get("instruction")),
            "headers": _json_object_text(source.get("headers", "{}"), f"tts.profiles[{index}].headers"),
            "bodyTemplate": _text(source.get("bodyTemplate"), "{}"),
            "responseContentType": _text(source.get("responseContentType"), "application/octet-stream"),
            "format": "float32" if source.get("format") == "float32" else "int16",
            "sampleRate": int(_number(source.get("sampleRate"), 24000, 1000, 768000, "TTS sampleRate")),
            "channels": int(_number(source.get("channels"), 1, 1, 32, "TTS channels")),
            "concurrency": int(_number(source.get("concurrency"), 1, 1, 32, "TTS concurrency")),
            "streaming": bool(source.get("streaming", True)),
            "timeout": _number(source.get("timeout"), 120, 1, 600, "TTS timeout"),
        }
        profiles.append(profile)
    active = _text(source_tts.get("activeProfileId")).strip()
    if active not in ids:
        active = profiles[0]["id"]

    source_character = value.get("character") if isinstance(value.get("character"), dict) else {}
    stance = _text(source_character.get("stance"), "sitting").strip()
    sitting_pose = _text(source_character.get("sittingPose"), "normal").strip()
    if stance not in STANCES:
        raise SettingsError(f"不支持的角色姿态：{stance}")
    if sitting_pose not in SITTING_POSES:
        raise SettingsError(f"不支持的坐姿类型：{sitting_pose}")

    source_perf = value.get("performance") if isinstance(value.get("performance"), dict) else {}
    perf_default = defaults["performance"]
    performance = {
        "mouthSensitivity": _number(source_perf.get("mouthSensitivity"), perf_default["mouthSensitivity"], 0.25, 4, "嘴型灵敏度"),
        "mouthAttackMs": _number(source_perf.get("mouthAttackMs"), perf_default["mouthAttackMs"], 10, 1000, "张嘴响应"),
        "mouthReleaseMs": _number(source_perf.get("mouthReleaseMs"), perf_default["mouthReleaseMs"], 10, 2000, "闭嘴响应"),
        "mouthMinHoldMs": _number(source_perf.get("mouthMinHoldMs"), perf_default["mouthMinHoldMs"], 0, 1000, "嘴型最短保持"),
        "mouthMixMs": _number(source_perf.get("mouthMixMs"), perf_default["mouthMixMs"], 0, 500, "嘴型混合"),
    }
    source_agent = value.get("agent") if isinstance(value.get("agent"), dict) else {}
    agent_default = defaults["agent"]
    agent_source = _text(source_agent.get("source"), agent_default["source"]).strip().lower()
    if agent_source not in AGENT_SOURCES:
        raise SettingsError(f"不支持的 Agent source：{agent_source}")
    source_vision = source_agent.get("vision") if isinstance(source_agent.get("vision"), dict) else {}
    vision_default = agent_default["vision"]
    vision_enabled = bool(source_vision.get("enabled", vision_default["enabled"]))
    vision_mode = _text(source_vision.get("apiMode"), vision_default["apiMode"]).strip().lower()
    if vision_mode not in API_MODES:
        raise SettingsError(f"不支持的视觉 API 模式：{vision_mode}")
    vision_url = _text(source_vision.get("url"), vision_default["url"]).strip()
    vision_model = _text(source_vision.get("model"), vision_default["model"]).strip()
    if vision_enabled:
        vision_url = _http_url(vision_url, "agent.vision.url")
        if not vision_model:
            raise SettingsError("agent.vision.model 不能为空")
    source_mcp = source_agent.get("mcp") if isinstance(source_agent.get("mcp"), dict) else {}
    mcp_enabled = bool(source_mcp.get("enabled", False))
    mcp_url = _text(source_mcp.get("url")).strip()
    if mcp_enabled:
        mcp_url = _http_url(mcp_url, "agent.mcp.url")
    agent = {
        "source": agent_source,
        "vision": {
            "enabled": vision_enabled,
            "apiMode": vision_mode,
            "url": vision_url,
            "key": _text(source_vision.get("key")),
            "model": vision_model,
        },
        "mcp": {
            "enabled": mcp_enabled,
            "url": mcp_url,
            "headers": _json_object_text(source_mcp.get("headers", "{}"), "agent.mcp.headers"),
        },
    }

    return {
        "llm": llm,
        "tts": {"speechMode": speech_mode, "activeProfileId": active, "profiles": profiles},
        "character": {"stance": stance, "sittingPose": sitting_pose},
        "performance": performance,
        "agent": agent,
        "systemPrompt": _text(value.get("systemPrompt"), defaults["systemPrompt"]),
    }


class SettingsStore:
    def __init__(self, path: Path | None = None, *, legacy_path: Path | None = None):
        override = os.environ.get("RYZA_SETTINGS_PATH")
        self.path = Path(override) if override else (path or _default_path())
        self.legacy_path = legacy_path
        self._value = default_settings()
        self.load()

    def load(self) -> dict[str, Any]:
        source = self.path if self.path.exists() else self.legacy_path
        if source and source.exists():
            raw = json.loads(source.read_text(encoding="utf-8"))
            self._value = normalize_settings(raw)
            if source != self.path:
                self._write(self._value)
        else:
            self._value = normalize_settings(default_settings())
        return self.snapshot()

    def snapshot(self) -> dict[str, Any]:
        return copy.deepcopy(self._value)

    def update(self, value: Any) -> dict[str, Any]:
        normalized = normalize_settings(value)
        self._write(normalized)
        self._value = normalized
        return self.snapshot()

    def active_tts(self) -> dict[str, Any]:
        value = self._value["tts"]
        return copy.deepcopy(next(p for p in value["profiles"] if p["id"] == value["activeProfileId"]))

    def _write(self, value: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle, temp_name = tempfile.mkstemp(prefix=f"{self.path.name}.", suffix=".tmp", dir=self.path.parent)
        try:
            with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
                json.dump(value, stream, ensure_ascii=False, indent=2)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_name, self.path)
        except Exception:
            Path(temp_name).unlink(missing_ok=True)
            raise
