#!/usr/bin/env python3
"""Copy the noslop detector into the worker and wrap it as an ES module.

The detector is the private asset this whole product rests on, so it is NOT
committed here (worker/src/detector-core.js is gitignored). This script pulls
it from the noslop repo and appends the module export shim. Run it after any
noslop update, before deploying the worker.

  python3 tools/sync_detector.py
"""
import hashlib
import pathlib
import sys

SRC = pathlib.Path.home() / "Projects" / "noslop" / "web" / "detector.js"
DST = pathlib.Path(__file__).resolve().parent.parent / "worker" / "src" / "detector-core.js"

SHIM = """
// --- appended by tools/sync_detector.py: ES module export shim ---
// The UMD above set globalThis.Noslop; re-export it for module imports.
export default globalThis.Noslop;
"""


def main():
    if not SRC.exists():
        sys.exit(f"noslop detector not found at {SRC}")
    body = SRC.read_text()
    if "globalThis" not in body:
        sys.exit("detector.js does not look like the UMD build this shim expects")
    DST.write_text(body + SHIM)
    digest = hashlib.sha256(body.encode()).hexdigest()[:12]
    print(f"synced {SRC} -> {DST}")
    print(f"source sha256[:12] = {digest}  ({len(body)//1024} KB)")


if __name__ == "__main__":
    main()
