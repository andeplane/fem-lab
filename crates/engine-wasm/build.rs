use std::{env, fs, path::PathBuf};

fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let source = manifest.join("../../packages/registry/src/generated/engine.schema.json");
    println!("cargo:rerun-if-changed={}", source.display());

    let pretty = fs::read_to_string(&source).expect("read generated engine schema");
    let mut compact = String::with_capacity(pretty.len());
    let mut in_string = false;
    let mut escaped = false;
    for ch in pretty.chars() {
        if in_string {
            compact.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
        } else if ch == '"' {
            in_string = true;
            compact.push(ch);
        } else if !ch.is_whitespace() {
            compact.push(ch);
        }
    }
    assert!(!in_string, "generated engine schema contains an unterminated string");

    let out = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR")).join("engine.schema.json");
    fs::write(out, compact).expect("write compact engine schema");
}
