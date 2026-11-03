#!/usr/bin/env python3
"""Rebuild the self-contained CityRA.html from index.html + js/*.js.

The game has no runtime build step: index.html loads the source files, while
CityRA.html is the same page with those scripts inlined for double-click use.
Run this after editing anything in js/ so the two entry points stay in sync.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
INDEX = ROOT / "index.html"
OUTPUT = ROOT / "CityRA.html"
SCRIPT_TAG = re.compile(r'<script src="(js/[A-Za-z0-9_]+\.js)\?v=[^"]+"></script>')


def inline(match: re.Match) -> str:
    name = match.group(1)
    source = (ROOT / name).read_text(encoding="utf-8").rstrip("\n")
    return f"<script>/* {name} */\n{source}\n</script>"


def main() -> None:
    html = INDEX.read_text(encoding="utf-8")
    bundled = SCRIPT_TAG.sub(inline, html)
    OUTPUT.write_text(bundled, encoding="utf-8")
    print(f"Wrote {OUTPUT.name} ({len(bundled):,} bytes) from {len(SCRIPT_TAG.findall(html))} scripts")


if __name__ == "__main__":
    main()
