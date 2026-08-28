from __future__ import annotations

import base64
import io
import json
import struct
import wave
from pathlib import Path

import httpx

from ryza_moka.settings import SettingsStore
from ryza_moka.tts import CloudTTSRouter, parse_wave, render_body


def wav_bytes(rate: int = 24000, frames: int = 2400) -> bytes:
    stream = io.BytesIO()
    with wave.open(stream, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(b"".join(struct.pack("<h", (i % 200) - 100) for i in range(frames)))
    return stream.getvalue()


def test_parse_wave() -> None:
    fmt, channels, rate, pcm = parse_wave(wav_bytes())
    assert (fmt, channels, rate, len(pcm)) == ("int16", 1, 24000, 4800)


async def test_http_wav_is_normalized_to_moka_pcm(tmp_path: Path) -> None:
    audio = wav_bytes()

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=audio, headers={"content-type": "audio/wav"})

    store = SettingsStore(tmp_path / "settings.json")
    value = store.snapshot()
    value["tts"]["activeProfileId"] = "hf-ryza-asmr"
    value["tts"]["profiles"][1]["url"] = "https://tts.test/wav"
    store.update(value)
    router = CloudTTSRouter(store, transport=httpx.MockTransport(handler))

    pcm = b"".join([chunk.pcm async for chunk in router.synth("测试")])

    assert len(pcm) > 4800
    assert len(pcm) % 2 == 0


async def test_streaming_gpt_sovits_wave_is_incrementally_normalized(tmp_path: Path) -> None:
    audio = wav_bytes(frames=1000)

    class Chunks(httpx.AsyncByteStream):
        async def __aiter__(self):
            for offset in range(0, len(audio), 37):
                yield audio[offset:offset + 37]

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=Chunks(), headers={"content-type": "audio/wav"})

    store = SettingsStore(tmp_path / "settings.json")
    value = store.snapshot()
    value["tts"]["activeProfileId"] = "gpt-sovits-v2-local"
    value["tts"]["profiles"][2]["url"] = "https://tts.test/gpt"
    store.update(value)
    router = CloudTTSRouter(store, transport=httpx.MockTransport(handler))

    pcm = b"".join([chunk.pcm async for chunk in router.synth("测试")])

    assert len(pcm) > 2000
    assert len(pcm) % 2 == 0


async def test_mimo_sse_chunks_are_decoded_and_resampled(tmp_path: Path) -> None:
    raw = b"".join(struct.pack("<h", i - 50) for i in range(100))
    sse = "data: " + json.dumps({"choices": [{"delta": {"audio": {"data": base64.b64encode(raw).decode()}}}]}) + "\n\ndata: [DONE]\n"

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=sse, headers={"content-type": "text/event-stream"})

    store = SettingsStore(tmp_path / "settings.json")
    value = store.snapshot()
    value["tts"]["profiles"][0]["url"] = "https://tts.test/mimo"
    store.update(value)
    router = CloudTTSRouter(store, transport=httpx.MockTransport(handler))

    pcm = b"".join([chunk.pcm async for chunk in router.synth("测试")])

    assert len(pcm) > len(raw)
    assert len(pcm) % 2 == 0


async def test_chinese_text_is_translated_only_for_japanese_speech(tmp_path: Path) -> None:
    audio = wav_bytes()
    requests: list[tuple[str, dict]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        requests.append((request.url.host, body))
        if request.url.host == "llm.test":
            return httpx.Response(200, json={"choices": [{"message": {"content": "おかえりなさい！"}}]})
        return httpx.Response(200, content=audio, headers={"content-type": "audio/wav"})

    store = SettingsStore(tmp_path / "settings.json")
    value = store.snapshot()
    value["llm"]["url"] = "https://llm.test/chat/completions"
    value["tts"]["speechMode"] = "zh-ja"
    value["tts"]["activeProfileId"] = "hf-ryza-asmr"
    value["tts"]["profiles"][1]["url"] = "https://tts.test/wav"
    store.update(value)
    router = CloudTTSRouter(store, transport=httpx.MockTransport(handler))

    pcm = b"".join([chunk.pcm async for chunk in router.synth("欢迎回来！")])

    assert pcm
    assert requests[0][1]["messages"][-1]["content"] == "欢迎回来！"
    assert requests[1][1]["text"] == "おかえりなさい！"
    assert requests[1][1]["language"] == "ja"
    assert requests[1][1]["voice_id"] == "ja_ryza_asmr"


def test_japanese_mode_adapts_legacy_gpt_sovits_language_field(tmp_path: Path) -> None:
    store = SettingsStore(tmp_path / "settings.json")
    profile = store.snapshot()["tts"]["profiles"][2]

    body = render_body(profile, "今日はいい天気ですね。", "ja")

    assert body["text"] == "今日はいい天気ですね。"
    assert body["text_lang"] == "ja"
    assert body["prompt_lang"] == "zh"



async def test_japanese_translation_supports_responses_api(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["instructions"]
        assert body["input"] == [{"role": "user", "content": "欢迎回来！"}]
        assert "messages" not in body
        return httpx.Response(200, json={"output": [{
            "type": "message",
            "content": [{"type": "output_text", "text": "おかえりなさい！"}],
        }]})

    store = SettingsStore(tmp_path / "settings.json")
    value = store.snapshot()
    value["llm"].update({"apiMode": "responses", "url": "https://llm.test/v1/responses"})
    store.update(value)
    router = CloudTTSRouter(store, transport=httpx.MockTransport(handler))

    translated = await router._translate_to_japanese("欢迎回来！", store.snapshot()["llm"])

    assert translated == "おかえりなさい！"
