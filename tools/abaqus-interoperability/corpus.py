#!/usr/bin/env python3
"""#656: attest untouched reference decks, then compare through the public native CLI.

No solver build, CalculiX execution, private engine API, network fallback, or input repair.
The network-free unit suite exercises corruption and numerical-comparison failures.
"""

import argparse
import hashlib
import io
import json
import math
from pathlib import Path
import re
import subprocess
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = Path(__file__).with_name("corpus.json")
AUTHORED = ROOT / "crates/engine/tests/fixtures/abaqus-interoperability/assembly-two-material-bars.inp"
MAX_DOWNLOAD = 16 * 1024 * 1024
MAX_MEMBER = 2 * 1024 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


def checked(data, expected):
    if len(data) != expected["bytes"] or digest(data) != expected["sha256"]:
        raise ValueError(f"source identity mismatch: {expected.get('file', expected.get('id', 'artifact'))}")
    return data


def external(directory):
    directory = Path(directory).resolve()
    if directory == ROOT or ROOT in directory.parents:
        raise ValueError("reference downloads and run evidence must be outside the checkout")
    return directory


def download(artifact):
    if artifact["bytes"] > MAX_DOWNLOAD:
        raise ValueError("artifact exceeds fixed download bound")
    with urllib.request.urlopen(artifact["url"], timeout=30) as response:
        if not response.geturl().startswith("https://"):
            raise ValueError("HTTPS source required")
        data = response.read(artifact["bytes"] + 1)
    return checked(data, artifact)


def selected_members(data, members):
    """Read only pinned regular members into memory; never extract archive paths."""
    result = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:bz2") as archive:
        for expected in members:
            member = archive.getmember(expected["name"])
            if not member.isfile() or member.size != expected["bytes"] or member.size > MAX_MEMBER:
                raise ValueError(f"unexpected archive member: {expected['name']}")
            stream = archive.extractfile(member)
            if stream is None:
                raise ValueError("regular archive member has no bytes")
            result[expected["file"]] = checked(stream.read(expected["bytes"] + 1), expected)
    return result


def write_once(path, data):
    if path.exists():
        if path.read_bytes() != data:
            raise ValueError(f"refusing to overwrite different evidence: {path}")
    else:
        with path.open("xb") as output:
            output.write(data)


def json_bytes(value):
    return (json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n").encode()


def fetch(manifest, destination):
    destination = external(destination)
    destination.mkdir(parents=True, exist_ok=True)
    receipt = {"format": manifest["format"], "manifestSha256": digest(MANIFEST.read_bytes()), "sources": []}
    for artifact in manifest["artifacts"]:
        archive_name = artifact.get("file", artifact["url"].rsplit("/", 1)[1])
        target = destination / archive_name
        data = checked(target.read_bytes(), artifact) if target.exists() else download(artifact)
        write_once(target, data)
        files = selected_members(data, artifact["members"]) if "members" in artifact else {}
        for name, payload in files.items():
            write_once(destination / name, payload)
        receipt["sources"].append({"id": artifact["id"], "url": artifact["url"],
                                   "bytes": len(data), "sha256": digest(data), "license": artifact["license"],
                                   "members": [{"file": name, "bytes": len(payload), "sha256": digest(payload)}
                                               for name, payload in files.items()]})
    check_sources(manifest, destination)
    write_once(destination / f"acquisition-{receipt['manifestSha256']}.json", json_bytes(receipt))
    return receipt


def keywords(text):
    return list(dict.fromkeys(" ".join(line[1:].split(",", 1)[0].upper().split())
                             for line in text.splitlines() if line.startswith("*") and not line.startswith("**")))


def reference_displacements(text, set_name, time):
    heading = re.compile(r"^\s*displacements \(vx,vy,vz\) for set (\S+) and time\s+(\S+)\s*$")
    lines = text.splitlines()
    matches = [i for i, line in enumerate(lines) if (match := heading.match(line))
               and match[1] == set_name and float(match[2].replace("D", "E")) == time]
    if len(matches) != 1:
        raise ValueError("expected exactly one independently printed displacement block")
    result = {}
    for line in lines[matches[0] + 1:]:
        fields = line.split()
        if len(fields) == 4 and fields[0].isdigit():
            label = int(fields[0])
            if label in result:
                raise ValueError("duplicate reference node label")
            values = [float(v.replace("D", "E")) for v in fields[1:]]
            if not all(math.isfinite(v) for v in values):
                raise ValueError("nonfinite reference displacement")
            result[label] = values
        elif result:
            break
        elif line.strip():
            raise ValueError("malformed start of displacement block")
    if not result:
        raise ValueError("empty reference displacement block")
    return result


def flat_source_inventory(text, element):
    """Attest these two explicit flat reference meshes; this is not an import converter."""
    arity = {"C3D10": 10, "C3D20": 20}[element]
    nodes, tokens = set(), []
    active = None
    for line in text.splitlines():
        if not line.strip() or line.startswith("**"):
            continue
        if line.startswith("*"):
            options = [part.strip().upper() for part in line[1:].split(",")]
            active = options[0]
            if active == "ELEMENT" and f"TYPE={element}" not in options:
                raise ValueError("reference element type differs from manifest")
            continue
        values = [part.strip() for part in line.split(",")]
        while values and not values[-1]:
            values.pop()
        if active == "NODE":
            label = int(values[0])
            if label in nodes:
                raise ValueError("duplicate source node label")
            nodes.add(label)
        elif active == "ELEMENT":
            tokens.extend(map(int, values))
    if not tokens or len(tokens) % (arity + 1):
        raise ValueError("reference connectivity is incomplete")
    elements = tokens[::arity + 1]
    participating = {tokens[i] for i in range(len(tokens)) if i % (arity + 1)}
    if len(elements) != len(set(elements)) or nodes != participating:
        raise ValueError("reference labels are duplicate, missing or unused")
    return nodes, elements


def executed_reference(data, expected, deck_hash):
    """Check a pinned observed reference, including which unchanged input was executed."""
    checked(data, expected)
    reference = json.loads(data)
    if (reference["format"] != "femlab-cross-solver-reference/1" or reference["input"]["sha256"] != deck_hash
            or not reference["input"]["unchangedBeforeAndAfterRun"] or reference["solver"]["exitCode"] != 0
            or reference["solver"]["name"] != "CalculiX" or reference["solver"]["version"] != "2.23"
            or reference["rawOutput"]["displacementUnit"] != "mm"):
        raise ValueError("executed reference provenance/input/units differ")
    rows = {int(label): values for label, values in reference["displacements"].items()}
    if not rows or any(len(values) != 3 or not all(math.isfinite(v) for v in values) for values in rows.values()):
        raise ValueError("executed reference has invalid displacement vectors")
    return rows


def case_reference(case, source):
    if case.get("referenceFormat") == "executed-json":
        return executed_reference((ROOT / case["reference"]).read_bytes(), case["referenceIdentity"],
                                  digest((source / case["deck"]).read_bytes()))
    return reference_displacements((source / case["reference"]).read_text(),
                                   case["referenceSet"], case["referenceTime"])


def check_sources(manifest, source):
    source = external(source)
    for artifact in manifest["artifacts"]:
        name = artifact.get("file", artifact["url"].rsplit("/", 1)[1])
        checked((source / name).read_bytes(), artifact)
        for member in artifact.get("members", []):
            checked((source / member["file"]).read_bytes(), member)
    result = []
    for case in manifest.get("exporterAdmissionCases", []):
        text = (source / case["deck"]).read_text()
        nodes, elements = flat_source_inventory(text, case["element"])
        if (len(nodes) != case["nodes"] or len(elements) != case["elements"]
                or keywords(text) != case["keywords"] or not all(marker in text for marker in case["metadataMarkers"])):
            raise ValueError(f"exported source inventory/provenance differs: {case['id']}")
        result.append({"id": case["id"], "nodes": len(nodes), "elements": len(elements),
                       "scope": "source identity/inventory only; no FEM Lab solve acceptance implied"})
    for case in manifest["comparisons"]:
        text = (source / case["deck"]).read_text()
        if keywords(text) != case["keywords"]:
            raise ValueError(f"keyword inventory changed: {case['id']}")
        nodes, elements = flat_source_inventory(text, case["element"])
        if len(nodes) != case["nodes"] or len(elements) != case["elements"]:
            raise ValueError(f"source mesh counts differ from manifest: {case['id']}")
        rows = case_reference(case, source)
        if set(rows) != nodes:
            raise ValueError(f"incomplete independent reference: {case['id']}")
        result.append({"id": case["id"], "referenceNodes": len(rows), "elements": len(elements),
                       "elementLabelRange": [min(elements), max(elements)], "keywords": case["keywords"]})
    return result


def compare_displacements(labels, values, reference, scale, relative, absolute):
    if len(labels) != len(set(labels)) or set(labels) != set(reference) or len(values) != 3 * len(labels):
        raise ValueError("solved/reference node identities or displacement dimensions differ")
    expected_scale = max(abs(v * scale) for vector in reference.values() for v in vector)
    tolerance = absolute + relative * expected_scale
    worst = {"errorMetres": -1, "node": None, "component": None}
    for index, label in enumerate(labels):
        for component in range(3):
            actual = values[3 * index + component]
            wanted = reference[label][component] * scale
            if not math.isfinite(actual):
                raise ValueError("nonfinite solved displacement")
            error = abs(actual - wanted)
            if error > worst["errorMetres"]:
                worst = {"errorMetres": error, "node": label, "component": component}
            if error > tolerance:
                raise ValueError(f"independent displacement mismatch at source node {label}, component {component}: "
                                 f"actual={actual}, reference={wanted}, error={error}, tolerance={tolerance}")
    return {**worst, "toleranceMetres": tolerance, "referenceNodes": len(reference)}


def total_reaction(field, force):
    if field["components"] != 3 or field["unit"] != "N" or len(field["values"]) % 3:
        raise ValueError("reaction field has unexpected dimensions/units")
    totals = [math.fsum(field["values"][d::3]) for d in range(3)]
    for actual, applied in zip(totals, force):
        if not math.isfinite(actual) or abs(actual + applied) > 1e-7:
            raise ValueError(f"force balance failed: reactions={totals}, applied={force}")
    return totals


def without_clock(value):
    if isinstance(value, dict):
        return {key: without_clock(item) for key, item in value.items() if key != "timeMs"}
    if isinstance(value, list):
        return [without_clock(item) for item in value]
    return value


def execute(native, arguments, directory, name):
    command = [str(native), *arguments]
    completed = subprocess.run(command, capture_output=True, timeout=120, check=False)
    write_once(directory / f"{name}.stdout", completed.stdout)
    write_once(directory / f"{name}.stderr", completed.stderr)
    write_once(directory / f"{name}.invocation.json", json_bytes({"command": command, "exitCode": completed.returncode}))
    if completed.returncode:
        raise ValueError(f"public CLI failed ({completed.returncode}); see {directory / (name + '.stderr')}")
    return json.loads(completed.stdout)


def authored_oracle(surface, displacement, stress, reaction):
    if surface["unit"] != "m" or surface["nodeCount"] != 24 or len(surface["positions"]) != 72:
        raise ValueError("authored assembly did not preserve 24 distinct mesh nodes")
    expected_points = {(x, y, z) for x in [0, .5, 1] for y in [0, .1] for z in [0, .1]}
    expected_points |= {(-y, 2 + x, z) for x in [0, .5, 1] for y in [0, .1] for z in [0, .1]}
    actual_points = {tuple(round(v, 12) for v in surface["positions"][i:i + 3]) for i in range(0, 72, 3)}
    if actual_points != expected_points or len(stress["values"]) != 144:
        raise ValueError("authored instance geometry or stress dimensions differ")
    reference = {}
    for index in range(24):
        x, y, z = surface["positions"][3 * index:3 * index + 3]
        second = y >= 2 - 1e-12
        local_x = y - 2 if second else x
        if not (-1e-12 <= local_x <= 1 + 1e-12 and -1e-12 <= z <= .1 + 1e-12):
            raise ValueError("assembly translation/rotation bounds differ from authored geometry")
        transverse = -x if second else y
        if not -1e-12 <= transverse <= .1 + 1e-12:
            raise ValueError("assembly transverse transform is incorrect")
        axial = 1e5 * (min(local_x, .5) / 200e9 + max(local_x - .5, 0) / 100e9)
        reference[index] = [0, axial, 0] if second else [axial, 0, 0]
        for component in range(6):
            wanted = 1e5 if component == (1 if second else 0) else 0
            actual = stress["values"][6 * index + component]
            if not math.isfinite(actual) or abs(actual - wanted) > 1e-4:
                raise ValueError("two-material assembly analytical stress mismatch")
    comparison = compare_displacements(list(range(24)), displacement["values"], reference, 1, 1e-9, 1e-15)
    return {"displacements": comparison, "reactionNewtons": total_reaction(reaction, [1000, 1000, 0])}


def compare(manifest, source, native, destination, selected):
    source, destination = external(source), external(destination)
    check_sources(manifest, source)
    native = Path(native).resolve(strict=True)
    destination.mkdir(parents=True, exist_ok=False)
    receipt = {"manifestSha256": digest(MANIFEST.read_bytes()), "native": str(native),
               "nativeSha256": digest(native.read_bytes()), "completed": False, "cases": []}
    cases = list(manifest["comparisons"])
    cases.append({"id": "authored-assembly-two-material", "deck": str(AUTHORED), "step": "AXIAL",
                  "nodes": 24, "elements": 4, "unitLength": "1 m", "unitForce": "1 N"})
    if selected:
        unknown = set(selected) - {case["id"] for case in cases}
        if unknown:
            raise ValueError(f"unknown cases: {sorted(unknown)}")
        cases = [case for case in cases if case["id"] in selected]
    try:
        for case in cases:
            folder = destination / case["id"]
            folder.mkdir()
            deck = Path(case["deck"]) if Path(case["deck"]).is_absolute() else source / case["deck"]
            model = folder / "imported.femlab.json"
            args = ["import-inp", str(deck), "--out", str(model), "--name", case["id"], "--body", "interop",
                    "--mode", "static", "--unit-length", case["unitLength"], "--unit-force", case["unitForce"],
                    "--cpu", "--threads", "1"]
            if "unitTime" in case:
                args += ["--unit-time", case["unitTime"]]
            report = execute(native, args, folder, "convert")
            if report["sha256"] != digest(deck.read_bytes()) or not report["analysisConfigured"]:
                raise ValueError("import report source identity/analysis configuration mismatch")
            portable = json.loads(model.read_bytes())
            commands = [entry["cmd"] for entry in portable["journal"]["entries"]]
            if any(command["cmd"] == "solve.run" for command in commands):
                raise ValueError("conversion unexpectedly solved")
            commands.append({"cmd": "solve.run", "step": case["step"], "solver": "cpu-direct"})
            script = folder / "explicit-solve.json"
            write_once(script, json_bytes(commands))
            queries = [{"query": "query.result", "step": case["step"]}, {"query": "query.mesh"},
                       {"query": "query.surface", "resultId": "result-1"}]
            queries += [{"query": "query.field", "step": case["step"], "field": field}
                        for field in ["displacement", "stress", "reaction"]]
            runs = []
            for threads in [1, 4]:
                args = ["run", str(script), "--cpu", "--verify", "--threads", str(threads)]
                for query in queries:
                    args += ["--query", json.dumps(query, separators=(",", ":"))]
                raw = execute(native, args, folder, f"solve-{threads}")
                result, mesh, surface, displacement, stress, reaction = raw
                if result["stale"] or mesh["nodes"] != case["nodes"] or mesh["elements"] != case["elements"]:
                    raise ValueError("solved mesh counts or Result lifecycle mismatch")
                if displacement["unit"] != "m" or displacement["components"] != 3:
                    raise ValueError("displacement field has unexpected dimensions/units")
                if stress["unit"] != "Pa" or stress["components"] != 6:
                    raise ValueError("stress field has unexpected dimensions/units")
                if "reference" in case:
                    reference = case_reference(case, source)
                    comparison = compare_displacements(mesh["sourceLabels"]["nodes"], displacement["values"], reference,
                                                       case["referenceDisplacementScaleToMetres"],
                                                       case["displacementRelativeTolerance"],
                                                       case["displacementAbsoluteToleranceMetres"])
                    proof = {"displacements": comparison, "reactionNewtons": total_reaction(reaction, case["totalAppliedForceNewtons"])}
                else:
                    proof = authored_oracle(surface, displacement, stress, reaction)
                runs.append(json.dumps(without_clock(raw), sort_keys=True, separators=(",", ":"), allow_nan=False))
                write_once(folder / f"comparison-{threads}.json", json_bytes(proof))
            if runs[0] != runs[1]:
                raise ValueError("native 1/4-thread public outputs differ (only timeMs omitted)")
            receipt["cases"].append({"id": case["id"], "deckSha256": digest(deck.read_bytes()),
                                     "native1And4Exact": True, "canonicalOutputSha256": digest(runs[0].encode())})
        receipt["completed"] = True
    finally:
        write_once(destination / "receipt.json", json_bytes(receipt))
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    acquisition = sub.add_parser("fetch", help="fetch/attest pinned official CalculiX originals externally")
    acquisition.add_argument("--out", required=True)
    validation = sub.add_parser("check", help="offline source/hash/reference inventory check")
    validation.add_argument("--source", required=True)
    acceptance = sub.add_parser("compare", help="execute conversion and explicit solves; any unsupported physics fails")
    acceptance.add_argument("--source", required=True)
    acceptance.add_argument("--native", required=True)
    acceptance.add_argument("--out", required=True)
    acceptance.add_argument("--case", action="append")
    args = parser.parse_args()
    manifest = json.loads(MANIFEST.read_text())
    if args.action == "fetch":
        result = fetch(manifest, args.out)
    elif args.action == "check":
        result = check_sources(manifest, args.source)
    else:
        result = compare(manifest, args.source, args.native, args.out, args.case)
    print(json.dumps(result, indent=2, sort_keys=True, allow_nan=False))


if __name__ == "__main__":
    main()
