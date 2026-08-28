from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

from PyInstaller.__main__ import run as pyinstaller_run

ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = ROOT / "research" / "open-source" / "Clonoth"
EXPECTED_COMMIT = "7f9adbb6dd1ebce9f3664c6c6bcf55d351cb73bd"
STAGE = ROOT / ".tmp" / "clonoth-runtime-source"
DIST = ROOT / "desktop" / "src-tauri" / "bin"


def patch_openai_provider(root: Path) -> None:
    path = root / "providers" / "openai.py"
    text = path.read_text(encoding="utf-8")
    replacements = [
        (
            "        model: str,\n    ) -> None:\n",
            "        model: str,\n        provider_options: dict[str, Any] | None = None,\n    ) -> None:\n",
            1,
        ),
        (
            "        self._base_url = _normalize_base_url(base_url)\n",
            "        self._base_url = _normalize_base_url(base_url)\n"
            "        extra_body = (provider_options or {}).get(\"extra_body\")\n"
            "        self._extra_body = dict(extra_body) if isinstance(extra_body, dict) else {}\n",
            1,
        ),
        (
            "        if tools:\n            payload[\"tools\"] = tools\n            payload[\"tool_choice\"] = \"auto\"\n\n        headers = {\n",
            "        if tools:\n            payload[\"tools\"] = tools\n            payload[\"tool_choice\"] = \"auto\"\n"
            "        payload.update(self._extra_body)\n\n        headers = {\n",
            2,
        ),
    ]
    for old, new, count in replacements:
        if text.count(old) != count:
            raise RuntimeError(f"unexpected Clonoth openai.py patch target: {old[:40]!r}")
        text = text.replace(old, new)
    path.write_text(text, encoding="utf-8", newline="\n")


def patch_gemini_oai_compat(root: Path) -> None:
    openai = root / "providers" / "openai.py"
    text = openai.read_text(encoding="utf-8")
    helpers = '''

_GEMINI_SIGNATURE_SENTINEL = "skip_thought_signature_validator"


def _sanitize_gemini_schema(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _sanitize_gemini_schema(item)
            for key, item in value.items()
            if key not in {"propertyNames", "multipleOf"}
        }
    if isinstance(value, list):
        return [_sanitize_gemini_schema(item) for item in value]
    return value


def _find_thought_signature(value: Any) -> str:
    if not isinstance(value, dict):
        return ""
    for key, item in value.items():
        if key in {"thought_signature", "thoughtSignature"} and isinstance(item, str) and item:
            return item
    for item in value.values():
        signature = _find_thought_signature(item)
        if signature:
            return signature
    return ""


def _prepare_gemini_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    cleaned = [
        message for message in messages
        if message.get("tool_calls") or message.get("content") not in (None, "", [])
    ]
    calls = [
        call
        for message in cleaned if message.get("role") == "assistant"
        for call in (message.get("tool_calls") or []) if isinstance(call, dict)
    ]
    if calls and not any(_find_thought_signature(call) for call in calls):
        for call in calls:
            call["extra_content"] = {
                "google": {"thoughtSignature": _GEMINI_SIGNATURE_SENTINEL}
            }
    return cleaned
'''
    patches = [
        ("\n\n\nclass OpenAIProvider", helpers + "\n\nclass OpenAIProvider", 1),
        (
            "        self._gemini_compat = \"gemini\" in model.lower()\n",
            "        self._gemini_compat = \"gemini\" in model.lower()\n",
            0,
        ),
    ]
    if "self._gemini_compat" not in text:
        patches[1] = (
            "        self._extra_body = dict(extra_body) if isinstance(extra_body, dict) else {}\n",
            "        self._extra_body = dict(extra_body) if isinstance(extra_body, dict) else {}\n"
            "        self._gemini_compat = \"gemini\" in model.lower()\n",
            1,
        )
    patches.extend([
        (
            "        prepared = self._prepare_messages(messages)\n\n        payload: dict[str, Any] = {\n",
            "        prepared = self._prepare_messages(messages)\n"
            "        if self._gemini_compat:\n"
            "            prepared = _prepare_gemini_messages(prepared)\n\n"
            "        payload: dict[str, Any] = {\n",
            2,
        ),
        (
            "        if tools:\n            payload[\"tools\"] = tools\n            payload[\"tool_choice\"] = \"auto\"\n        payload.update(self._extra_body)\n",
            "        if tools:\n"
            "            payload[\"tools\"] = _sanitize_gemini_schema(tools) if self._gemini_compat else tools\n"
            "            payload[\"tool_choice\"] = \"auto\"\n"
            "        payload.update(self._extra_body)\n",
            2,
        ),
        (
            "                                    \"arg_parts\": [],\n",
            "                                    \"arg_parts\": [],\n"
            "                                    \"thought_signature\": \"\",\n",
            1,
        ),
        (
            "                            arg_chunk = fn.get(\"arguments\", \"\")\n",
            "                            signature = _find_thought_signature(tc)\n"
            "                            if signature:\n"
            "                                tc_map[idx][\"thought_signature\"] = signature\n"
            "                            arg_chunk = fn.get(\"arguments\", \"\")\n",
            1,
        ),
        (
            "                    tool_calls.append(ToolCall(id=tc_data[\"id\"], name=name.strip(), arguments=args))\n",
            "                    tool_calls.append(ToolCall(\n"
            "                        id=tc_data[\"id\"], name=name.strip(), arguments=args,\n"
            "                        thought_signature=tc_data[\"thought_signature\"],\n"
            "                    ))\n",
            1,
        ),
        (
            "                    tool_calls.append(ToolCall(id=tc_id_str, name=name.strip(), arguments=args))\n",
            "                    tool_calls.append(ToolCall(\n"
            "                        id=tc_id_str, name=name.strip(), arguments=args,\n"
            "                        thought_signature=_find_thought_signature(tc),\n"
            "                    ))\n",
            1,
        ),
    ])
    for old, new, count in patches:
        if count == 0:
            continue
        if text.count(old) != count:
            raise RuntimeError(f"unexpected Gemini OpenAI patch target: {old[:50]!r}")
        text = text.replace(old, new)
    openai.write_text(text, encoding="utf-8", newline="\n")

    base = root / "providers" / "base.py"
    text = base.read_text(encoding="utf-8")
    old = "    arguments: dict[str, Any]\n\n    def __post_init__(self):\n"
    new = "    arguments: dict[str, Any]\n    thought_signature: str = \"\"\n\n    def __post_init__(self):\n"
    if text.count(old) != 1:
        raise RuntimeError("unexpected Clonoth ToolCall patch target")
    base.write_text(text.replace(old, new), encoding="utf-8", newline="\n")

    formatter = root / "engine" / "inference" / "tool_format.py"
    text = formatter.read_text(encoding="utf-8")
    old = '''            msg["tool_calls"] = [
                {"id": tc.id, "name": tc.name, "arguments": dict(tc.arguments or {})}
                for tc in tool_calls
            ]
'''
    new = '''            msg["tool_calls"] = []
            for tc in tool_calls:
                item = {"id": tc.id, "name": tc.name, "arguments": dict(tc.arguments or {})}
                if getattr(tc, "thought_signature", ""):
                    item["thought_signature"] = tc.thought_signature
                msg["tool_calls"].append(item)
'''
    if text.count(old) != 1:
        raise RuntimeError("unexpected assistant tool-call storage patch target")
    text = text.replace(old, new)
    old = '''                    api_calls.append({
                        'id': tc.get('id', ''),
                        'type': 'function',
                        'function': {
                            'name': tc.get('name', ''),
                            'arguments': args_str,
                        },
                    })
'''
    new = '''                    api_call = {
                        'id': tc.get('id', ''),
                        'type': 'function',
                        'function': {
                            'name': tc.get('name', ''),
                            'arguments': args_str,
                        },
                    }
                    signature = tc.get('thought_signature')
                    if isinstance(signature, str) and signature:
                        api_call['extra_content'] = {'google': {'thoughtSignature': signature}}
                    api_calls.append(api_call)
'''
    if text.count(old) != 1:
        raise RuntimeError("unexpected native tool-call replay patch target")
    formatter.write_text(text.replace(old, new), encoding="utf-8", newline="\n")


def main() -> None:
    commit = subprocess.check_output(
        ["git", "-C", str(UPSTREAM), "rev-parse", "HEAD"], text=True
    ).strip()
    status = subprocess.check_output(
        ["git", "-C", str(UPSTREAM), "status", "--short"], text=True
    ).strip()
    if commit != EXPECTED_COMMIT or status:
        raise SystemExit("Clonoth upstream checkout is not the pinned clean commit")

    shutil.rmtree(STAGE, ignore_errors=True)
    STAGE.mkdir(parents=True)
    for name in ("supervisor", "engine", "providers", "toolbox", "clonoth_sdk", "plugins", "tools"):
        shutil.copytree(
            UPSTREAM / name,
            STAGE / name,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )
    shutil.copy2(UPSTREAM / "clonoth_runtime.py", STAGE / "clonoth_runtime.py")
    patch_openai_provider(STAGE)
    patch_gemini_oai_compat(STAGE)

    target = DIST / "ryza-clonoth"
    shutil.rmtree(target, ignore_errors=True)
    pyinstaller_run([
        "--noconfirm", "--clean", "--onedir", "--name", "ryza-clonoth",
        "--distpath", str(DIST),
        "--workpath", str(ROOT / ".tmp" / "pyinstaller" / "clonoth-work"),
        "--specpath", str(ROOT / ".tmp" / "pyinstaller"),
        "--paths", str(UPSTREAM),
        "--collect-submodules", "supervisor",
        "--collect-submodules", "engine",
        "--collect-submodules", "providers",
        "--collect-submodules", "toolbox",
        "--collect-submodules", "clonoth_sdk",
        "--hidden-import", "mcp",
        "--hidden-import", "mcp.client.sse",
        "--hidden-import", "mcp.client.stdio",
        "--hidden-import", "mcp.client.streamable_http",
        "--add-data", f"{STAGE};clonoth_source",
        "--add-data", f"{ROOT / 'desktop' / 'clonoth_config'};ryza_clonoth_config",
        str(ROOT / "desktop" / "clonoth_entry.py"),
    ])


if __name__ == "__main__":
    main()
