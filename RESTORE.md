# Ryza Windows recovery

This repository contains source code, the active Ryza persona, build configuration
and pinned Clonoth/MOKAMOKA submodules. Large media and optional prebuilt sidecars
are distributed separately as private resource ZIP files.

## Required software

- Windows 10/11 x64 with Microsoft Edge WebView2
- Git
- Python 3.11 (`py -3.11`)
- Node.js with npm
- Rust stable with Cargo
- Visual Studio C++ Build Tools required by Tauri

## Fast recovery

1. Clone the private GitHub repository with submodules:

   ```powershell
   git clone --recurse-submodules https://github.com/RAMU324E/ryza-desktop-pet.git ryza_spine_all
   cd ryza_spine_all
   ```

2. Download these files from private cloud storage into `resource-packs/`:

   - `ryza-media-2026-08-28.zip` (required characters, objects, scenes and audio)
   - `ryza-sidecars-win-x64-2026-08-28.zip` (optional but faster)
   - `checksums.sha256`

3. Restore resources and dependencies:

   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\scripts\restore.ps1
   ```

4. Open the Ryza settings window and enter the LLM API key. Keys, conversations and
   Clonoth memory are intentionally not stored in Git.

5. Start development mode or build the installer:

   ```powershell
   npm run desktop:dev
   npm run desktop:build
   ```

Use `restore.ps1 -SkipDependencies` when the machine already has the prepared
`.venv` and npm dependencies. Use `restore.ps1 -Build` to build immediately after
restoration.

## Source version pins

- Clonoth: `7f9adbb6dd1ebce9f3664c6c6bcf55d351cb73bd`
- MOKAMOKA: `6bdaf86bf89616d863586bc4e98455f27c5be5cd`

`desktop/build_clonoth.py` applies Ryza-specific OpenAI-compatible Gemini patches to
a temporary staged copy. The Clonoth submodule itself must remain clean.

## Resource pack maintenance

Create new archives after changing game media or rebuilding sidecars:

```powershell
.\scripts\pack-resources.ps1 -IncludeSidecars
```

Upload the generated ZIP files and the updated `checksums.sha256` together. Keep the
archive names/version in `resource-packs/manifest.json` synchronized.

## Expected recovery behavior

The persona is restored from `moka_app/ryza_moka/default_prompt.md`. A sanitized
`config/settings.example.json` is copied to `%APPDATA%\RyzaPet\settings.json` only
when no settings file exists. Memory and chat history start empty on a new computer.
