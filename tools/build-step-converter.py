#!/usr/bin/env python3
"""Rebuild the standalone LGPL STEP converter and its complete source distribution."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request


if sys.version_info < (3, 12):
    raise SystemExit("Use Python 3.12 or newer; set PYTHON=/path/to/python3.12 for the shell wrapper (emsdk may prepend Python 3.9).")

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor/step-converter"
PINS = json.loads((VENDOR / "pins.json").read_text())


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def fetch(name: str, spec: dict, cache: Path) -> Path:
    target = cache / (name + ".tar.gz")
    if not target.exists():
        partial = target.with_suffix(".download")
        try:
            with urllib.request.urlopen(spec["url"], timeout=60) as response, partial.open("wb") as output:
                shutil.copyfileobj(response, output)
            partial.replace(target)
        finally:
            partial.unlink(missing_ok=True)
    if target.stat().st_size != spec["bytes"] or digest(target) != spec["sha256"]:
        raise RuntimeError(f"Source checksum mismatch: {target}")
    return target


def extract(archive: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as source:
        members = []
        for member in source.getmembers():
            parts = Path(member.name).parts
            if len(parts) < 2:
                continue
            member.name = str(Path(*parts[1:]))
            members.append(member)
        source.extractall(destination, members=members, filter="data")


def run(command: list[str], log: Path, *, env: dict | None = None, cwd: Path | None = None) -> None:
    with log.open("w") as output:
        output.write(json.dumps(command) + "\n")
        output.flush()
        subprocess.run(command, stdout=output, stderr=subprocess.STDOUT, check=True, env=env, cwd=cwd)


def normalized(info: tarfile.TarInfo) -> tarfile.TarInfo:
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    info.mtime = 0
    info.pax_headers = {}
    info.mode = 0o755 if info.isdir() or info.mode & 0o111 else 0o644
    if info.issym():
        info.mode = 0o777
    return info


def source_kit(source: Path, output: Path, work: Path, cache: Path) -> dict:
    # This is the preferred source tree BEFORE the separately supplied local patches.
    kit = work / "source-kit"
    if kit.exists():
        shutil.rmtree(kit)
    (kit / "upstream").mkdir(parents=True)
    shutil.copytree(source, kit / "upstream/occt-import-js", symlinks=True)
    for name, spec in (("emscripten", PINS["runtimeSource"]), ("emsdk", PINS["emsdk"])):
        included = ROOT / "upstream" / name
        if included.is_dir():
            shutil.copytree(included, kit / "upstream" / name, symlinks=True)
        else:
            extract(fetch(name, spec, cache), kit / "upstream" / name)
    (kit / "tools").mkdir()
    for name in ("build-step-converter.py", "build-step-converter.sh"):
        shutil.copyfile(ROOT / "tools" / name, kit / "tools" / name)
    target_vendor = kit / "vendor/step-converter"
    target_vendor.mkdir(parents=True)
    for name in ("pins.json", "package.json", "README.md", "NOTICE.txt"):
        shutil.copyfile(VENDOR / name, target_vendor / name)
    for name in ("patches", "licenses"):
        shutil.copytree(VENDOR / name, target_vendor / name)
    (kit / "README.md").write_text(
        "# FEM Lab STEP converter corresponding source\n\n"
        "The full unmodified wrapper and OCCT source trees are under upstream/occt-import-js.\n"
        "The generated runtime's Emscripten preferred source and the SDK installer source\n"
        "are also included under upstream/emscripten and upstream/emsdk.\n"
        "The separate dated local patches, licenses, source pins and replacement instructions\n"
        "are under vendor/step-converter. Read that README before rebuilding.\n\n"
        "With Emscripten 3.1.69 installed and activated:\n\n"
        "    bash tools/build-step-converter.sh --emsdk /path/to/emsdk "
        "--source-tree upstream/occt-import-js --output-dir result\n\n"
        "This source-tree option uses these included sources without fetching upstream archives.\n"
    )
    target = output / "corresponding-source.tar.gz"
    with target.open("wb") as raw, gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0, compresslevel=9) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for item in [kit, *sorted(kit.rglob("*"))]:
                relative = Path("step-converter-source") / item.relative_to(kit)
                archive.add(item, arcname=str(relative), recursive=False, filter=normalized)
    return {"path": target.name, "sha256": digest(target), "bytes": target.stat().st_size}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, default=Path.home() / ".cache/femlab/step-converter")
    parser.add_argument("--work-dir", type=Path)
    parser.add_argument("--output-dir", type=Path, default=VENDOR)
    parser.add_argument("--emsdk", type=Path, default=Path(os.environ["EMSDK"]) if "EMSDK" in os.environ else None)
    parser.add_argument("--source-tree", type=Path, help="Full unpatched wrapper tree containing the OCCT source subdirectory")
    parser.add_argument("--source-kit-only", action="store_true", help="Assemble complete source distribution without a compiler")
    parser.add_argument("--jobs", type=int, choices=(1, 2), default=2)
    args = parser.parse_args()
    args.output_dir = args.output_dir.resolve()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    work = args.work_dir.resolve() if args.work_dir else Path(tempfile.mkdtemp(prefix="femlab-step-build-"))
    work.mkdir(parents=True, exist_ok=True)
    logs = work / "logs"
    logs.mkdir(exist_ok=True)
    pristine = work / "pristine"
    if pristine.exists():
        raise RuntimeError(f"Use a fresh work directory; existing source is preserved: {pristine}")
    if args.source_tree:
        shutil.copytree(args.source_tree.resolve(), pristine, symlinks=True)
    else:
        archives = {name: fetch(name, spec, args.cache_dir) for name, spec in PINS["upstream"].items()}
        extract(archives["wrapper"], pristine)
        extract(archives["occt"], pristine / "occt")
    if not (pristine / "occt/src/Standard/Standard_Version.hxx").is_file():
        raise RuntimeError("The complete OCCT preferred source is missing")
    kit = source_kit(pristine, args.output_dir, work, args.cache_dir)
    if args.source_kit_only:
        print(json.dumps({"sourceKit": kit}, indent=2))
        return
    if not args.emsdk:
        raise RuntimeError("Pass --emsdk with an installed, activated Emscripten 3.1.69 SDK; see vendor README")
    sdk = args.emsdk.resolve()
    emscripten = sdk / "upstream/emscripten"
    env = dict(os.environ, EMSDK=str(sdk), EM_CONFIG=str(sdk / ".emscripten"),
               EMCC_CORES=str(args.jobs), BINARYEN_CORES=str(args.jobs))
    env["PATH"] = str(emscripten) + os.pathsep + env["PATH"]
    emcc_version = subprocess.check_output([str(emscripten / "emcc"), "--version"], text=True, env=env).strip()
    if not emcc_version.splitlines()[0].endswith("3.1.69 (c55ff404dbe1eb9f263c48b584d5ba627224763a)"):
        raise RuntimeError(f"Expected Emscripten 3.1.69, received {emcc_version}")
    patched = work / "source"
    shutil.copytree(pristine, patched, symlinks=True)
    patches = sorted((VENDOR / "patches").glob("*.patch"))
    for patch in patches:
        run(["patch", "-p1", "--batch", "--input", str(patch)], logs / (patch.stem + ".log"), cwd=patched)
    build = work / "build"
    configure = [str(emscripten / "emcmake"), "cmake", "-S", str(patched), "-B", str(build), "-G", "Unix Makefiles", "-DEMSCRIPTEN=1", "-DCMAKE_BUILD_TYPE=Release"]
    compile_command = ["cmake", "--build", str(build), "--parallel", str(args.jobs)]
    run(configure, logs / "configure.log", env=env)
    run(compile_command, logs / "build.log", env=env)
    (args.output_dir / "dist").mkdir(exist_ok=True)
    artifacts = {"sourceKit": kit}
    for key, extension in (("javascript", "js"), ("wasm", "wasm")):
        artifact = args.output_dir / "dist" / ("occt-import-js." + extension)
        shutil.copyfile(build / "Release" / artifact.name, artifact)
        artifacts[key] = {"path": "dist/" + artifact.name, "sha256": digest(artifact), "bytes": artifact.stat().st_size}
    components = [emscripten / "emcc.py", sdk / "upstream/bin/clang",
                  sdk / "upstream/bin/wasm-ld", sdk / "upstream/bin/wasm-opt",
                  *sorted((sdk / "node").glob("*/bin/node"))]
    components = [{"path": str(p.relative_to(sdk)), "sha256": digest(p), "bytes": p.stat().st_size}
                  for p in components if p.is_file()]
    manifest = {
        "version": PINS["version"], "upstream": PINS["upstream"], "runtimeSource": PINS["runtimeSource"],
        "patches": [{"path": "patches/" + p.name, "sha256": digest(p)} for p in patches],
        "toolchain": {"emscripten": "3.1.69", "emsdk": PINS["emsdk"], "emcc": emcc_version,
                      "components": components,
                      "cmake": subprocess.check_output(["cmake", "--version"], text=True).splitlines()[0],
                      "python": platform.python_version(),
                      "emccPython": subprocess.check_output([shutil.which("python3", path=env["PATH"]), "--version"], text=True).strip(),
                      "clang": subprocess.check_output([str(sdk / "upstream/bin/clang"), "--version"], text=True).strip(),
                      "wasmOpt": subprocess.check_output([str(sdk / "upstream/bin/wasm-opt"), "--version"], text=True).strip(),
                      "node": subprocess.check_output([str(next((sdk / "node").glob("*/bin/node"))), "--version"], text=True).strip(),
                      "make": subprocess.check_output(["make", "--version"], text=True).splitlines()[0],
                      "platform": platform.platform()},
        "build": {"script": "tools/build-step-converter.sh", "jobs": args.jobs,
                  "invocation": configure, "compileInvocation": compile_command,
                  "environment": {"EMCC_CORES": str(args.jobs), "BINARYEN_CORES": str(args.jobs)},
                  "sourceInput": "included-source-tree" if args.source_tree else "verified-upstream-archives"},
        "limits": {"inputBytes": 16777216, "triangles": 500000},
        "notices": [{"path": str(p.relative_to(VENDOR)), "sha256": digest(p), "bytes": p.stat().st_size}
                    for p in [VENDOR / "NOTICE.txt", *sorted((VENDOR / "licenses").glob("*"))]],
        "recipes": [{"path": "tools/" + name, "sha256": digest(ROOT / "tools" / name)}
                    for name in ("build-step-converter.py", "build-step-converter.sh")],
        "artifacts": artifacts,
    }
    (args.output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
