from __future__ import annotations

import audioop
import base64
import io
import json
import re
import struct
import time
from collections.abc import AsyncIterator
from typing import Any

import httpx

from mokamoka import SAMPLE_RATE, TTSChunk

from .settings import SettingsStore, llm_extra_body

_TEMPLATE = re.compile(r"\{\{JSON\.stringify\((speakText|text|model|voice|instruction|speechLanguage)\)\}\}")


def render_body(profile: dict[str, Any], text: str, speech_language: str = "zh") -> dict[str, Any]:
    instruction = profile.get("instruction", "")
    if speech_language == "ja":
        instruction = f"{instruction}\n必须使用自然日语朗读；不要把内容翻译成中文。".strip()
    values = {
        "speakText": text,
        "text": text,
        "model": profile.get("model", ""),
        "voice": profile.get("voice", ""),
        "instruction": instruction,
        "speechLanguage": speech_language,
    }
    rendered = _TEMPLATE.sub(lambda match: json.dumps(values[match.group(1)], ensure_ascii=False), profile.get("bodyTemplate") or "{}")
    if "{{" in rendered or "}}" in rendered:
        raise ValueError(f"{profile['name']} 包含不支持的模板占位符")
    try:
        body = json.loads(rendered)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{profile['name']} 请求体模板错误：{exc.msg}") from None
    if not isinstance(body, dict):
        raise ValueError(f"{profile['name']} 请求体模板必须生成 JSON 对象")
    if speech_language == "ja":
        for key in ("language", "text_lang"):
            if key in body:
                body[key] = "ja"
        hf_voices = {"zh_ryza": "ja_ryza", "zh_ryza_asmr": "ja_ryza_asmr"}
        if body.get("voice_id") in hf_voices:
            body["voice_id"] = hf_voices[body["voice_id"]]
    return body


def request_headers(profile: dict[str, Any]) -> dict[str, str]:
    headers = {str(k): str(v) for k, v in json.loads(profile.get("headers") or "{}").items()}
    names = {name.lower() for name in headers}
    key = profile.get("key") or ""
    if key and not {"authorization", "api-key"}.intersection(names):
        headers["api-key" if profile["adapter"] == "mimo-sse" else "Authorization"] = (
            key if profile["adapter"] == "mimo-sse" else f"Bearer {key}"
        )
    headers.setdefault("Content-Type", "application/json")
    if profile.get("responseContentType") and "accept" not in names:
        headers["Accept"] = profile["responseContentType"]
    return headers


def _translation_headers(llm: dict[str, Any]) -> dict[str, str]:
    headers = {str(k): str(v) for k, v in json.loads(llm.get("headers") or "{}").items()}
    if llm.get("key") and not any(name.lower() == "authorization" for name in headers):
        headers["Authorization"] = f"Bearer {llm['key']}"
    headers.setdefault("Content-Type", "application/json")
    return headers


def _translation_content(payload: Any) -> str:
    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        content = payload.get("output_text") if isinstance(payload, dict) else None
        if not isinstance(content, str) and isinstance(payload, dict):
            content = "".join(
                str(block.get("text") or "")
                for item in payload.get("output") or [] if isinstance(item, dict) and item.get("type") == "message"
                for block in item.get("content") or [] if isinstance(block, dict) and block.get("type") == "output_text"
            )
    if isinstance(content, list):
        content = "".join(str(part.get("text") or "") for part in content if isinstance(part, dict))
    text = re.sub(r"^```(?:\w+)?\s*|\s*```$", "", str(content or "").strip())
    quote_pairs = {'"': '"', "'": "'", "“": "”", "「": "」"}
    if len(text) >= 2 and quote_pairs.get(text[0]) == text[-1]:
        text = text[1:-1].strip()
    if not text:
        raise RuntimeError("日语语音翻译没有返回文本")
    return text


def parse_wave(data: bytes) -> tuple[str, int, int, bytes]:
    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("响应不是 RIFF/WAVE")
    offset = 12
    metadata: tuple[str, int, int, int] | None = None
    pcm = b""
    while offset + 8 <= len(data):
        chunk_id = data[offset:offset + 4]
        size = struct.unpack_from("<I", data, offset + 4)[0]
        start = offset + 8
        end = len(data) if chunk_id == b"data" and size == 0xFFFFFFFF else start + size
        if end > len(data):
            raise ValueError("WAV chunk 不完整")
        chunk = data[start:end]
        if chunk_id == b"fmt ":
            if len(chunk) < 16:
                raise ValueError("WAV fmt chunk 不完整")
            tag, channels, rate, _, align, bits = struct.unpack_from("<HHIIHH", chunk)
            if tag == 0xFFFE and len(chunk) >= 40:
                tag = struct.unpack_from("<H", chunk, 24)[0]
            fmt = "int16" if tag == 1 and bits == 16 else "float32" if tag == 3 and bits == 32 else ""
            if not fmt or not channels or not rate or align != channels * (bits // 8):
                raise ValueError(f"WAV 格式不受支持：format={tag}, bits={bits}")
            metadata = (fmt, channels, rate, align)
        elif chunk_id == b"data":
            pcm = chunk
            break
        offset = end + (size & 1)
    if metadata is None or not pcm:
        raise ValueError("WAV 缺少 fmt 或 data")
    if len(pcm) % metadata[3]:
        raise ValueError("WAV PCM 结尾不是完整音频帧")
    return metadata[0], metadata[1], metadata[2], pcm


def parse_wave_stream_header(data: bytes) -> tuple[str, int, int, int, int, int] | None:
    if len(data) < 12:
        return None
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("响应不是 RIFF/WAVE")
    offset = 12
    metadata: tuple[str, int, int, int] | None = None
    while True:
        if offset + 8 > len(data):
            return None
        chunk_id = data[offset:offset + 4]
        size = struct.unpack_from("<I", data, offset + 4)[0]
        start = offset + 8
        if chunk_id == b"data":
            if metadata is None:
                raise ValueError("WAV data 出现在 fmt 之前")
            return *metadata, start, size
        end = start + size
        if end > len(data):
            return None
        if chunk_id == b"fmt ":
            chunk = data[start:end]
            if len(chunk) < 16:
                raise ValueError("WAV fmt chunk 不完整")
            tag, channels, rate, _, align, bits = struct.unpack_from("<HHIIHH", chunk)
            if tag == 0xFFFE and len(chunk) >= 40:
                tag = struct.unpack_from("<H", chunk, 24)[0]
            fmt = "int16" if tag == 1 and bits == 16 else "float32" if tag == 3 and bits == 32 else ""
            if not fmt or not channels or not rate or align != channels * (bits // 8):
                raise ValueError(f"WAV 格式不受支持：format={tag}, bits={bits}")
            metadata = (fmt, channels, rate, align)
        offset = end + (size & 1)


def _float32_to_int16(data: bytes) -> bytes:
    if len(data) % 4:
        raise ValueError("Float32 PCM 结尾不完整")
    result = bytearray(len(data) // 2)
    for index, (sample,) in enumerate(struct.iter_unpack("<f", data)):
        value = max(-1.0, min(1.0, sample))
        struct.pack_into("<h", result, index * 2, round(value * 32767))
    return bytes(result)


def _downmix(data: bytes, channels: int) -> bytes:
    if channels == 1:
        return data
    if channels == 2:
        return audioop.tomono(data, 2, 0.5, 0.5)
    frame = channels * 2
    result = bytearray(len(data) // channels)
    out = 0
    for offset in range(0, len(data), frame):
        total = sum(struct.unpack_from("<h", data, offset + channel * 2)[0] for channel in range(channels))
        struct.pack_into("<h", result, out, round(total / channels))
        out += 2
    return bytes(result)


def convert_pcm(data: bytes, fmt: str, channels: int, source_rate: int, state=None) -> tuple[bytes, Any]:
    if fmt == "float32":
        data = _float32_to_int16(data)
    elif fmt != "int16":
        raise ValueError(f"不支持的 PCM format：{fmt}")
    data = _downmix(data, channels)
    if source_rate != SAMPLE_RATE:
        data, state = audioop.ratecv(data, 2, 1, source_rate, SAMPLE_RATE, state)
    return data, state


class CloudTTSRouter:
    def __init__(self, store: SettingsStore, *, transport: httpx.AsyncBaseTransport | None = None):
        self.store = store
        self.transport = transport
        self._translation_cache: dict[tuple[str, str, str], str] = {}

    async def warmup(self) -> None:
        return None

    async def aclose(self) -> None:
        return None

    async def _translate_to_japanese(self, text: str, llm: dict[str, Any]) -> str:
        cache_key = (llm["url"], llm["model"], text)
        if cache_key in self._translation_cache:
            return self._translation_cache[cache_key]
        messages = [
            {
                "role": "system",
                "content": (
                    "你是日语口语翻译引擎。把用户提供的中文准确翻译成自然、适合朗读的日语，"
                    "保持语气、人名、数字和含义；莱莎译作ライザ。只输出日语译文，不要解释。"
                ),
            },
            {"role": "user", "content": text},
        ]
        extra_body = llm_extra_body(llm)
        gemini_thinking = bool(llm.get("thinking")) and "gemini" in str(llm.get("model") or "").lower()
        responses_api = llm.get("apiMode") == "responses" or llm["url"].rstrip("/").endswith("/responses")
        if responses_api:
            body: dict[str, Any] = {
                "model": llm["model"],
                "instructions": messages[0]["content"],
                "input": messages[1:],
                "temperature": min(0.2, llm["temperature"]),
                "max_output_tokens": llm["maxTokens"],
            }
        else:
            body = {
                "model": llm["model"],
                "messages": messages,
                "temperature": min(0.2, llm["temperature"]),
                "max_tokens": llm["maxTokens"],
            }
            if not gemini_thinking:
                body["thinking"] = {"type": "disabled"}
        body.update(extra_body)
        body["input" if responses_api else "messages"] = messages[1:] if responses_api else messages
        if responses_api:
            body["instructions"] = messages[0]["content"]
        body.pop("response_format", None)
        body.pop("text", None)
        body.pop("stream", None)
        async with httpx.AsyncClient(transport=self.transport, timeout=llm["timeout"]) as client:
            response = await client.request(llm["method"], llm["url"], headers=_translation_headers(llm), json=body)
        if response.is_error:
            raise RuntimeError(f"日语语音翻译失败 · {llm['name']} HTTP {response.status_code}: {response.text[:300]}")
        try:
            translated = _translation_content(response.json())
        except ValueError:
            raise RuntimeError(f"日语语音翻译失败 · {llm['name']} 返回的响应不是有效 JSON") from None
        if len(self._translation_cache) >= 256:
            self._translation_cache.pop(next(iter(self._translation_cache)))
        self._translation_cache[cache_key] = translated
        return translated

    async def _response(self, profile: dict[str, Any], text: str, speech_language: str) -> httpx.Response:
        body = render_body(profile, text, speech_language)
        method = profile.get("method") or "POST"
        kwargs = {} if method in {"GET", "HEAD"} else {"json": body}
        async with httpx.AsyncClient(transport=self.transport, timeout=profile.get("timeout", 120)) as client:
            response = await client.request(method, profile["url"], headers=request_headers(profile), **kwargs)
        if response.is_error:
            raise RuntimeError(f"{profile['name']} HTTP {response.status_code}: {response.text[:300]}")
        return response

    async def _mimo(self, profile: dict[str, Any], text: str, speech_language: str) -> AsyncIterator[TTSChunk]:
        body = render_body(profile, text, speech_language)
        method = profile.get("method") or "POST"
        kwargs = {} if method in {"GET", "HEAD"} else {"json": body}
        source_width = 4 if profile["format"] == "float32" else 2
        frame_width = source_width * profile["channels"]
        carry = b""
        rate_state = None
        count = 0
        async with httpx.AsyncClient(transport=self.transport, timeout=profile.get("timeout", 120)) as client:
            async with client.stream(method, profile["url"], headers=request_headers(profile), **kwargs) as response:
                if response.is_error:
                    error = (await response.aread()).decode(errors="replace")
                    raise RuntimeError(f"{profile['name']} HTTP {response.status_code}: {error[:300]}")
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    raw = line[5:].strip()
                    if not raw or raw == "[DONE]":
                        continue
                    try:
                        payload = json.loads(raw)
                        encoded = payload["choices"][0]["delta"]["audio"]["data"]
                        incoming = base64.b64decode(encoded, validate=True)
                    except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError):
                        continue
                    combined = carry + incoming
                    complete = len(combined) - len(combined) % frame_width
                    carry = combined[complete:]
                    if not complete:
                        continue
                    pcm, rate_state = convert_pcm(combined[:complete], profile["format"], profile["channels"], profile["sampleRate"], rate_state)
                    if pcm:
                        count += 1
                        yield TTSChunk(pcm)
        if carry:
            raise ValueError(f"{profile['name']} PCM 结尾不是完整音频帧")
        if not count:
            raise ValueError(f"{profile['name']} 没有返回音频分片")

    async def _streaming(self, profile: dict[str, Any], text: str, *, wave: bool, speech_language: str) -> AsyncIterator[TTSChunk]:
        body = render_body(profile, text, speech_language)
        method = profile.get("method") or "POST"
        kwargs = {} if method in {"GET", "HEAD"} else {"json": body}
        fmt = profile["format"]
        channels = profile["channels"]
        rate = profile["sampleRate"]
        frame_width = (4 if fmt == "float32" else 2) * channels
        pending = b""
        carry = b""
        rate_state = None
        data_remaining: int | None = None
        header_ready = not wave
        count = 0
        async with httpx.AsyncClient(transport=self.transport, timeout=profile.get("timeout", 120)) as client:
            async with client.stream(method, profile["url"], headers=request_headers(profile), **kwargs) as response:
                if response.is_error:
                    error = (await response.aread()).decode(errors="replace")
                    raise RuntimeError(f"{profile['name']} HTTP {response.status_code}: {error[:300]}")
                async for incoming in response.aiter_bytes():
                    pending += incoming
                    if not header_ready:
                        header = parse_wave_stream_header(pending)
                        if header is None:
                            continue
                        fmt, channels, rate, frame_width, data_start, data_size = header
                        pending = pending[data_start:]
                        data_remaining = None if data_size == 0xFFFFFFFF else data_size
                        header_ready = True
                    if data_remaining is not None:
                        audio = pending[:data_remaining]
                        data_remaining -= len(audio)
                    else:
                        audio = pending
                    pending = b""
                    combined = carry + audio
                    complete = len(combined) - len(combined) % frame_width
                    carry = combined[complete:]
                    if complete:
                        pcm, rate_state = convert_pcm(combined[:complete], fmt, channels, rate, rate_state)
                        if pcm:
                            count += 1
                            yield TTSChunk(pcm)
                    if data_remaining == 0:
                        break
        if not header_ready:
            raise ValueError(f"{profile['name']} WAV header 不完整")
        if carry:
            raise ValueError(f"{profile['name']} PCM 结尾不是完整音频帧")
        if not count:
            raise ValueError(f"{profile['name']} 没有返回音频数据")

    async def _buffered(self, profile: dict[str, Any], text: str, speech_language: str) -> AsyncIterator[TTSChunk]:
        response = await self._response(profile, text, speech_language)
        content_type = response.headers.get("content-type", "").lower()
        if any(name in content_type for name in ("mpeg", "mp3", "mp4", "aac", "ogg")):
            raise ValueError(f"{profile['name']} 返回压缩音频；请改用 WAV 或 raw PCM")
        adapter = profile["adapter"]
        body = render_body(profile, text, speech_language)
        media_type = str(body.get("media_type") or "").lower()
        if adapter == "http-wav" or (adapter == "gpt-sovits-stream" and (media_type == "wav" or "wav" in content_type)):
            fmt, channels, rate, raw = parse_wave(response.content)
        else:
            fmt, channels, rate, raw = profile["format"], profile["channels"], profile["sampleRate"], response.content
        pcm, _ = convert_pcm(raw, fmt, channels, rate)
        if not pcm:
            raise ValueError(f"{profile['name']} 没有返回音频数据")
        size = 64 * 1024
        for offset in range(0, len(pcm), size):
            yield TTSChunk(pcm[offset:offset + size])

    async def synth(self, text: str) -> AsyncIterator[TTSChunk]:
        settings = self.store.snapshot()
        tts = settings["tts"]
        profile = next(item for item in tts["profiles"] if item["id"] == tts["activeProfileId"])
        speech_language = "ja" if tts["speechMode"] == "zh-ja" else "zh"
        speak_text = await self._translate_to_japanese(text, settings["llm"]) if speech_language == "ja" else text
        adapter = profile["adapter"]
        if adapter == "mimo-sse":
            async for chunk in self._mimo(profile, speak_text, speech_language):
                yield chunk
        elif profile.get("streaming") and adapter in {"gpt-sovits-stream", "raw-pcm"}:
            body = render_body(profile, speak_text, speech_language)
            wave = adapter == "gpt-sovits-stream" and str(body.get("media_type") or "").lower() == "wav"
            async for chunk in self._streaming(profile, speak_text, wave=wave, speech_language=speech_language):
                yield chunk
        else:
            async for chunk in self._buffered(profile, speak_text, speech_language):
                yield chunk

    async def test(self, _payload: dict[str, Any] | None = None) -> dict[str, Any]:
        started = time.perf_counter()
        parts: list[bytes] = []
        total = 0
        limit = SAMPLE_RATE * 2
        async for chunk in self.synth("你好，这是语音测试。"):
            parts.append(chunk.pcm)
            total += len(chunk.pcm)
            if total >= limit:
                break
        pcm = b"".join(parts)[:limit]
        return {
            "profile": self.store.active_tts()["name"],
            "pcmBytes": len(pcm),
            "audioPcmBase64": base64.b64encode(pcm).decode(),
            "elapsedMs": round((time.perf_counter() - started) * 1000),
            "sampleRate": SAMPLE_RATE,
            "channels": 1,
            "format": "s16le",
        }
