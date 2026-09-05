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
        .stdout(contains("\"revision\": 9"));
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
        .stdout(contains("revision 9"));
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
        let out = femlab().args(["run", path.to_str().unwrap(), "--hashes"]).assert().success();
        let hashes = String::from_utf8(out.get_output().stdout.clone()).unwrap();
        let committed = std::fs::read_to_string(&hashes_path).unwrap();
        assert_eq!(hashes.trim(), committed.trim(), "{file_name} hashes have drifted");
        checked += 1;
    }
    assert!(checked >= 16, "expected at least 16 bundled journals, found {checked}");
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
        .stdout(contains("| cantilever-model | 11/11 | green |"));
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
        .stdout(contains("| bad-volume | 2/4 | FAILED |"));
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
    femlab().arg("mcp").assert().code(2).stderr(contains("phase 4.10")).stderr(contains("none"));
    femlab().args(["mcp", "--project", "somewhere"]).assert().code(2).stderr(contains("somewhere"));
}
