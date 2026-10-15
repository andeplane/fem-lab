#!/usr/bin/env python3
"""#639: bounded public-CLI FV52 evidence; neither vendor table is a truth gate.

Run with an independently verified native CLI and an empty evidence directory:
  python3 tools/investigate-fv52.py --native /path/to/femlab --out /path/to/evidence
No private Engine access, solver override, reference fitting, or extra solves.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
GRIDS = ((4, 4, 1), (8, 8, 2), (16, 16, 4))
REFERENCES = {
    "Abaqus_NAFEMS_1990": [44.092, 106.66, 106.66, 156.23, 193.58, 200.13, 200.13],
    "Ansys_targets_1987": [45.897, 109.44, 109.44, 167.89, 193.59, 206.19, 206.19],
}
ABAQUS_C3D20_COMPUTED_CONTEXT_ONLY = [44.796, 110.54, 110.54, 169.10, 193.92, 206.64, 206.64]
EDGES = ("x0", "x10", "y0", "y10")
QUERIES = [{"query": "query.document"}, {"query": "query.mesh"},
           {"query": "query.result", "step": "modes"},
           {"query": "query.surface", "resultId": "result-1"}]
QUERIES += [{"query": "query.set", "name": name} for name in EDGES]
QUERIES += [{"query": "query.field", "resultId": "result-1", "field": f"mode:{mode}"}
            for mode in range(1, 11)]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def without_clock(value):
    if isinstance(value, dict):
        return {k: without_clock(v) for k, v in value.items() if k != "timeMs"}
    if isinstance(value, list):
        return [without_clock(v) for v in value]
    return value


def run_measured(command, stdout, stderr, max_rss_mib, timeout):
    """Own one child, retain exact stdout/stderr and kernel peak RSS, normalized from platform ru_maxrss units."""
    started = time.monotonic()
    stop = None
    with stdout.open("xb") as out, stderr.open("xb") as err:
        proc = subprocess.Popen(command, stdout=out, stderr=err, start_new_session=True)
        while True:
            pid, status, usage = os.wait4(proc.pid, os.WNOHANG)
            if pid:
                proc.returncode = os.waitstatus_to_exitcode(status)
                break
            if stop is None:
                if time.monotonic() - started > timeout:
                    stop = "wall-time resource boundary"
                rss = subprocess.run(["ps", "-o", "rss=", "-p", str(proc.pid)],
                                     capture_output=True, text=True, check=False).stdout.strip()
                if rss and int(rss) > max_rss_mib * 1024:
                    stop = "resident-memory resource boundary"
                if stop:
                    os.killpg(proc.pid, signal.SIGKILL)
            time.sleep(0.25)
    return {"exitCode": proc.returncode, "elapsedSeconds": time.monotonic() - started,
            "peakRssBytes": usage.ru_maxrss * (1 if sys.platform == "darwin" else 1024), "resourceStop": stop,
            "stdoutSha256": sha(stdout), "stderrSha256": sha(stderr)}


def check_and_summarize(raw, grid):
    document, mesh, result, surface = raw[:4]
    sets, fields = raw[4:8], raw[8:]
    nx, ny, nz = grid
    expected_nodes = ((nx + 1) * (ny + 1) * (nz + 1)
                      + nx * (ny + 1) * (nz + 1)
                      + (nx + 1) * ny * (nz + 1)
                      + (nx + 1) * (ny + 1) * nz)
    assert mesh["nodes"] == expected_nodes
    assert mesh["elements"] == nx * ny * nz
    assert mesh["elementKind"].lower() == "hex20"
    assert mesh["dofs"] == 3 * expected_nodes
    assert surface["unit"] == "m" and surface["nodeCount"] == expected_nodes
    positions = list(zip(*[iter(surface["positions"])] * 3))
    assert len(positions) == expected_nodes
    assert [min(p[d] for p in positions) for d in range(3)] == [0, 0, -0.5]
    assert [max(p[d] for p in positions) for d in range(3)] == [10, 10, 0.5]
    by_edge = [set(i for i, (x, y, z) in enumerate(positions)
                   if z == -0.5 and ((edge == "x0" and x == 0)
                     or (edge == "x10" and x == 10)
                     or (edge == "y0" and y == 0)
                     or (edge == "y10" and y == 10))) for edge in EDGES]
    assert all(s["name"] == name and s["count"] == len(ids) == 2 * nx + 1
               for s, name, ids in zip(sets, EDGES, by_edge))
    support = set.union(*by_edge)
    assert len(support) == 8 * nx
    assert result["resultId"] == "result-1" and result["step"] == "modes"
    assert not result["stale"] and result["modeCount"] == 10
    residual = result["residual"]
    assert math.isfinite(residual) and 0 <= residual <= 1e-10
    frequencies = [f["value"] for f in result["frequencies"]]
    assert len(frequencies) == 10 and frequencies == sorted(frequencies)
    assert all(math.isfinite(f) and f >= 0 for f in frequencies)
    assert all(f["unit"] == "Hz" for f in result["frequencies"])
    assert len(fields) == 10
    rigid_fits = []
    rigid_coefficients = []
    for mode, field in enumerate(fields, 1):
        assert field["field"] == f"mode:{mode}" and field["resultId"] == "result-1"
        assert field["components"] == 3 and field["per"] == "node"
        assert field["entityCount"] == field["nodeCount"] == expected_nodes
        values = field["values"]
        assert len(values) == 3 * expected_nodes and all(math.isfinite(v) for v in values)
        assert all(values[3 * i + 2] == 0 for i in support), "UZ-only edge support is exact"
        if mode <= 3:
            # Independent analytic rigid subspace {Tx, Ty, Rz}; centered symmetric grid.
            tx = sum(values[0::3]) / expected_nodes
            ty = sum(values[1::3]) / expected_nodes
            inertia = sum((x - 5) ** 2 + (y - 5) ** 2 for x, y, _ in positions)
            rz = sum(-(y - 5) * values[3*i] + (x - 5) * values[3*i+1]
                     for i, (x, y, _) in enumerate(positions)) / inertia
            square_error = sum((values[3*i] - tx + rz * (y - 5)) ** 2
                               + (values[3*i+1] - ty - rz * (x - 5)) ** 2
                               + values[3*i+2] ** 2 for i, (x, y, _) in enumerate(positions))
            shape_norm = math.sqrt(sum(v*v for v in values))
            rigid_fits.append(math.sqrt(square_error) / shape_norm)
            rigid_coefficients.append([tx * math.sqrt(expected_nodes) / shape_norm,
                                       ty * math.sqrt(expected_nodes) / shape_norm,
                                       rz * math.sqrt(inertia) / shape_norm])
    # Lossless public document preserves actual supports and explicit solve controls.
    commands = [entry["cmd"] for entry in document["file"]["journal"]["entries"]]
    fixes = [cmd for cmd in commands if cmd["cmd"] == "constraint.fix"]
    assert len(fixes) == 4 and all(c["dofs"] == ["uz"] for c in fixes)
    assert commands[-1]["cmd"] == "solve.run" and commands[-1]["maxIterations"] == 5000
    # Independent rank/determinant diagnostics distinguish a full rigid span from duplicate Tx.
    rank_work = [row[:] for row in rigid_coefficients]
    rank = 0
    for col in range(3):
        pivot = max(range(rank, 3), key=lambda row: abs(rank_work[row][col]))
        if abs(rank_work[pivot][col]) <= 1e-8:
            continue
        rank_work[rank], rank_work[pivot] = rank_work[pivot], rank_work[rank]
        for row in range(rank + 1, 3):
            ratio = rank_work[row][col] / rank_work[rank][col]
            for k in range(col, 3):
                rank_work[row][k] -= ratio * rank_work[rank][k]
        rank += 1
        if rank == 3:
            break
    a, b, c = rigid_coefficients
    determinant = (a[0]*(b[1]*c[2]-b[2]*c[1]) - a[1]*(b[0]*c[2]-b[2]*c[0])
                   + a[2]*(b[0]*c[1]-b[1]*c[0]))
    diagnostic = {}
    for source, targets in REFERENCES.items():
        errors = [(f - ref) / ref for f, ref in zip(frequencies[3:], targets)]
        diagnostic[source] = {"referenceHz": targets, "signedRelativeDifference": errors,
                              "withinThreePercent_DIAGNOSTIC_ONLY": [abs(e) <= 0.03 for e in errors]}
    return {"grid": grid, "elements": mesh["elements"], "nodes": expected_nodes,
            "supportedUzNodes": len(support), "freeDofs": 3 * expected_nodes - len(support),
            "frequenciesHz": frequencies, "measuredMaxBackwardResidual": residual,
            "sweeps": result["iterations"], "warnings": result.get("warnings", []),
            "firstThreeRigidSubspaceRelativeMisfit_DIAGNOSTIC_ONLY": rigid_fits,
            "lowThreeToFirstDeformationalRatio_DIAGNOSTIC_ONLY": max(frequencies[:3]) / frequencies[3],
            "rigidTxTyRzNormalizedCoefficients_DIAGNOSTIC_ONLY": rigid_coefficients,
            "rigidCoefficientRankAtThreshold1e_8_DIAGNOSTIC_ONLY": rank,
            "rigidCoefficientDeterminant_DIAGNOSTIC_ONLY": determinant,
            "Abaqus_C3D20_computed_Hz_CONTEXT_NOT_REFERENCE": ABAQUS_C3D20_COMPUTED_CONTEXT_ONLY,
            "references_DIAGNOSTIC_ONLY": diagnostic,
            "fieldSha256": [hashlib.sha256(json.dumps(f, sort_keys=True).encode()).hexdigest() for f in fields]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--max-rss-mib", type=int, default=2048)
    parser.add_argument("--timeout-seconds", type=int, default=180)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    manifest = {"issue": 639, "source": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
                "cliSha256": sha(args.native), "runnerSha256": sha(Path(__file__)),
                "ruMaxRssPlatform": sys.platform, "timeoutSeconds": args.timeout_seconds, "maxRssMiB": args.max_rss_mib,
                "schemaSha256": sha(ROOT / "packages/registry/src/generated/engine.schema.json"),
                "references": REFERENCES, "scope": "native investigative evidence only; no accepted FV52 target/rate", "cases": []}
    for grid in GRIDS:
        previous = None
        for threads in (1, 4):
            label = "x".join(map(str, grid)) + f"-threads{threads}"
            fixture = ROOT / "tools/fixtures/fv52" / ("hex20-" + "x".join(map(str, grid)) + ".json")
            command = [str(args.native), "run", str(fixture), "--cpu", "--threads", str(threads)]
            for query in QUERIES:
                command += ["--query", json.dumps(query, separators=(",", ":"))]
            record = {"label": label, "fixtureSha256": sha(fixture), "command": command}
            print(f"START {label}", flush=True)
            record.update(run_measured(command, args.out / f"{label}.stdout.json",
                                       args.out / f"{label}.stderr.txt", args.max_rss_mib,
                                       args.timeout_seconds))
            manifest["cases"].append(record)
            (args.out / "receipt.json").write_text(json.dumps(manifest, indent=2) + "\n")
            if record["exitCode"] != 0:
                print(f"STOP {label}: structured failure/resource boundary retained", flush=True)
                return 1
            try:
                raw = json.loads((args.out / f"{label}.stdout.json").read_text())
                record["summary"] = check_and_summarize(raw, grid)
                canonical = without_clock(raw)
                if previous is not None:
                    assert canonical == previous, "native1/4 metadata, Journal and all shapes must agree exactly"
                    record["threadExactExceptHostTimeMs"] = True
                previous = canonical
            except Exception as error:
                record["verificationFailure"] = repr(error)
                (args.out / "receipt.json").write_text(json.dumps(manifest, indent=2) + "\n")
                raise
            (args.out / "receipt.json").write_text(json.dumps(manifest, indent=2) + "\n")
            print(f"PASS {label}: {record['summary']['frequenciesHz']} eta={record['summary']['measuredMaxBackwardResidual']:.4e} sweeps={record['summary']['sweeps']} wall={record['elapsedSeconds']:.2f}s RSS={record['peakRssBytes']/1048576:.1f}MiB", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
