//! Installed-binary checks run in their own process (#318).
//!
//! Keep this a single-test binary: sibling CLI tests spawn subprocesses, and on Linux
//! a concurrent fork can inherit the executable copy's writable descriptor until exec.
//! Closing our descriptor alone then does not prevent ETXTBSY (rust-lang/rust#114554).
//! Isolation removes that writer/fork race without serializing the other CLI tests.

use std::path::PathBuf;

use assert_cmd::Command;
use predicates::str::contains;

#[test]
fn copied_cli_embeds_canonical_cases_and_honors_explicit_directories() {
    let installed = std::env::temp_dir().join(format!("femlab-installed-cli-{}", std::process::id()));
    std::fs::create_dir(&installed).unwrap();
    let binary = installed.join(format!("femlab{}", std::env::consts::EXE_SUFFIX));
    std::fs::copy(assert_cmd::cargo::cargo_bin("femlab"), &binary).unwrap();
    let cases = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("benches/cases");
    let embedded = Command::new(&binary)
        .current_dir(&installed)
        .args(["bench", "--cpu", "--json"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let explicit = Command::new(&binary)
        .current_dir(&installed)
        .args(["bench", "--cpu", "--json", "--cases", cases.to_str().unwrap()])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let mut embedded: serde_json::Value = serde_json::from_slice(&embedded).unwrap();
    let mut explicit: serde_json::Value = serde_json::from_slice(&explicit).unwrap();
    for report in [&mut embedded, &mut explicit] {
        for case in report.as_array_mut().unwrap() {
            case.as_object_mut().unwrap().remove("time_ms");
        }
    }
    assert_eq!(embedded, explicit);
    let heat = Command::new(&binary)
        .current_dir(&installed)
        .args(["bench", "--cpu", "--json", "--filter", "heat-bar-linear"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let heat: serde_json::Value = serde_json::from_slice(&heat).unwrap();
    assert_eq!(heat.as_array().unwrap().len(), 1);
    let checks = heat[0]["checks"].as_array().unwrap();
    for expected in [25.0, 50.0] {
        let check = checks.iter().find(|check| check["expect"].as_f64() == Some(expected)).unwrap();
        assert!((check["got"].as_f64().unwrap() - expected).abs() < 1e-8);
        assert_eq!(check["pass"], true);
    }
    let custom = installed.join("custom");
    std::fs::create_dir_all(&custom).unwrap();
    Command::new(&binary)
        .current_dir(&installed)
        .args(["bench", "--cpu", "--json", "--cases", "custom"])
        .assert()
        .success()
        .stdout("[]\n");
    std::fs::write(
        custom.join("volume.json"),
        serde_json::json!({
            "name": "packaged-custom-volume", "journal": [
                {"cmd":"model.new","name":"custom"},
                {"cmd":"geometry.addBox","name":"box","size":["2 m","3 m","4 m"]}
            ], "checks": [{"query":{"query":"query.model"},"path":"/bodies/0/measure/value","expect":24,"tol":1e-12}]
        })
        .to_string(),
    )
    .unwrap();
    Command::new(&binary)
        .current_dir(&installed)
        .args(["bench", "--cpu", "--cases", "custom"])
        .assert()
        .success()
        .stdout(contains("PASS packaged-custom-volume"))
        .stdout(contains("got 24, expected 24"));
    Command::new(&binary)
        .current_dir(&installed)
        .args(["bench", "--cases", "missing"])
        .assert()
        .failure()
        .stderr(contains("cannot read missing"));
    std::fs::remove_dir_all(installed).unwrap();
}
