//! `femlab bench`: every Benchmark is a Journal plus checks on Query results (PLAN rule 8).

use std::path::{Path, PathBuf};

use femlab_engine::query::Query;
use femlab_engine::Command;
use serde::{Deserialize, Serialize};

use crate::run::{dispatch, new_engine};

/// One check: run a Query, pick a value by JSON pointer, compare.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Check {
    pub query: Query,
    /// JSON pointer into the Query result, e.g. `/bodies/0/measure/value`.
    pub path: String,
    pub expect: serde_json::Value,
    #[serde(default)]
    pub tol: f64,
    /// Relative tolerance (default absolute).
    #[serde(default)]
    pub rel: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// A Benchmark case file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Case {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    pub journal: Vec<Command>,
    pub checks: Vec<Check>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CheckResult {
    pub path: String,
    pub got: serde_json::Value,
    pub expect: serde_json::Value,
    pub pass: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CaseResult {
    pub name: String,
    pub pass: bool,
    pub checks: Vec<CheckResult>,
    pub error: Option<String>,
    pub time_ms: f64,
}

pub fn default_cases_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("engine").join("benches").join("cases")
}

pub fn compare(got: &serde_json::Value, expect: &serde_json::Value, tol: f64, rel: bool) -> (bool, String) {
    match (got.as_f64(), expect.as_f64()) {
        (Some(g), Some(e)) => {
            let scale = if rel { e.abs().max(f64::MIN_POSITIVE) } else { 1.0 };
            let diff = (g - e).abs();
            let pass = diff <= tol * scale;
            (
                pass,
                format!("got {g}, expected {e}, |diff| = {diff:.3e} ({} tol {tol})", if rel { "rel" } else { "abs" }),
            )
        }
        _ => (got == expect, format!("got {got}, expected {expect}")),
    }
}

pub fn run_case(case: &Case, threads: Option<usize>, cpu: bool) -> CaseResult {
    let start = std::time::Instant::now();
    let mut engine = new_engine(threads, cpu);
    let mut checks = Vec::new();
    for cmd in &case.journal {
        if let Err(e) = dispatch(&mut engine, cmd.clone()) {
            return CaseResult {
                name: case.name.clone(),
                pass: false,
                checks,
                error: Some(format!("{} failed: {e}", cmd.name())),
                time_ms: start.elapsed().as_secs_f64() * 1000.0,
            };
        }
    }
    let mut pass = true;
    for c in &case.checks {
        let result = match engine.query(c.query.clone()) {
            Ok(r) => serde_json::to_value(r).unwrap_or_default(),
            Err(e) => {
                pass = false;
                checks.push(CheckResult {
                    path: c.path.clone(),
                    got: serde_json::Value::Null,
                    expect: c.expect.clone(),
                    pass: false,
                    detail: format!("query failed: {e}"),
                });
                continue;
            }
        };
        let got = result.pointer(&c.path).cloned().unwrap_or(serde_json::Value::Null);
        let (ok, detail) = compare(&got, &c.expect, c.tol, c.rel);
        pass &= ok;
        checks.push(CheckResult { path: c.path.clone(), got, expect: c.expect.clone(), pass: ok, detail });
    }
    CaseResult { name: case.name.clone(), pass, checks, error: None, time_ms: start.elapsed().as_secs_f64() * 1000.0 }
}

pub fn load_cases(dir: &Path, filter: Option<&str>) -> Result<Vec<Case>, String> {
    let mut cases = Vec::new();
    let entries = std::fs::read_dir(dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
    let mut paths: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    paths.sort();
    for p in paths {
        let text = std::fs::read_to_string(&p).map_err(|e| format!("cannot read {}: {e}", p.display()))?;
        let case: Case = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", p.display()))?;
        if filter.is_none_or(|f| case.name.contains(f)) {
            cases.push(case);
        }
    }
    Ok(cases)
}

/// The check a status row reports: the first with a numeric expectation, which every case
/// leads with — the closed form, the NAFEMS value or the recorded number it is gated on.
fn headline(r: &CaseResult) -> Option<&CheckResult> {
    r.checks.iter().find(|c| c.expect.as_f64().is_some())
}

/// A number for a table: six significant-ish digits, scientific outside a readable range,
/// with the trailing zeros trimmed so the table does not churn on them.
fn num(v: f64) -> String {
    if v != 0.0 && (v.abs() < 1e-3 || v.abs() >= 1e6) {
        return format!("{v:.4e}");
    }
    let s = format!("{v:.6}");
    let t = s.trim_end_matches('0').trim_end_matches('.');
    t.to_string()
}

/// The Benchmark status table: one row per case with what it measured, what it is measured
/// against and how far apart they are. It is what `--update-docs` writes into BENCHMARKS.md,
/// so it carries no timings — those are in `--json`, and they would churn the file.
pub fn markdown(results: &[CaseResult]) -> String {
    let mut s =
        String::from("| Benchmark | Status | Checks | Measured | Reference | Error |\n|---|---|---|---|---|---|\n");
    for r in results {
        let passed = r.checks.iter().filter(|c| c.pass).count();
        let status = if r.pass { "green" } else { "FAILED" };
        let (got, want, err) = match headline(r) {
            Some(c) => {
                let g = c.got.as_f64().unwrap_or(f64::NAN);
                let e = c.expect.as_f64().unwrap_or(f64::NAN);
                (num(g), num(e), format!("{:.2} %", 100.0 * (g - e).abs() / e.abs().max(f64::MIN_POSITIVE)))
            }
            None => ("-".to_string(), "-".to_string(), "-".to_string()),
        };
        s += &format!("| {} | {} | {}/{} | {} | {} | {} |\n", r.name, status, passed, r.checks.len(), got, want, err);
    }
    s
}

/// The markers `--update-docs` rewrites between.
const DOC_START: &str = "<!-- bench:start -->";
const DOC_END: &str = "<!-- bench:end -->";

/// Replace the marked block of a Markdown file with `table`, so BENCHMARKS.md's status is
/// regenerated from a real run rather than edited by hand.
pub fn update_docs(path: &Path, table: &str) -> Result<(), String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let (from, to) = match (text.find(DOC_START), text.find(DOC_END)) {
        (Some(a), Some(b)) if a + DOC_START.len() <= b => (a + DOC_START.len(), b),
        _ => return Err(format!("{} has no '{DOC_START}' … '{DOC_END}' block to update", path.display())),
    };
    let out = format!("{}\n\n{table}\n{}", &text[..from], &text[to..]);
    std::fs::write(path, out).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

#[allow(clippy::too_many_arguments)]
pub fn bench(
    cases_dir: Option<&Path>,
    filter: Option<&str>,
    json: bool,
    md: bool,
    docs: Option<&Path>,
    threads: Option<usize>,
    cpu: bool,
) -> i32 {
    let dir = cases_dir.map(Path::to_path_buf).unwrap_or_else(default_cases_dir);
    let cases = match load_cases(&dir, filter) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    let results: Vec<CaseResult> = cases.iter().map(|c| run_case(c, threads, cpu)).collect();
    if let Some(path) = docs {
        if let Err(e) = update_docs(path, &markdown(&results)) {
            eprintln!("{e}");
            return 1;
        }
        println!("updated {}", path.display());
    }
    if json {
        println!("{}", serde_json::to_string_pretty(&results).unwrap_or_default());
    } else if md {
        print!("{}", markdown(&results));
    } else {
        for r in &results {
            println!("{} {}", if r.pass { "PASS" } else { "FAIL" }, r.name);
            if let Some(e) = &r.error {
                println!("    {e}");
            }
            for c in &r.checks {
                println!("    {} {}: {}", if c.pass { "ok  " } else { "FAIL" }, c.path, c.detail);
            }
        }
    }
    if results.iter().all(|r| r.pass) {
        0
    } else {
        1
    }
}
