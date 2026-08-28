from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

CLONOTH_COMMIT = "7f9adbb6dd1ebce9f3664c6c6bcf55d351cb73bd"
SOURCE_DIRS = ("supervisor", "engine", "providers", "toolbox", "clonoth_sdk", "plugins", "tools")
SOURCE_FILES = ("clonoth_runtime.py",)


def _bundle_source() -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS")) / "clonoth_source"
    return Path(__file__).resolve().parents[1] / "research" / "open-source" / "Clonoth"


def _config_source() -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS")) / "ryza_clonoth_config"
    return Path(__file__).resolve().with_name("clonoth_config")


def _state_root() -> Path:
    configured = os.environ.get("RYZA_CLONOTH_ROOT")
    if configured:
        return Path(configured)
    return Path(os.environ.get("APPDATA") or Path.home()) / "RyzaPet" / "clonoth"


def _copy_tree(source: Path, target: Path) -> None:
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(source, target, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))


def prepare_workspace() -> Path:
    source = _bundle_source()
    config_source = _config_source()
    root = _state_root()
    marker = root / ".ryza-clonoth-version"
    current = marker.read_text(encoding="utf-8").strip() if marker.exists() else ""
    if current != CLONOTH_COMMIT:
        root.mkdir(parents=True, exist_ok=True)
        for name in SOURCE_DIRS:
            _copy_tree(source / name, root / name)
        for name in SOURCE_FILES:
            shutil.copy2(source / name, root / name)
        marker.write_text(CLONOTH_COMMIT + "\n", encoding="utf-8")

    # Runtime policy updates with the app; node/provider/MCP data are only seeded.
    # Moka rewrites Ryza nodes from current settings without touching user memory.
    (root / "config" / "nodes").mkdir(parents=True, exist_ok=True)
    shutil.copy2(config_source / "runtime.yaml", root / "config" / "runtime.yaml")
    for node in (config_source / "nodes").glob("*.yaml"):
        target = root / "config" / "nodes" / node.name
        if not target.exists():
            shutil.copy2(node, target)
    data = root / "data"
    data.mkdir(parents=True, exist_ok=True)
    for name in ("config.yaml", "policy.yaml", "mcp_clients.yaml"):
        target = data / name
        if not target.exists():
            shutil.copy2(config_source / "data" / name, target)
    return root


def main() -> None:
    workspace = prepare_workspace()
    sys.path.insert(0, str(workspace))
    os.chdir(workspace)
    if len(sys.argv) >= 3 and sys.argv[1:3] == ["-m", "engine"]:
        del sys.argv[1:3]
        from engine.__main__ import main as engine_main
        engine_main()
        return
    from supervisor.main import main as supervisor_main
    supervisor_main()


if __name__ == "__main__":
    main()
