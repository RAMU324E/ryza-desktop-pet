from __future__ import annotations

import io
import json
import struct
import wave
from pathlib import Path

import httpx
from aiohttp.test_utils import TestClient, TestServer
from mokamoka import MokaClient
from mokamoka.tts.tone import ToneTTS

from ryza_moka.app import MOKA_TOKEN, create_ryza_app
from ryza_moka.settings import SettingsStore
from ryza_moka.tts import CloudTTSRouter


async def test_settings_routes_update_live_config(tmp_path: Path) -> None:
    store = SettingsStore(tmp_path / "settings.json")
    app = create_ryza_app(store, spine_dir=tmp_path / "missing")
    async with TestClient(TestServer(app)) as client:
        health = await (await client.get("/app/health")).json()
        assert health["ok"] is True
        assert health["tts"]["speechMode"] == "zh"
        assert health["character"] == {"stance": "sitting", "sittingPose": "normal"}
        current = await (await client.get("/app/settings")).json()
        current["llm"]["model"] = "route-model"
        response = await client.put("/app/settings", json=current)
        saved = await response.json()
        assert response.status == 200
        assert saved["settings"]["llm"]["model"] == "route-model"
        assert store.snapshot()["llm"]["model"] == "route-model"


async def test_provider_test_routes_exist(tmp_path: Path) -> None:
    store = SettingsStore(tmp_path / "settings.json")
    app = create_ryza_app(store, spine_dir=tmp_path / "missing")
    async with TestClient(TestServer(app)) as client:
        assert (await client.post("/app/test/llm", json={})).status == 503
        assert (await client.post("/app/test/tts", json={})).status == 503


async def test_custom_agent_events_and_pcm_cross_real_moka_socket(tmp_path: Path) -> None:
    class Agent:
        async def reply(self, _text):
            yield "[MOOD:happy.strong][HOLD:2400][MOTION:group:1]链路测试成功。"

        async def interrupt(self, _heard):
            return None

    frames = []
    store = SettingsStore(tmp_path / "settings.json")
    server = TestServer(create_ryza_app(
        store, spine_dir=tmp_path / "missing", agent_factory=Agent, tts=ToneTTS()
    ))
    await server.start_server()
    ws_url = str(server.make_url("/moka")).replace("http://", "ws://")
    try:
        async with MokaClient(ws_url, MOKA_TOKEN, on_audio=frames.append) as client:
            await client.send_model_info({
                "name": "test", "mouthParams": [], "expressions": [], "motions": ["group:1"],
                "primitives": {"mood": ["happy.strong"], "hold": ["2400"]},
            })
            await client.send_text("测试")
            end = await client.wait_for("reply.end", timeout=10)
            assert end.payload["utteranceCount"] == 1
            utterance = next(iter(client.utterances.values()))
            assert [event["type"] for event in utterance.events] == ["mood", "hold", "motion"]
            assert frames and sum(len(frame.pcm) for frame in frames) > 0
    finally:
        await server.close()


async def test_multiple_spoken_segments_keep_timed_moka_events(tmp_path: Path) -> None:
    class Agent:
        async def reply(self, _text):
            yield (
                "[HOLD:1800][MOTION:group:1]先挥挥手。"
                "[LOOK:user][HOLD:2400][MOTION:group:2]再伸个懒腰！"
            )

        async def interrupt(self, _heard):
            return None

    store = SettingsStore(tmp_path / "settings.json")
    server = TestServer(create_ryza_app(
        store, spine_dir=tmp_path / "missing", agent_factory=Agent, tts=ToneTTS()
    ))
    await server.start_server()
    ws_url = str(server.make_url("/moka")).replace("http://", "ws://")
    try:
        async with MokaClient(ws_url, MOKA_TOKEN) as client:
            await client.send_model_info({
                "name": "test", "motions": ["group:1", "group:2"],
                "primitives": {"look": ["user"], "hold": ["1800", "2400"]},
            })
            await client.send_text("连续表演")
            end = await client.wait_for("reply.end", timeout=10)
            utterance = next(iter(client.utterances.values()))
            assert end.payload["utteranceCount"] == 1
            assert utterance.text == "先挥挥手。再伸个懒腰！"
            assert [event["type"] for event in utterance.events] == ["hold", "motion", "look", "hold", "motion"]
            assert utterance.events[2]["ptsMs"] > 0
    finally:
        await server.close()


async def test_moka_displays_chinese_while_tts_receives_japanese(tmp_path: Path) -> None:
    class Agent:
        async def reply(self, _text):
            yield "[MOOD:happy.strong]欢迎回来。"

        async def interrupt(self, _heard):
            return None

    stream = io.BytesIO()
    with wave.open(stream, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24000)
        wav.writeframes(b"".join(struct.pack("<h", index % 100) for index in range(2400)))
    audio = stream.getvalue()
    tts_bodies: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if request.url.host == "llm.test":
            return httpx.Response(200, json={"choices": [{"message": {"content": "おかえりなさい。"}}]})
        tts_bodies.append(body)
        return httpx.Response(200, content=audio, headers={"content-type": "audio/wav"})

    store = SettingsStore(tmp_path / "settings.json")
    value = store.snapshot()
    value["llm"]["url"] = "https://llm.test/chat/completions"
    value["tts"]["speechMode"] = "zh-ja"
    value["tts"]["activeProfileId"] = "hf-ryza-asmr"
    value["tts"]["profiles"][1]["url"] = "https://tts.test/wav"
    store.update(value)
    router = CloudTTSRouter(store, transport=httpx.MockTransport(handler))
    frames = []
    server = TestServer(create_ryza_app(
        store, spine_dir=tmp_path / "missing", agent_factory=Agent, tts=router
    ))
    await server.start_server()
    ws_url = str(server.make_url("/moka")).replace("http://", "ws://")
    try:
        async with MokaClient(ws_url, MOKA_TOKEN, on_audio=frames.append) as client:
            await client.send_model_info({"name": "test", "primitives": {"mood": ["happy.strong"]}})
            await client.send_text("你好")
            await client.wait_for("reply.end", timeout=10)
            utterance = next(iter(client.utterances.values()))
            assert utterance.text == "欢迎回来。"
            assert utterance.events[0]["type"] == "mood"
            assert frames
            assert tts_bodies[0]["text"] == "おかえりなさい。"
            assert tts_bodies[0]["language"] == "ja"
    finally:
        await server.close()
