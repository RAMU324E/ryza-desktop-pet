from __future__ import annotations

import asyncio
import json
import os
import re
import tempfile
import uuid
from pathlib import Path
from typing import Any

import httpx
import yaml
from mokamoka.vendor.clonoth_sdk import ClonothClient

from .settings import SettingsStore, llm_extra_body

CLONOTH_URL = "http://127.0.0.1:18767"
CLONOTH_TOKEN = "ryza-local-clonoth"
_IMAGE_MARKER = re.compile(r"^\[\[RYZA_IMAGE:(.+?)\]\]\n?", re.S)


def clonoth_root() -> Path:
    configured = os.environ.get("RYZA_CLONOTH_ROOT")
    if configured:
        return Path(configured)
    return Path(os.environ.get("APPDATA") or Path.home()) / "RyzaPet" / "clonoth"


def _atomic_yaml(path: Path, value: dict[str, Any]) -> bool:
    text = yaml.safe_dump(value, sort_keys=False, allow_unicode=True)
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
    except Exception:
        Path(temp_name).unlink(missing_ok=True)
        raise
    return True


def _provider(value: dict[str, Any]) -> tuple[str, str]:
    url = str(value.get("url") or "").strip().rstrip("/")
    mode = str(value.get("apiMode") or "auto").strip().lower()
    if mode == "responses" or url.endswith("/responses"):
        return "openai-responses", url.removesuffix("/responses")
    base = url.removesuffix("/chat/completions")
    if "deepseek.com" in base.lower() or str(value.get("model") or "").lower().startswith("deepseek"):
        return "deepseek", base
    return "openai", base


def _node(node_id: str, prompt: str, provider: dict[str, Any] | None = None) -> dict[str, Any]:
    value: dict[str, Any] = {
        "id": node_id,
        "type": "ai",
        "name": "Ryza Vision" if node_id.endswith("vision") else "Ryza",
        "memory_book": "ryza",
        "persistent": True,
        "tool_access": {"mode": "all"},
        "skills": {"mode": "none"},
        "memories": {"mode": "all"},
        "tool_mode": "native",
        "output_mode": "hybrid",
        "prompt": prompt,
    }
    if provider:
        provider_name, base_url = _provider(provider)
        value.update({
            "provider": provider_name,
            "base_url": base_url,
            "api_key": str(provider.get("key") or ""),
            "model": str(provider.get("model") or ""),
        })
        extra_body = llm_extra_body(provider)
        if extra_body:
            value["provider_options"] = {"extra_body": extra_body}
    return value


def sync_clonoth_settings(store: SettingsStore) -> bool:
    settings = store.snapshot()
    llm = settings["llm"]
    provider_name, base_url = _provider(llm)
    config = {
        "version": 1,
        "provider": provider_name,
        "openai": {"base_url": "", "api_key": "", "model": ""},
        provider_name: {
            "base_url": base_url,
            "api_key": llm.get("key", ""),
            "model": llm.get("model", ""),
        },
    }
    persona_prompt = str(settings.get("systemPrompt") or "").split("你必须只输出一个 JSON 对象", 1)[0].strip()
    prompt = (
        persona_prompt
        + "\n\n只输出给用户看的自然回复正文。不要输出 JSON、动作标签、控制标记或隐藏推理。"
    ).strip()
    vision = settings.get("agent", {}).get("vision", {})
    vision_provider = vision if vision.get("enabled") else None
    vision_prompt = prompt + "\n收到截图时，先观察截图再回答用户。"

    root = clonoth_root()
    changed = _atomic_yaml(root / "data" / "config.yaml", config)
    changed |= _atomic_yaml(root / "config" / "nodes" / "ryza.chat.yaml", _node("ryza.chat", prompt, llm))
    changed |= _atomic_yaml(root / "config" / "nodes" / "ryza.vision.yaml", _node("ryza.vision", vision_prompt, vision_provider))

    mcp = settings.get("agent", {}).get("mcp", {})
    clients: dict[str, Any] = {}
    if mcp.get("enabled") and str(mcp.get("url") or "").strip():
        headers = json.loads(str(mcp.get("headers") or "{}"))
        clients["search"] = {
            "transport": "streamable_http",
            "enabled": True,
            "description": "Ryza configured search MCP",
            "url": str(mcp["url"]).strip(),
            "headers": {str(key): str(value) for key, value in headers.items()},
        }
    changed |= _atomic_yaml(root / "data" / "mcp_clients.yaml", {"version": 1, "clients": clients})
    return changed


async def reload_clonoth_runtime() -> bool:
    client = ClonothClient(CLONOTH_URL, timeout=5.0, admin_token=CLONOTH_TOKEN)
    try:
        for attempt in range(12):
            try:
                await client.get_health()
                async with httpx.AsyncClient(
                    timeout=5.0,
                    headers={"Authorization": f"Bearer {CLONOTH_TOKEN}"},
                ) as http:
                    config = await http.post(f"{CLONOTH_URL}/v1/config/reload")
                    config.raise_for_status()
                    tools = await http.post(f"{CLONOTH_URL}/v1/tools/reload")
                    tools.raise_for_status()
                return True
            except Exception:
                if attempt == 11:
                    return False
                await asyncio.sleep(0.25)
        return False
    finally:
        await client.close()


class ClonothRuntimeClient:
    def __init__(self, store: SettingsStore):
        self.store = store
        self.conversation_key = f"ryza:{uuid.uuid4()}"
        self.active_session_id = ""

    def _request(self, text: str) -> tuple[str, list[dict[str, Any]], str]:
        match = _IMAGE_MARKER.match(text)
        if not match:
            return text, [], "ryza.chat"
        raw_path = Path(match.group(1).strip())
        clean_text = text[match.end():].lstrip()
        try:
            relative = raw_path.resolve().relative_to(clonoth_root().resolve()).as_posix()
        except ValueError:
            return clean_text, [], "ryza.chat"
        if not relative.startswith("data/") or not raw_path.is_file():
            return clean_text, [], "ryza.chat"
        attachment = {
            "path": relative,
            "name": raw_path.name,
            "type": "image",
            "mime_type": "image/png",
        }
        return clean_text, [attachment], "ryza.vision"

    async def reply(self, text: str) -> str:
        sync_clonoth_settings(self.store)
        clean_text, attachments, node_id = self._request(text)
        client = ClonothClient(CLONOTH_URL, timeout=10.0, admin_token=CLONOTH_TOKEN)
        try:
            await client.get_health()
            previous = await client.poll_events(after_seq=0, limit=5000)
            cursor = max((event.seq for event in previous), default=0)
            inbound = {
                "channel": "ryza_desktop",
                "conversation_key": self.conversation_key,
                "text": clean_text,
                "use_context": True,
                "entry_node_id": node_id,
                "use_branch": False,
            }
            if attachments:
                inbound["attachments"] = attachments
            async with httpx.AsyncClient(timeout=10.0) as http:
                response = await http.post(
                    f"{CLONOTH_URL}/v1/inbound",
                    headers={"Authorization": f"Bearer {CLONOTH_TOKEN}"},
                    json=inbound,
                )
                response.raise_for_status()
                result = response.json()
            session_id = str(result.get("session_id") or "")
            self.active_session_id = session_id
            inbound_seq = int(result.get("inbound_seq") or 0)
            deadline = asyncio.get_running_loop().time() + float(self.store.snapshot()["llm"]["timeout"]) + 10
            while asyncio.get_running_loop().time() < deadline:
                events = await client.poll_events(after_seq=cursor, limit=5000)
                for event in events:
                    cursor = max(cursor, event.seq)
                    if event.session_id != session_id:
                        continue
                    payload = event.payload or {}
                    if event.type == "outbound_message" and payload.get("source_inbound_seq") in (None, inbound_seq):
                        final = str(payload.get("text") or "").strip()
                        if final:
                            try:
                                structured = json.loads(final)
                            except json.JSONDecodeError:
                                structured = None
                            if isinstance(structured, dict) and isinstance(structured.get("text"), str) and any(
                                key in structured for key in ("emotion", "attitude", "action", "beats")
                            ):
                                final = structured["text"].strip()
                            return final
                    if event.type in {"task_cancelled", "task_failed"}:
                        raise RuntimeError(str(payload.get("error") or "Clonoth task failed"))
                    if event.type == "task_completed" and payload.get("status") in {"failed", "cancelled"}:
                        raise RuntimeError(str(payload.get("error") or payload.get("status")))
                await asyncio.sleep(0.2)
            raise TimeoutError("Clonoth reply timed out")
        finally:
            self.active_session_id = ""
            await client.close()

    async def interrupt(self) -> None:
        if not self.active_session_id:
            return
        client = ClonothClient(CLONOTH_URL, timeout=5.0, admin_token=CLONOTH_TOKEN)
        try:
            await client.cancel_active_tasks(self.active_session_id)
        except Exception:
            pass
        finally:
            await client.close()
