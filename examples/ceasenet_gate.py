#!/usr/bin/env python3
"""
A CeaseNet gate in Python, using the standard library and none of this project's code.

It asks one question: may this agent call this tool right now? It reads the public recall list from Arkiv over plain
JSON-RPC and applies the rules in arkiv/schema.md, and check_gate_vectors.py holds it to the same conformance vectors
as our own gate. So if this project disappears, the list and the rules still work.

    python examples/ceasenet_gate.py --owner 0x... --hash 0x...
    python examples/ceasenet_gate.py --owner 0x... --agent 0x... --tool some-package 1.2.3 0x...

It exits 0 if the call may go ahead, 1 if it may not, 4 if it needs a person, and 3 if the list cannot be read, which a
real gate must not treat as permission.

Our own gate does two more things that need a place to keep state. It remembers every STOP it has seen, so that one
deleted from the list stays in force, and it times how long the list has been out of reach, which is what the
`connectivity` input to evaluate() is for. This example reads the live list once, so it has neither.
"""

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request

PUBLIC_RPC = "https://rpc.rabdi.db-chain.testnet.arkiv.network/"
CHAIN_ID = 7794095
PAGE = 100
# Blocks come every 2 seconds, so a node whose newest block is older than this is not serving the live list.
MAX_LIST_AGE_SECONDS = 120
CONFIRMATION_THRESHOLD = 3
CONFIRMATION_WINDOW_BLOCKS = 72 * 3600 // 2
GRACE_MS = OFFLINE_SUPERVISED_MS = 300_000


# ---- Version ranges, as npm reads them ----

VERSION = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$")
PARTIAL = re.compile(r"^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$")


def parse_version(text):
    """(major, minor, patch, prerelease identifiers), or None if it is not a version."""
    m = VERSION.match(text.strip())
    if not m:
        return None
    return int(m[1]), int(m[2]), int(m[3]), tuple(m[4].split(".")) if m[4] else ()


def compare(a, b):
    if a[:3] != b[:3]:
        return -1 if a[:3] < b[:3] else 1
    # A prerelease comes before its release.
    if not a[3] or not b[3]:
        return (not a[3]) - (not b[3])
    for x, y in zip(a[3], b[3]):
        if x == y:
            continue
        xn, yn = x.isdigit(), y.isdigit()
        if xn and yn:
            return -1 if int(x) < int(y) else 1
        if xn != yn:
            return -1 if xn else 1
        return -1 if x < y else 1
    return (len(a[3]) > len(b[3])) - (len(a[3]) < len(b[3]))


def partial(text):
    """(major, minor, patch, prerelease), with None for each part left open, or raises ValueError."""
    m = PARTIAL.match(text)
    if not m:
        raise ValueError(text)
    parts = [None if p is None or p in "xX*" else int(p) for p in (m[1], m[2], m[3])]
    return parts[0], parts[1], parts[2], tuple(m[4].split(".")) if m[4] else ()


def floor(major, minor, patch, pre=()):
    return (major or 0, minor or 0, patch or 0, pre)


# The lowest prerelease there is, so that "<2.0.0" means below every 2.0.0 prerelease too.
LOWEST = ("0",)


def expand_comparator(op, text):
    """One comparator as a list of simple (op, version) tests."""
    major, minor, patch, pre = partial(text)
    if op == "^":
        if major is None:
            return []
        low = (">=", floor(major, minor, patch, pre))
        if major > 0 or minor is None:
            return [low, ("<", (major + 1, 0, 0, LOWEST))]
        if minor > 0 or patch is None:
            return [low, ("<", (0, minor + 1, 0, LOWEST))]
        return [low, ("<", (0, 0, patch + 1, LOWEST))]
    if op == "~":
        if major is None:
            return []
        low = (">=", floor(major, minor, patch, pre))
        if minor is None:
            return [low, ("<", (major + 1, 0, 0, LOWEST))]
        return [low, ("<", (major, minor + 1, 0, LOWEST))]
    if op in ("", "="):
        if major is None:
            return []
        if minor is None:
            return [(">=", (major, 0, 0, ())), ("<", (major + 1, 0, 0, LOWEST))]
        if patch is None:
            return [(">=", (major, minor, 0, ())), ("<", (major, minor + 1, 0, LOWEST))]
        return [("=", (major, minor, patch, pre))]
    if major is None:
        # Anything is at least nothing; nothing is outside everything.
        return [] if op in (">=", "<=") else [("<", (0, 0, 0, LOWEST))]
    if minor is None or patch is None:
        # An open version is its whole span, so ">1.2" means above all of 1.2 and "<=1.2" means up to the end of it.
        next_up = (major + 1, 0, 0, LOWEST) if minor is None else (major, minor + 1, 0, LOWEST)
        return {
            ">": [(">=", next_up)],
            ">=": [(">=", floor(major, minor, patch))],
            "<": [("<", (*floor(major, minor, patch)[:3], LOWEST))],
            "<=": [("<", next_up)],
        }[op]
    return [(op, (major, minor, patch, pre))]


def read_range(text):
    """A range as a list of alternatives, each a list of tests. Raises ValueError if it cannot be read."""
    alternatives = []
    for part in text.split("||"):
        part = part.strip()
        hyphen = re.match(r"^(\S+)\s+-\s+(\S+)$", part)
        if hyphen:
            tests = expand_comparator(">=", hyphen[1]) + expand_comparator("<=", hyphen[2])
        else:
            tests = []
            # An operator may have spaces after it: ">= 1.0.0".
            for op, value in re.findall(r"(>=|<=|>|<|=|\^|~>?|)\s*([^\s<>=^~]+)", part):
                tests += expand_comparator("~" if op == "~>" else op, value)
            if re.sub(r"(>=|<=|>|<|=|\^|~>?|)\s*([^\s<>=^~]+)", "", part).strip():
                raise ValueError(text)
        alternatives.append(tests)
    return alternatives


def satisfies(version_text, range_text):
    """Whether a version is in a range. A range or version that cannot be read gives False."""
    version = parse_version(version_text)
    if version is None:
        return False
    try:
        alternatives = read_range(range_text)
    except ValueError:
        return False
    checks = {
        "=": lambda c: c == 0,
        ">": lambda c: c > 0,
        ">=": lambda c: c >= 0,
        "<": lambda c: c < 0,
        "<=": lambda c: c <= 0,
    }
    for tests in alternatives:
        if not all(checks[op](compare(version, other)) for op, other in tests):
            continue
        # A prerelease counts only if the range names a prerelease of the very same version.
        if version[3] and not any(other[3] and other[3] != LOWEST and other[:3] == version[:3] for _, other in tests):
            continue
        return True
    return False


# ---- The rules. Each of these has conformance vectors in arkiv/vectors/gate.json ----


def lower(text):
    return text.lower()


def recall_covers(recall, file):
    """By exact hash, or by package name and version range. A range that cannot be read covers nothing."""
    if lower(recall["artifact"]) == lower(file["hash"]):
        return True
    if not recall.get("pkg") or not recall.get("versions") or recall["pkg"] != file["name"]:
        return False
    return satisfies(file["version"], recall["versions"])


def is_withdrawn(stop, lifts, trust):
    """Only the key that issued a STOP, or a regulator, can take it back."""
    allowed = {lower(stop["creator"]), *trust["regulators"]}
    return any(l["recall"] == stop["key"] and l["kind"] == "WITHDRAWN" and lower(l["creator"]) in allowed for l in lifts)


def is_dismissed(advisory, lifts, trust):
    return any(l["recall"] == advisory["key"] and l["kind"] == "DISMISSED" and lower(l["creator"]) in trust["regulators"] for l in lifts)


def effective_votes(advisory, endorsements, current_block, trust):
    """One vote per person, from the verifier, inside the window. They count only while they outnumber votes against."""
    yes, no = set(), set()
    for e in endorsements:
        if e["recall"] != advisory["key"] or lower(e["creator"]) != trust["verifier"]:
            continue
        if current_block - int(e["createdAt"]) > trust["windowBlocks"]:
            continue
        (yes if e["stance"] == "CONFIRM" else no).add(e["human"])
    return len(yes) if len(yes) > len(no) else 0


def evaluate(i, files):
    """RUNNING, SUPERVISED or STOPPED for these files. Remembered STOPs come first: being offline must not undo one."""
    trust = i["trust"]
    covered = lambda r: any(recall_covers(r, f) for f in files)
    for r in i["rememberedStops"]:
        if r["level"] == "STOP" and lower(r["creator"]) in trust["stopKeys"] and covered(r) and not is_withdrawn(r, i["rememberedLifts"], trust):
            return "STOPPED"
    if not i["connectivity"]["online"]:
        offline = i["connectivity"]["offlineForMs"]
        if offline >= i["timers"]["graceMs"] + i["timers"]["offlineSupervisedMs"]:
            return "STOPPED"
        if any(covered(r) for r in i["lastSupervised"]) or offline >= i["timers"]["graceMs"]:
            return "SUPERVISED"
        return "RUNNING"
    for a in i["advisories"]:
        if a["level"] != "ADVISORY" or lower(a["creator"]) != trust["verifier"] or not covered(a):
            continue
        if is_dismissed(a, i["rememberedLifts"], trust):
            continue
        if effective_votes(a, i["endorsements"], i["currentBlock"], trust) >= trust["threshold"]:
            return "SUPERVISED"
    return "RUNNING"


def decide(i, ask):
    """(the agent's own mode, the verdict for one call). The stricter of the agent and the tool decides."""
    replaceable = lambda f: f["kind"] in ("tool", "skill")
    agent = evaluate(i, [f for f in i["files"] if not replaceable(f)])
    tool = next((f for f in i["files"] if replaceable(f) and lower(f["hash"]) == lower(ask)), None)
    # A tool the gate was not told about is not allowed through.
    if tool is None:
        return agent, "BLOCK"
    modes = (agent, evaluate(i, [tool]))
    if "STOPPED" in modes:
        return agent, "BLOCK"
    return agent, "NEEDS_APPROVAL" if "SUPERVISED" in modes else "ALLOW"


def normal_input(raw):
    """Addresses in lowercase and block numbers as integers, as the rules above expect."""
    trust = raw["trust"]
    return {
        **raw,
        "currentBlock": int(raw["currentBlock"]),
        "trust": {
            "stopKeys": {lower(k) for k in trust["stopKeys"]},
            "regulators": {lower(k) for k in trust["regulators"]},
            "verifier": lower(trust["verifier"]),
            "threshold": trust["threshold"],
            "windowBlocks": int(trust["windowBlocks"]),
        },
    }


# ---- Reading the list, over plain JSON-RPC ----


class ListUnreachable(Exception):
    pass


def rpc(url, method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    request = urllib.request.Request(url, data=body, headers={"content-type": "application/json", "user-agent": "ceasenet-gate-example"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            answer = json.loads(response.read())
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        raise ListUnreachable(str(e)) from e
    if "error" in answer:
        raise ListUnreachable(str(answer["error"]))
    return answer["result"]


def read_rows(url, where, names):
    """Every entity that matches, paged by key so nothing repeats or goes missing while others write."""
    rows, after, block = [], None, 0
    while True:
        query = f"{where}{f' AND $key > key({after})' if after else ''} ORDER BY $key:key ASC"
        select = {"key": True, "creator": True, "createdAt": True, "attributes": {n: True for n in names}}
        result = rpc(url, "arkiv_query", [query, {"select": select, "limit": hex(PAGE)}])
        block = int(result["blockNumber"], 16)
        for entity in result["data"]:
            row = {"key": entity["key"], "creator": entity["creator"], "createdAt": str(int(entity["createdAt"], 16))}
            for a in entity.get("attributes", []):
                row[a["name"]] = a["value"]
            rows.append(row)
        if len(result["data"]) < PAGE:
            return rows, block
        after = result["data"][-1]["key"]


def any_of(column, keys):
    return "(" + " OR ".join(f"{column} = key({k})" for k in keys) + ")"


def read_view(url, owner):
    """What a gate needs from the list. It reads every recall its owner signed and matches here, so the node learns which owner, never which tool."""
    if int(rpc(url, "eth_chainId", []), 16) != CHAIN_ID:
        raise ListUnreachable(f"{url} is not on Arkiv's Rabdi testnet")
    recalls, block = read_rows(
        url,
        f"arkiv.schema = str('ceasenet.recall') AND $creator = addr({owner})",
        ["artifact", "level", "severity", "pkg", "versions", "approves"],
    )
    # A node that has stopped following the chain would otherwise keep serving a list from before a STOP.
    newest = rpc(url, "eth_getBlockByNumber", [hex(block), False])
    age = time.time() - int(newest["timestamp"], 16)
    if age > MAX_LIST_AGE_SECONDS:
        raise ListUnreachable(f"the node answered from a block {round(age)} seconds old, so it is not serving the live list")
    keys = [r["key"] for r in recalls]
    lifts = read_rows(url, f"arkiv.schema = str('ceasenet.lift') AND {any_of('recall', keys)}", ["recall", "kind", "fixedHash"])[0] if keys else []
    advisories = [r["key"] for r in recalls if r["level"] == "ADVISORY"]
    votes = (
        read_rows(url, f"arkiv.schema = str('ceasenet.endorse') AND {any_of('recall', advisories)} AND $creator = addr({owner})", ["recall", "stance", "human"])[0]
        if advisories
        else []
    )
    return recalls, lifts, votes, block


def main():
    parser = argparse.ArgumentParser(description="May this agent call this tool right now?")
    parser.add_argument("--owner", required=True, help="the wallet this agent answers to. It obeys nobody else")
    parser.add_argument("--agent", help="the agent's own address, so a STOP aimed at it counts")
    parser.add_argument("--hash", help="the tool's exact hash")
    parser.add_argument("--tool", nargs=3, metavar=("NAME", "VERSION", "HASH"), help="the tool's name, version and hash, so a STOP on a version range counts")
    parser.add_argument("--rpc", default=PUBLIC_RPC, help="an Arkiv node, such as one you run")
    args = parser.parse_args()
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", args.owner) or (args.agent and not re.fullmatch(r"0x[0-9a-fA-F]{40}", args.agent)):
        parser.error("--owner and --agent must be addresses")
    if bool(args.hash) == bool(args.tool):
        parser.error("give --hash or --tool")

    owner = lower(args.owner)
    name, version, tool_hash = args.tool or ("", "", args.hash)
    files = [{"kind": "tool", "name": name, "version": version, "hash": tool_hash}, {"kind": "fleet", "name": "fleet", "version": "1.0.0", "hash": f"fleet:{owner}"}]
    if args.agent:
        files.append({"kind": "agent", "name": "agent", "version": "1.0.0", "hash": f"agent:{lower(args.agent)}"})

    try:
        recalls, lifts, votes, block = read_view(args.rpc, owner)
    except ListUnreachable as e:
        print(f"Cannot read the list: {e}. Do not treat this as permission.")
        return 3

    mode, verdict = decide(
        normal_input(
            {
                "files": files,
                "rememberedStops": [r for r in recalls if r["level"] == "STOP"],
                "rememberedLifts": lifts,
                "advisories": [r for r in recalls if r["level"] == "ADVISORY"],
                "endorsements": votes,
                "currentBlock": block,
                "connectivity": {"online": True, "offlineForMs": 0},
                "lastSupervised": [],
                "trust": {"stopKeys": [owner], "regulators": [], "verifier": owner, "threshold": CONFIRMATION_THRESHOLD, "windowBlocks": CONFIRMATION_WINDOW_BLOCKS},
                "timers": {"graceMs": GRACE_MS, "offlineSupervisedMs": OFFLINE_SUPERVISED_MS},
            }
        ),
        tool_hash,
    )
    in_force = [r for r in recalls if r["level"] == "STOP" and not is_withdrawn(r, lifts, {"regulators": set()}) and any(recall_covers(r, f) for f in files)]
    print(f"At block {block}: {len(recalls)} recalls signed by this owner, {len(in_force)} in force on this agent or tool. The agent is {mode}.")
    for r in in_force:
        print(f"  STOP {r['key']} on {r['artifact']}")
    print(verdict)
    return {"ALLOW": 0, "BLOCK": 1, "NEEDS_APPROVAL": 4}[verdict]


if __name__ == "__main__":
    sys.exit(main())
