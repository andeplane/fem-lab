#!/usr/bin/env python3
"""Verify #7's fixed published deck and an enlarged-spectrum symmetry/refinement study.

The two conflicting NAFEMS reference columns remain diagnostics. The independent
computed Abaqus C3D20 row applies only to its exact 4x4x1 full-integration deck.
This does not turn its seven coarse frequencies into continuum reference values.
"""
import argparse
import importlib.util
import json
import math
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("fv52_evidence", ROOT / "tools/investigate-fv52.py")
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)
MODES = 24
DECK_REFERENCE = [44.796, 110.54, 110.54, 169.10, 193.92, 206.64, 206.64]


def dot(a, b):
    return math.fsum(x * y for x, y in zip(a, b))


def rotation_subspace_errors(raw):
    """A square isotropic pencil commutes with a physical quarter-turn, not vector reshuffling."""
    positions = list(zip(*[iter(raw[3]["positions"])] * 3))
    index = {p: i for i, p in enumerate(positions)}
    permutation = [index[(10 - y, x, z)] for x, y, z in positions]
    frequencies = [f["value"] for f in raw[2]["frequencies"]]
    vectors = [field["values"] for field in raw[8:]]
    clusters = []
    for i, frequency in enumerate(frequencies):
        if not clusters or abs(frequency - frequencies[clusters[-1][0]]) > 1e-7 * max(1, frequency):
            clusters.append([])
        clusters[-1].append(i)
    result = []
    # Four extra modes protect the first twenty from a truncated boundary cluster.
    for cluster in clusters:
        if cluster[0] >= 20:
            break
        assert cluster[-1] < MODES - 1, "boundary cluster needs more retained modes"
        basis = []
        for i in cluster:
            w = vectors[i][:]
            for _ in range(2):
                for q in basis:
                    coefficient = dot(w, q)
                    w = [a - coefficient * b for a, b in zip(w, q)]
            norm = math.sqrt(dot(w, w))
            assert norm > 1e-10 * math.sqrt(dot(vectors[i], vectors[i])), "independent cluster vectors"
            basis.append([a / norm for a in w])
        errors = []
        for i in cluster:
            rotated = [0.0] * len(vectors[i])
            for node, dest in enumerate(permutation):
                ux, uy, uz = vectors[i][3 * node:3 * node + 3]
                rotated[3 * dest:3 * dest + 3] = [-uy, ux, uz]
            residual = rotated[:]
            for q in basis:
                coefficient = dot(rotated, q)
                residual = [a - coefficient * b for a, b in zip(residual, q)]
            errors.append(math.sqrt(dot(residual, residual) / dot(rotated, rotated)))
        assert max(errors) < 1e-6, (cluster, errors)
        result.append({"oneBasedModes": [i + 1 for i in cluster], "quarterTurnRelativeErrors": errors})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    cli = args.native.resolve()
    manifest = {"issue": 7, "source": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
                "cliSha256": common.sha(cli), "runnerSha256": common.sha(Path(__file__)),
                "retainedModes": MODES, "cases": [],
                "contract": "fixed published C3D20 deck only; both NAFEMS columns diagnostic; no continuum reference fitted"}
    queries = common.QUERIES[:8] + [{"query": "query.field", "resultId": "result-1", "field": f"mode:{m}"} for m in range(1, MODES + 1)]
    previous_spectrum = None
    for grid in common.GRIDS:
        commands = json.loads((ROOT / "tools/fixtures/fv52" / ("hex20-" + "x".join(map(str, grid)) + ".json")).read_text())
        commands[-2]["nModes"] = MODES
        fixture = args.out / ("hex20-" + "x".join(map(str, grid)) + ".json")
        fixture.write_text(json.dumps(commands, indent=2) + "\n")
        previous_raw = None
        for threads in (1, 4):
            label = "x".join(map(str, grid)) + f"-threads{threads}"
            command = [str(cli), "run", str(fixture), "--cpu", "--threads", str(threads)]
            for query in queries:
                command += ["--query", json.dumps(query, separators=(",", ":"))]
            record = {"label": label, "fixtureSha256": common.sha(fixture), "command": command}
            print(f"START {label}", flush=True)
            record.update(common.run_measured(command, args.out / f"{label}.stdout.json", args.out / f"{label}.stderr.txt", 2048, 180))
            manifest["cases"].append(record)
            (args.out / "receipt.json").write_text(json.dumps(manifest, indent=2) + "\n")
            assert record["exitCode"] == 0 and record["resourceStop"] is None
            raw = json.loads((args.out / f"{label}.stdout.json").read_text())
            record["summary"] = common.check_and_summarize(raw, grid, expected_modes=MODES)
            summary = record["summary"]
            assert max(summary["firstThreeRigidSubspaceRelativeMisfit_DIAGNOSTIC_ONLY"]) < 1e-9
            assert summary["rigidCoefficientRankAtThreshold1e_8_DIAGNOSTIC_ONLY"] == 3
            spectrum = summary["frequenciesHz"]
            assert max(spectrum[:3]) / spectrum[3] < 1e-5
            record["quarterTurnClusters"] = rotation_subspace_errors(raw)
            if grid == common.GRIDS[0]:
                errors = [abs(f / target - 1) for f, target in zip(spectrum[3:10], DECK_REFERENCE)]
                assert max(errors) < 0.03, "independent fixed-deck computed reference, unchanged 3% gate"
                record["publishedC3D20DeckRelativeErrors"] = errors
            if previous_raw is not None:
                assert common.without_clock(raw) == previous_raw, "all 24 shapes/payloads exact at 1/4 workers"
                record["threadExactExceptHostTimeMs"] = True
            previous_raw = common.without_clock(raw)
            if threads == 1 and previous_spectrum is not None:
                # Conforming nested Hex20 spaces with nested UZ traces: the min-max principle.
                # No asymptotic rate exists for these singular edge restraints.
                assert all(f <= old * (1 + 1e-8) for f, old in zip(spectrum[3:20], previous_spectrum[3:20]))
                record["firstSeventeenElasticEigenvaluesNonIncreasing"] = True
            (args.out / "receipt.json").write_text(json.dumps(manifest, indent=2) + "\n")
            print(f"PASS {label}: eta={summary['measuredMaxBackwardResidual']:.3e}; f4={spectrum[3]:.9g}", flush=True)
        previous_spectrum = spectrum
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
