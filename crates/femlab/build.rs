//! Embed the canonical case files in both checkout and cargo-package builds.
use std::{env, fs, path::PathBuf};

fn main() {
    let cases = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("benches/cases");
    println!("cargo:rerun-if-changed={}", cases.display());
    let mut paths: Vec<_> = fs::read_dir(cases)
        .expect("read built-in Benchmark cases")
        .map(|entry| entry.expect("read Benchmark directory entry").path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "json"))
        .collect();
    paths.sort();
    assert!(!paths.is_empty(), "built-in Benchmark cases must be packaged");
    let mut source = String::from("const BUILTIN_CASES: &[(&str, &str)] = &[\n");
    for path in paths {
        source.push_str(&format!("({:?}, include_str!({:?})),\n", path.file_name().unwrap(), path));
    }
    source.push_str("];\n");
    fs::write(PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("benchmark_cases.rs"), source)
        .expect("write embedded Benchmark catalogue");
}
