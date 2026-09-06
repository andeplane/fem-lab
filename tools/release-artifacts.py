"""Package release outputs using only the Python standard library."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import tomllib
import zipfile


def version(root, tag=None):
    rust = tomllib.loads((root / 'Cargo.toml').read_text())['workspace']['package']['version']
    npm = json.loads((root / 'packages/mcp/package.json').read_text())['version']
    if rust != npm or not re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', rust):
        raise ValueError('Rust and npm must share a valid release version')
    if tag is not None and tag != 'v' + rust:
        raise ValueError('The release tag must equal v plus the package version')
    return rust


def archive(output, entries):
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as target:
        for source, name in sorted(entries, key=lambda row: row[1]):
            if source.is_symlink() or not source.is_file():
                raise ValueError('Release archives require regular files: ' + str(source))
            target.write(source, name)


def native(root, target):
    v = version(root)
    executable = 'femlab.exe' if 'windows' in target else 'femlab'
    source = root / 'target' / target / 'release' / executable
    # Run a copied binary from outside the repository, as the release user will.
    with tempfile.TemporaryDirectory(prefix='femlab-release-') as directory:
        binary = Path(directory) / executable
        shutil.copy2(source, binary)
        observed = subprocess.check_output([str(binary), '--version'], cwd=directory, text=True).strip()
        if observed != 'femlab ' + v:
            raise ValueError('CLI version differs from release metadata: ' + observed)
        subprocess.run([str(binary), 'bench', '--cpu', '--filter', 'heat-bar-linear'], cwd=directory, check=True)
    archive(root / 'release' / f'femlab-{v}-{target}.zip',
            [(source, executable), (root / 'LICENSE', 'LICENSE')])


def web(root):
    v = version(root)
    for label, source in [('app', root / 'packages/app/dist'), ('wasm', root / 'packages/app/src/generated/wasm')]:
        entries = [(p, p.relative_to(source).as_posix()) for p in source.rglob('*') if p.is_file()]
        if not entries:
            raise ValueError('Missing built ' + label)
        archive(root / 'release' / f'femlab-{v}-{label}.zip', entries + [(root / 'LICENSE', 'LICENSE')])


def checksums(directory):
    files = sorted(p for p in directory.iterdir() if p.is_file() and p.name != 'SHA256SUMS')
    if not files:
        raise ValueError('No release artifacts')
    text = ''.join(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.name + '\n' for p in files)
    (directory / 'SHA256SUMS').write_text(text)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['metadata', 'native', 'web', 'checksums'])
    parser.add_argument('--target')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    if args.operation == 'metadata':
        tag = os.environ.get('GITHUB_REF_NAME') if os.environ.get('GITHUB_EVENT_NAME') == 'push' else None
        value = version(root, tag)
        if os.environ.get('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
                output.write('version=' + value + '\n')
        print(value)
    elif args.operation == 'native':
        if args.target is None:
            parser.error('native requires --target')
        native(root, args.target)
    elif args.operation == 'web':
        web(root)
    else:
        checksums(root / 'release')
