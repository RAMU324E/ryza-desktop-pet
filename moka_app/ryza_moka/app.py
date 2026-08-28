from __future__ import annotations

import argparse
import logging
import os
import socket
import subprocess
import sys
from pathlib import Path
from typing import Awaitable, Callable

from aiohttp import web
from mokamoka import Config, EchoAgentSource, create_app
from mokamoka.tts import create_backend

from .agent import RyzaClonothAgentSource
from .clonoth import reload_clonoth_runtime, sync_clonoth_settings
from .settings import SettingsError, SettingsStore
from .tts import CloudTTSRouter

HOST = "127.0.0.1"
PORT = 18766
MOKA_TOKEN = "ryza-local"
JsonTest = Callable[[dict], Awaitable[dict]]


def project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _start_dev_clonoth(root: Path) -> subprocess.Popen | None:
    if getattr(sys, "frozen", False):
        return None
    try:
        with socket.create_connection(("127.0.0.1", 18767), timeout=0.15):
            return None
    except OSError:
        pass
    entry = root / "desktop" / "clonoth_entry.py"
    if not entry.is_file():
        return None
    return subprocess.Popen(
        [sys.executable, str(entry), "--host", "127.0.0.1", "--port", "18767", "--log-level", "warning"],
        cwd=root,
        env={**os.environ, "CLONOTH_ADMIN_TOKEN": "ryza-local-clonoth"},
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=0x08000000,
    )


def _stop_process_tree(process: subprocess.Popen | None) -> None:
    if process is None or process.poll() is not None:
        return
    subprocess.run(
        ["taskkill", "/PID", str(process.pid), "/T", "/F"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
        creationflags=0x08000000,
    )


def create_ryza_app(
    store: SettingsStore,
    *,
    spine_dir: Path | None = None,
    media_dir: Path | None = None,
    agent_factory=None,
    tts=None,
    test_llm: JsonTest | None = None,
    test_tts: JsonTest | None = None,
    host: str = HOST,
    port: int = PORT,
    manage_clonoth: bool = False,
) -> web.Application:
    active = store.active_tts()
    cfg = Config(
        host=host,
        port=port,
        ws_path="/moka",
        token=MOKA_TOKEN,
        tts_backend="tone",
        tts_concurrency=int(active.get("concurrency", 1)),
        agent_timeout_sec=float(store.snapshot()["llm"]["timeout"]) * 2 + 20,
        data_dir=str(store.path.parent),
    )
    app = create_app(
        cfg,
        agent_factory=agent_factory or EchoAgentSource,
        tts=tts or create_backend(cfg),
    )

    @web.middleware
    async def allow_local_desktop(request: web.Request, handler) -> web.StreamResponse:
        response = web.Response() if request.method == "OPTIONS" else await handler(request)
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        response.headers["Access-Control-Allow-Methods"] = "GET, PUT, POST, OPTIONS"
        return response

    app.middlewares.append(allow_local_desktop)

    async def health(_: web.Request) -> web.Response:
        return web.json_response({
            "ok": True,
            "moka": {"url": f"ws://{host}:{port}/moka", "token": MOKA_TOKEN},
            "settingsPath": str(store.path),
            "llm": {
                "name": store.snapshot()["llm"]["name"],
                "model": store.snapshot()["llm"]["model"],
                "configured": bool(store.snapshot()["llm"]["url"]),
            },
            "agent": {
                "source": store.snapshot()["agent"]["source"],
                "vision": {
                    "enabled": store.snapshot()["agent"]["vision"]["enabled"],
                    "model": store.snapshot()["agent"]["vision"]["model"],
                },
                "mcp": {"enabled": store.snapshot()["agent"]["mcp"]["enabled"]},
            },
            "tts": {
                "id": store.active_tts()["id"],
                "name": store.active_tts()["name"],
                "adapter": store.active_tts()["adapter"],
                "speechMode": store.snapshot()["tts"]["speechMode"],
            },
            "character": store.snapshot()["character"],
            "performance": store.snapshot()["performance"],
        })

    async def get_settings(_: web.Request) -> web.Response:
        return web.json_response(store.snapshot())

    async def put_settings(request: web.Request) -> web.Response:
        try:
            value = await request.json()
            saved = store.update(value)
            active_profile = store.active_tts()
            cfg.tts_concurrency = int(active_profile.get("concurrency", 1))
            cfg.agent_timeout_sec = float(saved["llm"]["timeout"]) * 2 + 20
            if manage_clonoth:
                clonoth_changed = sync_clonoth_settings(store)
                if clonoth_changed:
                    await reload_clonoth_runtime()
            return web.json_response({"ok": True, "settings": saved})
        except (SettingsError, ValueError, TypeError, web.HTTPException) as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)

    async def run_test(request: web.Request, callback: JsonTest | None, label: str) -> web.Response:
        if callback is None:
            return web.json_response({"ok": False, "error": f"{label} 测试将在 Provider 插件接入后启用"}, status=503)
        try:
            payload = await request.json()
            return web.json_response({"ok": True, **await callback(payload)})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)

    if manage_clonoth:
        clonoth_changed = sync_clonoth_settings(store)

        async def sync_runtime(_: web.Application) -> None:
            if clonoth_changed:
                await reload_clonoth_runtime()

        app.on_startup.append(sync_runtime)

    app.router.add_get("/app/health", health)
    app.router.add_get("/app/settings", get_settings)
    app.router.add_put("/app/settings", put_settings)
    app.router.add_post("/app/settings", put_settings)
    async def test_llm_handler(request: web.Request) -> web.Response:
        return await run_test(request, test_llm, "LLM")

    async def test_tts_handler(request: web.Request) -> web.Response:
        return await run_test(request, test_tts, "TTS")

    app.router.add_post("/app/test/llm", test_llm_handler)
    app.router.add_post("/app/test/tts", test_tts_handler)

    media_root = media_dir or project_root() / "assets"
    if media_root.exists():
        app.router.add_static("/media/", media_root, show_index=False)

    web_root = spine_dir or project_root() / "spine"
    if web_root.exists():
        async def index(_: web.Request) -> web.StreamResponse:
            return web.FileResponse(web_root / "index.html")

        app.router.add_get("/", index)
        app.router.add_static("/", web_root, show_index=False)
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="Ryza MOKAMOKA desktop host")
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--settings", type=Path)
    parser.add_argument("--spine", type=Path)
    parser.add_argument("--media", type=Path)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    root = project_root()
    store = SettingsStore(args.settings, legacy_path=root / "bridge" / "settings.json")
    clonoth_process = _start_dev_clonoth(root)
    tts = CloudTTSRouter(store)

    def agent_factory() -> RyzaClonothAgentSource:
        return RyzaClonothAgentSource(store)

    async def test_llm(payload: dict) -> dict:
        return await RyzaClonothAgentSource(store).test(payload)

    app = create_ryza_app(
        store,
        spine_dir=args.spine,
        media_dir=args.media,
        agent_factory=agent_factory,
        tts=tts,
        test_llm=test_llm,
        test_tts=tts.test,
        host=args.host,
        port=args.port,
        manage_clonoth=True,
    )
    try:
        web.run_app(app, host=args.host, port=args.port, print=lambda text: logging.getLogger("ryza_moka").info(text))
    finally:
        _stop_process_tree(clonoth_process)


if __name__ == "__main__":
    main()
