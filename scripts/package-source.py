"""Package a verified source export without importing the development worktree."""
import hashlib
import json
import pathlib
import sys
import zipfile

source = pathlib.Path(sys.argv[1]).resolve()
target = pathlib.Path(sys.argv[2]).resolve()
manifest = json.loads((source / "SOURCE_MANIFEST.json").read_text(encoding="utf-8"))
if manifest.get("format") != "zzgeo.full-source.v1":
    raise ValueError("Expected a full source manifest")
entries = []
for entry in manifest["files"]:
    path = (source / entry["path"]).resolve()
    if not path.is_relative_to(source) or path.is_symlink():
        raise ValueError("Unsafe source path")
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != entry["sha256"]:
        raise ValueError("Source checksum mismatch: " + entry["path"])
    entries.append((entry["path"], data))
target.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(target, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for name, data in entries:
        archive.writestr(name, data)
    archive.writestr("SOURCE_MANIFEST.json", (source / "SOURCE_MANIFEST.json").read_bytes())
digest = hashlib.sha256(target.read_bytes()).hexdigest()
target.with_suffix(target.suffix + ".sha256").write_text(digest + "  " + target.name + "\n", encoding="ascii")
target.with_suffix(target.suffix + ".manifest.json").write_bytes((source / "SOURCE_MANIFEST.json").read_bytes())
print(f"Packaged {len(entries)} files: {target.name}, SHA-256 {digest}")
