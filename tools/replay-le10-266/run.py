#!/usr/bin/env python3
"""Run immutable CLI and identical-matrix controls on one machine; retain every failure."""
import argparse
import hashlib
import json
import lzma
from pathlib import Path
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--baseline', type=Path, required=True)
parser.add_argument('--cli', type=Path, required=True)
parser.add_argument('--replay', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parent
compressed = (root / 'fixtures/le10-hex20.csr.xz').read_bytes()
assert hashlib.sha256(compressed).hexdigest() == '5a836ad5efb74bfc5089775a5e4fcd928543784b2616713ac9467232c5d1227b'
raw = lzma.decompress(compressed)
assert hashlib.sha256(raw).hexdigest() == '676daedcc4c2be0c6f5c9b5519e2c9bc619eaa8ae78f5b2baf1282982d198cad'
assert len(raw) == 27_739_900
print(f'verified_matrix_sha256={hashlib.sha256(raw).hexdigest()} bytes={len(raw)}', flush=True)
results = []
with tempfile.TemporaryDirectory(prefix='fem-266-replay-') as directory:
    matrix = Path(directory) / 'le10-hex20.csr'
    matrix.write_bytes(raw)
    controls = []
    for threads in [None, 1, 4]:
        command = [sys.executable, str(args.baseline.resolve() / 'tools/diagnose-direct-solve.py'), '--binary', str(args.cli.resolve()), '--solver', 'cpu-direct']
        if threads is not None:
            command.extend(['--threads', str(threads)])
        controls.append((f'baseline-direct-{threads or "default"}', command))
    for mode in ['seq', 'rayon1', 'rayon4', 'factor4-solve-seq', 'factor-seq-solve4']:
        controls.append((f'captured-matrix-{mode}', [str(args.replay.resolve()), str(matrix), mode]))
    for name, command in controls:
        print(f'\n===== {name} =====', flush=True)
        try:
            result = subprocess.run(command, timeout=1200, check=False)
            code = result.returncode
        except subprocess.TimeoutExpired:
            code = 124
        results.append({'control': name, 'exit_code': code})
        print(f'{name}: exit_code={code}', flush=True)
print(json.dumps(results, indent=2), flush=True)
sys.exit(0 if all(result['exit_code'] == 0 for result in results) else 1)
