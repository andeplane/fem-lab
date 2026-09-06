#!/usr/bin/env python3
"""Run unchanged LE10 oracles with an explicit solver and report its residual (#266)."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--binary", required=True)
parser.add_argument("--solver", choices=["cpu-direct", "cpu-pcg"], required=True)
parser.add_argument("--threads", type=int)
parser.add_argument("--include-tet", action="store_true")
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
names = ["nafems-le10-hex8", "nafems-le10-hex20"]
if args.include_tet:
    names.append("nafems-le10-tet10")
with tempfile.TemporaryDirectory(prefix="fem-266-") as directory:
    for name in names:
        case = json.loads((root / "crates/femlab/benches/cases" / f"{name}.json").read_text())
        for command in case["journal"]:
            if command["cmd"] == "solve.run":
                command["solver"] = args.solver
        case["checks"].extend([
            {"query": {"query": "query.result"}, "path": "/solver", "expect": args.solver},
            {"query": {"query": "query.result"}, "path": "/residual", "expect": 0, "tol": 1e-10},
        ])
        (Path(directory) / f"{name}.json").write_text(json.dumps(case))
    command = [str(Path(args.binary).resolve()), "bench", "--cpu", "--cases", directory, "--json"]
    if args.threads is not None:
        command.extend(["--threads", str(args.threads)])
    print(f"solver={args.solver}, threads={args.threads or 'default'}", flush=True)
    result = subprocess.run(command, text=True, capture_output=True, timeout=1200)
    print(result.stdout, flush=True)
    print(result.stderr, flush=True)
    raise SystemExit(result.returncode)
