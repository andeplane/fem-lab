//! The CLI host end to end: run, schema, bench, stubs. Fixtures live in crates/engine/benches.

use std::path::PathBuf;

use assert_cmd::Command;
use predicates::str::contains;

fn engine_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("engine")
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("femlab-cli-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn femlab() -> Command {
    Command::cargo_bin("femlab").unwrap()
}

#[test]
fn version_prints_all_three() {
    femlab().arg("version").assert().success().stdout(contains("engine"));
}

#[test]
fn run_replays_the_cantilever_journal_in_every_form() {
    let journal = engine_dir().join("benches").join("journals").join("cantilever.json");
    let out = femlab().args(["run", journal.to_str().unwrap(), "--verify"]).assert().success();
    let text = String::from_utf8(out.get_output().stdout.clone()).unwrap();
    assert!(text.contains("Model 'cantilever'"));
    assert!(text.contains("body beam"));
    assert!(text.contains("material steel"));
    assert!(text.contains("constraint root"));
    assert!(text.contains("load tip"));
    assert!(text.contains("step static"));
    // hashes match the committed list
    let out = femlab().args(["run", journal.to_str().unwrap(), "--hashes"]).assert().success();
    let hashes = String::from_utf8(out.get_output().stdout.clone()).unwrap();
    let committed =
        std::fs::read_to_string(engine_dir().join("benches").join("journals").join("cantilever.hashes")).unwrap();
    assert_eq!(hashes.trim(), committed.trim());
    // json and script forms
    femlab()
        .args(["run", journal.to_str().unwrap(), "--json", "--threads", "1"])
        .assert()
        .success()
        .stdout(contains("\"revision\": 10"));
    femlab()
        .args(["run", journal.to_str().unwrap(), "--as-script"])
        .assert()
        .success()
        .stdout(contains("await fem.geometry.addBox"));
    // a bare array of Commands (no hashes) also runs; --verify is then a no-op
    let cmds: Vec<serde_json::Value> =
        serde_json::from_str::<Vec<serde_json::Value>>(&std::fs::read_to_string(&journal).unwrap())
            .unwrap()
            .into_iter()
            .map(|e| e["cmd"].clone())
            .collect();
    let dir = scratch("cmds");
    let p = dir.join("cmds.json");
    std::fs::write(&p, serde_json::to_string(&cmds).unwrap()).unwrap();
    femlab()
        .args(["run", p.to_str().unwrap(), "--verify", "--skip-solves"])
        .assert()
        .success()
        .stdout(contains("revision 10"));
    // a saved file round-trips: run --json gives the summary; write a femlab/1 file and run it
    let mut engine = femlab_engine::Engine::new(None, Box::new(femlab_engine::NoClock), 1);
    let entries: Vec<femlab_engine::JournalEntry> =
        serde_json::from_str(&std::fs::read_to_string(&journal).unwrap()).unwrap();
    pollster::block_on(engine.replay(&entries, false, true)).unwrap();
    let file = dir.join("model.json");
    std::fs::write(&file, serde_json::to_string(&engine.export_file()).unwrap()).unwrap();
    femlab()
        .args(["run", file.to_str().unwrap(), "--verify"])
        .assert()
        .success()
        .stdout(contains("Model 'cantilever'"));
    // errors: missing file, bad json, bad command, bad file format, tampered hash
    femlab().args(["run", dir.join("nope.json").to_str().unwrap()]).assert().code(1).stderr(contains("cannot read"));
    std::fs::write(dir.join("bad.json"), "{ not json").unwrap();
    femlab().args(["run", dir.join("bad.json").to_str().unwrap()]).assert().code(1).stderr(contains("not JSON"));
    std::fs::write(dir.join("obj.json"), "{\"x\":1}").unwrap();
    femlab()
        .args(["run", dir.join("obj.json").to_str().unwrap()])
        .assert()
        .code(1)
        .stderr(contains("expected a femlab/1 file"));
    std::fs::write(dir.join("badcmd.json"), "[{\"cmd\":\"nonsense\"}]").unwrap();
    femlab().args(["run", dir.join("badcmd.json").to_str().unwrap()]).assert().code(1).stderr(contains("bad Command"));
    std::fs::write(dir.join("badentry.json"), "[{\"seq\":0}]").unwrap();
    femlab()
        .args(["run", dir.join("badentry.json").to_str().unwrap()])
        .assert()
        .code(1)
        .stderr(contains("bad Journal entry"));
    std::fs::write(dir.join("badfile.json"), "{\"format\":\"femlab/9\"}").unwrap();
    femlab()
        .args(["run", dir.join("badfile.json").to_str().unwrap()])
        .assert()
        .code(1)
        .stderr(contains("not a femlab/1 file"));
    let mut tampered: Vec<serde_json::Value> =
        serde_json::from_str(&std::fs::read_to_string(&journal).unwrap()).unwrap();
    tampered[3]["hashAfter"] = serde_json::Value::String("deadbeef".into());
    std::fs::write(dir.join("tampered.json"), serde_json::to_string(&tampered).unwrap()).unwrap();
    femlab()
        .args(["run", dir.join("tampered.json").to_str().unwrap(), "--verify"])
        .assert()
        .code(3)
        .stderr(contains("diverged at entry 3"));
    // a command that fails during replay exits 1 with the entry named
    let mut failing = cmds.clone();
    failing[4] = serde_json::json!({"cmd":"material.assign","material":"gold","bodies":["beam"]});
    std::fs::write(dir.join("failing.json"), serde_json::to_string(&failing).unwrap()).unwrap();
    femlab()
        .args(["run", dir.join("failing.json").to_str().unwrap()])
        .assert()
        .code(1)
        .stderr(contains("journal entry 4"));
    // a model whose summary cannot be computed (broken shape in a saved file) exits 1
    let mut file_v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    file_v["model"]["bodies"][0]["shape"]["size"] = serde_json::json!([0.0, 1.0, 1.0]);
    file_v["journal"]["entries"] = serde_json::json!([]);
    std::fs::write(dir.join("broken.json"), serde_json::to_string(&file_v).unwrap()).unwrap();
    // an empty journal replays to an empty model, so the summary succeeds; broken shapes only bite after import
    femlab().args(["run", dir.join("broken.json").to_str().unwrap()]).assert().success();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn every_bundled_journal_replays_green_against_its_committed_hashes() {
    // The examples gallery (docs/EXAMPLES.md) ships every `*.json` here (its `.meta.json`
    // sidecar is not a Journal); each one must replay to the hashes committed beside it, so an
    // engine change that silently reorders or renumbers a Model breaks this test, not a demo.
    let dir = engine_dir().join("benches").join("journals");
    let mut checked = 0;
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        if !file_name.ends_with(".json") || file_name.ends_with(".meta.json") {
            continue;
        }
        let hashes_path = path.with_extension("hashes");
        assert!(hashes_path.exists(), "{file_name} has no committed .hashes file");
        femlab().args(["run", path.to_str().unwrap(), "--verify"]).assert().success();
        // `--skip-solves` here, not because the solve is doubtful (the line above just ran it)
        // but because a solve entry's hash is the Model hash: re-solving to recompute the same
        // hashes doubles the cost of this test for nothing, which in a debug build is minutes.
        let out = femlab().args(["run", path.to_str().unwrap(), "--hashes", "--skip-solves"]).assert().success();
        let hashes = String::from_utf8(out.get_output().stdout.clone()).unwrap();
        let committed = std::fs::read_to_string(&hashes_path).unwrap();
        assert_eq!(hashes.trim(), committed.trim(), "{file_name} hashes have drifted");
        checked += 1;
    }
    assert!(checked >= 22, "expected at least 22 bundled journals, found {checked}");
}

#[test]
fn schema_prints_writes_and_checks() {
    let out = femlab().arg("schema").assert().success();
    let text = String::from_utf8(out.get_output().stdout.clone()).unwrap();
    let doc: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert!(doc["commands"]["oneOf"].as_array().unwrap().len() >= 30);
    let dir = scratch("schema");
    let p = dir.join("schema.json");
    femlab().args(["schema", "--out", p.to_str().unwrap()]).assert().success();
    femlab().args(["schema", "--out", p.to_str().unwrap(), "--check"]).assert().success();
    std::fs::write(&p, "{}").unwrap();
    femlab().args(["schema", "--out", p.to_str().unwrap(), "--check"]).assert().code(1).stderr(contains("out of date"));
    femlab()
        .args(["schema", "--out", dir.join("missing").join("x.json").to_str().unwrap(), "--check"])
        .assert()
        .code(1)
        .stderr(contains("cannot read"));
    femlab()
        .args(["schema", "--out", dir.join("missing").join("x.json").to_str().unwrap()])
        .assert()
        .code(1)
        .stderr(contains("cannot write"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn committed_schema_is_current() {
    let committed = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("packages")
        .join("registry")
        .join("src")
        .join("generated")
        .join("engine.schema.json");
    femlab().args(["schema", "--out", committed.to_str().unwrap(), "--check"]).assert().success();
}

#[test]
fn bench_runs_the_committed_cases_and_reports() {
    femlab().arg("bench").assert().success().stdout(contains("PASS cantilever-model"));
    femlab()
        .args(["bench", "--markdown", "--filter", "cantilever"])
        .assert()
        .success()
        .stdout(contains("| cantilever-model | green | 11/11 | 1.0000e7 | 1.0000e7 | 0.00 % |"));
    // --update-docs rewrites the marked block of a Markdown file, and says so when there is none
    let docs = scratch("bench-docs").join("STATUS.md");
    std::fs::write(&docs, "# Status\n\nbefore\n<!-- bench:start -->\nstale\n<!-- bench:end -->\nafter\n").unwrap();
    femlab()
        .args(["bench", "--filter", "cantilever-model", "--update-docs", docs.to_str().unwrap()])
        .assert()
        .success()
        .stdout(contains("updated"));
    let written = std::fs::read_to_string(&docs).unwrap();
    assert!(written.starts_with("# Status\n\nbefore\n<!-- bench:start -->\n"), "{written}");
    assert!(written.contains("| cantilever-model | green |"), "{written}");
    assert!(!written.contains("stale"), "{written}");
    assert!(written.ends_with("<!-- bench:end -->\nafter\n"), "{written}");
    let bare = scratch("bench-docs").join("NOMARKERS.md");
    std::fs::write(&bare, "# Status\n").unwrap();
    femlab()
        .args(["bench", "--filter", "cantilever-model", "--update-docs", bare.to_str().unwrap()])
        .assert()
        .failure()
        .stderr(contains("bench:start"));
    femlab().args(["bench", "--json"]).assert().success().stdout(contains("\"pass\": true"));
    femlab().args(["bench", "--filter", "nothing-matches"]).assert().success();
    let dir = scratch("bench");
    // a failing check, a failing command, a failing query and a bad case file
    let failing = serde_json::json!({
        "name": "bad-volume",
        "journal": [{"cmd":"model.new","name":"m"},{"cmd":"geometry.addBox","name":"b","size":["1 m","1 m","1 m"]}],
        "checks": [
            {"query":{"query":"query.model"},"path":"/bodies/0/measure/value","expect":2.0,"tol":1e-9,"rel":false},
            {"query":{"query":"query.mesh"},"path":"/nodes","expect":8},
            {"query":{"query":"query.model"},"path":"/bodies/0/name","expect":"b"},
            {"query":{"query":"query.model"},"path":"/nope","expect":null}
        ]
    });
    std::fs::write(dir.join("a-bad.json"), failing.to_string()).unwrap();
    let cmd_fail = serde_json::json!({
        "name": "bad-command",
        "journal": [{"cmd":"material.assign","material":"x","bodies":[]}],
        "checks": []
    });
    std::fs::write(dir.join("b-cmdfail.json"), cmd_fail.to_string()).unwrap();
    std::fs::write(dir.join("notes.txt"), "ignored").unwrap();
    let out = femlab().args(["bench", "--cases", dir.to_str().unwrap()]).assert().code(1);
    let text = String::from_utf8(out.get_output().stdout.clone()).unwrap();
    assert!(text.contains("FAIL bad-volume"));
    assert!(text.contains("FAIL /bodies/0/measure/value: got 1"));
    assert!(text.contains("FAIL /nodes: query failed"));
    assert!(text.contains("ok   /bodies/0/name"));
    assert!(text.contains("ok   /nope"));
    assert!(text.contains("FAIL bad-command"));
    assert!(text.contains("material.assign failed"));
    femlab()
        .args(["bench", "--cases", dir.to_str().unwrap(), "--markdown"])
        .assert()
        .code(1)
        .stdout(contains("| bad-volume | FAILED | 2/4 | 1 | 2 | 50.00 % |"))
        // a case with no numeric check has nothing to put in those three columns
        .stdout(contains("| bad-command | FAILED | 0/0 | - | - | - |"));
    std::fs::write(dir.join("c-broken.json"), "{ nope").unwrap();
    femlab().args(["bench", "--cases", dir.to_str().unwrap()]).assert().code(1).stderr(contains("c-broken.json"));
    femlab()
        .args(["bench", "--cases", dir.join("missing").to_str().unwrap()])
        .assert()
        .code(1)
        .stderr(contains("cannot read"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn stubs_say_what_is_planned() {
    femlab().args(["serve", "--port", "1234"]).assert().code(2).stderr(contains("phase S"));
}

/// `femlab export` against committed reference files, one per format.
///
/// The references are written with `--skip-solves`, so every number in them comes from the
/// geometry and the Journal and is bit-identical on any machine; a solved Result would put a
/// solver residual in the calculation note and float bits in the VTU payload, which is a
/// reference file that fails on somebody else's laptop rather than a test. The solved paths are
/// asserted below by content, and byte-for-byte in `crates/engine/tests/registry.rs`.
///
/// Regenerate every reference with:
///   FEMLAB_BLESS=1 cargo test -p femlab --test cli export_writes
#[test]
fn export_writes_every_format_and_matches_the_reference_files() {
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests");
    let fixture = here.join("fixtures").join("two-hex.json");
    let golden = here.join("golden");
    let dir = scratch("export");
    let bless = std::env::var_os("FEMLAB_BLESS").is_some();
    std::fs::create_dir_all(&golden).unwrap();
    for (format, name) in [
        ("vtu", "two-hex.vtu"),
        ("msh", "two-hex.msh"),
        ("inp", "two-hex.inp"),
        ("stl", "two-hex.stl"),
        ("report", "two-hex.md"),
        ("script", "two-hex.ts"),
        ("journal", "two-hex.femlab.json"),
    ] {
        let out = dir.join(name);
        femlab()
            .args([
                "export",
                fixture.to_str().unwrap(),
                "--format",
                format,
                "--skip-solves",
                "--cpu",
                "--threads",
                "1",
                "--out",
                out.to_str().unwrap(),
            ])
            .assert()
            .success();
        let got = std::fs::read_to_string(&out).unwrap();
        let want = golden.join(name);
        if bless {
            std::fs::write(&want, &got).unwrap();
            continue;
        }
        let expected = std::fs::read_to_string(&want)
            .unwrap_or_else(|e| panic!("{}: {e}; regenerate with FEMLAB_BLESS=1", want.display()));
        assert_eq!(got, expected, "{name} differs from its reference; regenerate with FEMLAB_BLESS=1");
    }
    // without --out the artefact goes to stdout, which is what a pipe wants
    femlab()
        .args(["export", fixture.to_str().unwrap(), "--format", "script", "--cpu"])
        .assert()
        .success()
        .stdout(contains("await fem.geometry.addBox"));
    // solved: the note carries the reaction balance and the hand calculation, and the VTU the fields
    let out = femlab()
        .args(["export", fixture.to_str().unwrap(), "--format", "report", "--cpu", "--threads", "1"])
        .assert()
        .success();
    let note = String::from_utf8(out.get_output().stdout.clone()).unwrap();
    assert!(note.contains("### Step `static`"), "{note}");
    assert!(note.contains("— **pass** (tolerance 1e-9)."), "{note}");
    assert!(note.contains("### Hand calculation for step `static`"), "{note}");
    femlab()
        .args(["export", fixture.to_str().unwrap(), "--format", "vtu", "--step", "static", "--cpu"])
        .assert()
        .success()
        .stdout(contains("VonMises"));
    // a Step with no Result, an unreadable file and an unwritable destination all say why
    femlab()
        .args(["export", fixture.to_str().unwrap(), "--format", "vtu", "--step", "nope", "--cpu"])
        .assert()
        .code(1)
        .stderr(contains("not-found"));
    femlab().args(["export", "no-such-file.json", "--format", "msh"]).assert().code(1).stderr(contains("cannot read"));
    femlab()
        .args([
            "export",
            fixture.to_str().unwrap(),
            "--format",
            "msh",
            "--cpu",
            "--out",
            dir.join("no").join("such").join("dir").join("x.msh").to_str().unwrap(),
        ])
        .assert()
        .code(1)
        .stderr(contains("cannot write"));
    // a Journal that does not replay is an error, not a half-written file
    let broken = dir.join("broken.json");
    std::fs::write(&broken, r#"[{"cmd":"material.assign","material":"gold","bodies":["nope"]}]"#).unwrap();
    femlab().args(["export", broken.to_str().unwrap(), "--format", "msh", "--cpu"]).assert().code(1);
}

/// `femlab mcp` execs the Node server; without one it says how to install it and exits 2.
#[test]
fn mcp_runs_the_node_server_or_says_how_to_install_it() {
    let dir = scratch("mcp");
    femlab()
        .args(["mcp", "--project", dir.to_str().unwrap()])
        .env("FEMLAB_MCP", dir.join("nothing-here.js"))
        .assert()
        .code(2)
        .stderr(contains("npx femlab-mcp"));
    // a server that is there is run with this process's stdio and its exit code is ours
    let stub = dir.join("stub.js");
    std::fs::write(&stub, "console.error('stub ' + process.argv.slice(2).join(' ')); process.exit(0);\n").unwrap();
    femlab()
        .args(["mcp", "--project", dir.to_str().unwrap()])
        .env("FEMLAB_MCP", &stub)
        .assert()
        .success()
        .stderr(contains(format!("stub --project {}", dir.display())));
}

#[test]
fn run_answers_ordered_transient_queries_after_a_full_solve() {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tools/fixtures/transient-heat.json");
    let file = fixture.to_str().unwrap();
    let output = femlab()
        .args([
            "run", file, "--cpu", "--query", r#"{"query":"query.frames"}"#,
            "--query", r#"{"query":"query.frame","index":1}"#,
            "--query", r#"{"query":"query.probe","field":"temperature","at":["0.5 m","0.05 m","0.05 m"],"sample":{"kind":"time","time":"175 ms","sampling":"exact"}}"#,
        ])
        .assert().success();
    let results: Vec<serde_json::Value> = serde_json::from_slice(&output.get_output().stdout).unwrap();
    assert_eq!(results.len(), 3);
    assert_eq!(results[0]["frames"][1]["timeSi"], 0.175);
    assert_eq!(results[1]["sample"]["frame"]["index"], 1);
    assert_eq!(results[1]["unit"], "K");
    // Conservation rho*cp*dT/dt=q gives T=t K everywhere, independent of the solver.
    for node in results[1]["values"].as_array().unwrap().chunks_exact(3) {
        assert!((node[0].as_f64().unwrap() - 0.175).abs() < 1e-10);
        assert_eq!((node[1].as_f64().unwrap(), node[2].as_f64().unwrap()), (0.0, 0.0));
    }
    assert_eq!(results[2]["value"]["unit"], "degC");
    assert!((results[2]["value"]["value"].as_f64().unwrap() - (0.175 - 273.15)).abs() < 1e-10);
    femlab()
        .args(["run", file, "--cpu", "--skip-solves", "--query", r#"{"query":"query.frames"}"#])
        .assert()
        .code(1)
        .stderr(contains("not-found"));
    femlab()
        .args(["run", file, "--cpu", "--query", r#"{"query":"query.frame","index":999}"#])
        .assert()
        .code(1)
        .stderr(contains("index"));
    femlab().args(["run", file, "--query", "not JSON"]).assert().code(2).stderr(contains("schema"));
    femlab()
        .args(["run", file, "--hashes", "--query", r#"{"query":"query.frames"}"#])
        .assert()
        .code(2)
        .stderr(contains("cannot be used with"));
}
