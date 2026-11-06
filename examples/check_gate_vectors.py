#!/usr/bin/env python3
"""
Runs the Python gate over the conformance vectors in arkiv/vectors/gate.json. Our own gate is held to the same file in
packages/core/test/vectors.test.ts, so passing here means the two decide alike. To check your own implementation, in
any language, do what this does.

    python examples/check_gate_vectors.py
"""

import json
import sys
from pathlib import Path

from ceasenet_gate import decide, normal_input, recall_covers

VECTORS = Path(__file__).resolve().parent.parent / "arkiv" / "vectors" / "gate.json"


def main():
    vectors = json.loads(VECTORS.read_text(encoding="utf-8"))
    failures = 0
    for v in vectors["decide"]:
        got = dict(zip(("agent", "verdict"), decide(normal_input(v["input"]), v["ask"])))
        if got != v["expect"]:
            failures += 1
            print(f"FAIL {v['id']}: expected {v['expect']}, got {got}")
    for v in vectors["covers"]:
        got = recall_covers(v["recall"], v["file"])
        if got != v["covers"]:
            failures += 1
            print(f"FAIL {v['id']}: expected {v['covers']}, got {got}")
    total = len(vectors["decide"]) + len(vectors["covers"])
    print(f"{total - failures} of {total} vectors give the verdict the rules state")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
