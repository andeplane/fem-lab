use assert_cmd::Command;

#[test]
fn version_prints_all_three() {
    Command::cargo_bin("femlab").unwrap().arg("version").assert().success().stdout(predicates::str::contains("engine"));
}
