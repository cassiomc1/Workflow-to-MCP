"""Deterministic extension archive: stable ordering, metadata and timestamps."""
from pathlib import Path
import json
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
root = Path("dist/extension")
version = json.loads(Path("package.json").read_text())["version"]
with ZipFile(f"artifacts/workflow-to-mcp-extension-{version}.zip", "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        info = ZipInfo(path.relative_to(root).as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, path.read_bytes(), compresslevel=9)
