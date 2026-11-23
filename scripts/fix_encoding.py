"""Repair UTF-8 mojibake introduced by a PowerShell round-trip, and strip BOMs."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {".git", "node_modules", ".next", "dist", ".npm-cache", ".pnpm-store", ".tools"}
EXTS = {".ts", ".tsx", ".md", ".sql", ".json", ".yml", ".yaml", ".py", ".css", ".mjs", ".toml", ".txt"}
REPLACEMENTS = [
    ("\u00e2\u20ac\u201d", "\u2014"),  # em dash
    ("\u00e2\u20ac\u201c", "\u2013"),  # en dash
    ("\u00e2\u20ac\u00a6", "\u2026"),  # ellipsis
    ("\u00c2\u00b7", "\u00b7"),        # middle dot
    ("\u00c2\u00a0", " "),             # nbsp
]

changed: list[str] = []
for path in ROOT.rglob("*"):
    if not path.is_file() or path.suffix not in EXTS:
        continue
    if any(part in SKIP_DIRS for part in path.parts):
        continue
    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        continue
    original = text
    if text.startswith("\ufeff"):
        text = text.lstrip("\ufeff")
    for bad, good in REPLACEMENTS:
        text = text.replace(bad, good)
    if text != original:
        path.write_text(text, encoding="utf-8", newline="")
        changed.append(str(path.relative_to(ROOT)))

print("repaired", len(changed), "file(s)")
for name in changed:
    print(" ", name)
