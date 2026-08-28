# Ryza external resource packs

The large game/media files and optional prebuilt sidecars are not stored in Git.
Upload the generated ZIP files in this directory to private cloud storage together
with `checksums.sha256`.

## Create packs

```powershell
.\scripts\pack-resources.ps1 -IncludeSidecars
```

Generated files:

- `ryza-media-2026-08-28.zip` — required media (`assets/`, Spine characters/objects/scenes).
- `ryza-sidecars-win-x64-2026-08-28.zip` — optional prebuilt Windows sidecars.
- `checksums.sha256` — SHA-256 verification values.

The ZIP files are ignored by Git. Keep `manifest.json`, this README and the checksum
file in the private source repository. Do not put `%APPDATA%\RyzaPet` or API keys in
these archives.
