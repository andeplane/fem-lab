//! Pre-mesh diagnostics describe the geometry the current mesher actually consumes.
use super::{engine, err, ok, probe_at, result_of, Engine, ErrorCode, Field};

fn sheet(e: &mut Engine, name: &str) {
    ok(
        e,
        &serde_json::json!({
            "cmd":"geometry.add", "name":name,
            "shape":{"kind":"sheet","sketch":{"outer":[
                {"kind":"line","to":["1 m","0 m"],"tag":"ymin"},
                {"kind":"line","to":["1 m","1 m"],"tag":"xmax"},
                {"kind":"line","to":["0 m","1 m"],"tag":"ymax"},
                {"kind":"line","to":["0 m","0 m"],"tag":"xmin"}
            ]}}
        })
        .to_string(),
    );
}

fn selected_sheet(e: &mut Engine) {
    ok(e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStress","thickness":"2 mm"}}"#);
    sheet(e, "used");
    sheet(e, "unused");
    ok(e, r#"{"cmd":"geometry.addBox","name":"unused3d","size":["1 m","1 m","1 m"]}"#);
    ok(e, r#"{"cmd":"mesh.set","mesher":{"kind":"free","of":"used","size":"500 mm"}}"#);
}

fn heat_boundaries(e: &mut Engine) {
    ok(e, r#"{"cmd":"constraint.temperature","name":"cold","on":"used.xmin","value":"0 K"}"#);
    ok(e, r#"{"cmd":"constraint.temperature","name":"hot","on":"used.xmax","value":"1 K"}"#);
    ok(e, r#"{"cmd":"step.add","name":"heat","procedure":"heat-steady","constraints":["cold","hot"],"loads":[]}"#);
}

#[test]
fn selected_free_heat_ignores_unassigned_and_wrong_dimension_geometry() {
    let mut e = engine();
    selected_sheet(&mut e);
    ok(&mut e, r#"{"cmd":"material.add","name":"conductor","k":"10 W/(m*K)"}"#);
    ok(&mut e, r#"{"cmd":"material.assign","material":"conductor","bodies":["used"]}"#);
    heat_boundaries(&mut e);
    for size in ["500 mm", "250 mm"] {
        ok(&mut e, &serde_json::json!({"cmd":"mesh.set","mesher":{"kind":"free","of":"used","size":size}}).to_string());
        assert!(e.warnings().is_empty(), "{:?}", e.warnings());
        ok(&mut e, r#"{"cmd":"solve.run","step":"heat","solver":"cpu-direct"}"#);
        for (x, expected) in [("0.25 m", 0.25), ("0.75 m", 0.75)] {
            // Independent Fourier solution: T(x)=x/L between 0 K and 1 K, L=1 m.
            assert!((probe_at(&mut e, "heat", Field::Temperature, None, [x, "0.5 m", "0 m"]) - expected).abs() < 1e-12);
        }
        let result = result_of(&mut e, Some("heat"));
        assert!(!result.stale);
        assert!(result.balance < 1e-12);
        let cold = result.reactions.iter().find(|row| row.constraint == "cold").unwrap();
        let hot = result.reactions.iter().find(|row| row.constraint == "hot").unwrap();
        // Independent heat flow: k A DeltaT/L = 10 * (1 * 0.002) * 1 / 1 = 0.02 W.
        assert!((cold.total[0].value - 0.02).abs() < 1e-12);
        assert!((hot.total[0].value + 0.02).abs() < 1e-12);
        assert_eq!(cold.total[0].unit, "W");
    }
    assert_eq!(e.model().bodies.len(), 3, "ignored definitions remain authored geometry");
}

#[test]
fn selected_free_mechanics_ignores_unassigned_and_wrong_dimension_geometry() {
    let mut e = engine();
    selected_sheet(&mut e);
    ok(&mut e, r#"{"cmd":"material.add","name":"solid","E":"1 GPa","nu":0}"#);
    ok(&mut e, r#"{"cmd":"material.assign","material":"solid","bodies":["used"]}"#);
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"root","on":"used.xmin"}"#);
    ok(&mut e, r#"{"cmd":"load.traction","name":"pull","on":"used.xmax","total":["1 N","0 N","0 N"]}"#);
    ok(&mut e, r#"{"cmd":"step.add","name":"pull","procedure":"static","constraints":["root"],"loads":["pull"]}"#);
    for size in ["500 mm", "250 mm"] {
        ok(&mut e, &serde_json::json!({"cmd":"mesh.set","mesher":{"kind":"free","of":"used","size":size}}).to_string());
        assert!(e.warnings().is_empty(), "{:?}", e.warnings());
        ok(&mut e, r#"{"cmd":"solve.run","step":"pull","solver":"cpu-direct"}"#);
        // No Poisson coupling: ux=F x/(E A), A=1 m*0.002 m, so ux(L)=5e-7 m.
        assert!((probe_at(&mut e, "pull", Field::Displacement, Some(0), ["1 m", "0.5 m", "0 m"]) - 5e-7).abs() < 1e-14);
        let result = result_of(&mut e, Some("pull"));
        assert!(!result.stale);
        assert!((result.reactions[0].total[0].value + 1.0).abs() < 1e-10);
    }
}

#[test]
fn selected_free_body_keeps_its_global_missing_material_and_dimension_diagnostics() {
    let mut e = engine();
    selected_sheet(&mut e);
    heat_boundaries(&mut e);
    let warnings = e.warnings();
    let missing: Vec<_> = warnings.iter().filter(|w| w.code == "model.no-material").collect();
    assert_eq!(missing.len(), 1);
    assert_eq!(missing[0].where_.as_deref(), Some("body 'used'"));
    assert_eq!(missing[0].step, None, "material assignment is shared by all Steps on this mesh");
    let error = err(&mut e, r#"{"cmd":"solve.run","step":"heat","solver":"cpu-direct"}"#);
    assert_eq!(error.code, ErrorCode::ModelNoMaterial);
    assert_eq!(error.where_.as_deref(), Some("body 'used'"));

    ok(&mut e, r#"{"cmd":"material.add","name":"conductor","k":"10 W/(m*K)"}"#);
    ok(&mut e, r#"{"cmd":"material.assign","material":"conductor","bodies":["unused3d"]}"#);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"free","of":"unused3d","size":"500 mm"}}"#);
    let warnings = e.warnings();
    let dimension = warnings.iter().find(|w| w.code == "model.ill-posed").unwrap();
    assert_eq!(dimension.where_.as_deref(), Some("body 'unused3d'"));
    assert_eq!(dimension.step, None);
    assert!(dimension.text.contains("3D but the idealisation is 2D"));
    assert!(!warnings.iter().any(|w| w.code == "model.no-material"));
}

#[test]
fn selected_free_body_keeps_its_step_material_requirements() {
    let mut e = engine();
    selected_sheet(&mut e);
    ok(&mut e, r#"{"cmd":"material.add","name":"conductor","k":"10 W/(m*K)","rho":"1000 kg/m^3"}"#);
    ok(&mut e, r#"{"cmd":"material.assign","material":"conductor","bodies":["used"]}"#);
    heat_boundaries(&mut e);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"heat","procedure":"heat-transient","constraints":["cold","hot"],"loads":[],"dt":"1 ms","tEnd":"2 ms"}"#,
    );
    let warnings = e.warnings();
    assert_eq!(warnings.len(), 1);
    assert_eq!(warnings[0].code, "material.missing-property");
    assert_eq!(warnings[0].step.as_deref(), Some("heat"));
    assert_eq!(warnings[0].where_.as_deref(), Some("material 'conductor'"));
    assert!(warnings[0].text.contains("positive cp"));
}

#[test]
fn mapped_implicit_body_ignores_other_geometry_but_still_needs_its_material() {
    let mut e = engine();
    selected_sheet(&mut e);
    ok(
        &mut e,
        r#"{"cmd":"mesh.set","mesher":{"kind":"mapped","body":"mapped","blocks":[{"corners":[["0 m","0 m"],["1 m","0 m"],["1 m","1 m"],["0 m","1 m"]],"n":[2,2],"tags":["bottom","right","top","left"]}]}}"#,
    );
    let warnings = e.warnings();
    let missing: Vec<_> = warnings.iter().filter(|w| w.code == "model.no-material").collect();
    assert_eq!(missing.len(), 1);
    assert_eq!(missing[0].where_.as_deref(), Some("body 'mapped'"));
    assert_eq!(missing[0].step, None);
    assert!(!warnings.iter().any(|w| w.code == "model.ill-posed"));
    ok(&mut e, r#"{"cmd":"material.add","name":"solid","E":"1 GPa","nu":0}"#);
    ok(&mut e, r#"{"cmd":"material.assign","material":"solid","bodies":["mapped"]}"#);
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"root","on":"mapped.left"}"#);
    ok(&mut e, r#"{"cmd":"load.traction","name":"pull","on":"mapped.right","total":["1 N","0 N","0 N"]}"#);
    ok(&mut e, r#"{"cmd":"step.add","name":"pull","procedure":"static","constraints":["root"],"loads":["pull"]}"#);
    assert!(e.warnings().is_empty(), "{:?}", e.warnings());
    ok(&mut e, r#"{"cmd":"solve.run","step":"pull","solver":"cpu-direct"}"#);
    assert!((probe_at(&mut e, "pull", Field::Displacement, Some(0), ["1 m", "0.5 m", "0 m"]) - 5e-7).abs() < 1e-14);
}

#[test]
fn whole_model_meshers_and_no_selection_keep_all_body_requirements() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStress","thickness":"2 mm"}}"#);
    sheet(&mut e, "used");
    sheet(&mut e, "unused");
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"unused3d","size":["1 m","1 m","1 m"]}"#);
    ok(&mut e, r#"{"cmd":"material.add","name":"solid","E":"1 GPa","nu":0}"#);
    ok(&mut e, r#"{"cmd":"material.assign","material":"solid","bodies":["used"]}"#);
    for mesher in [None, Some(r#"{"kind":"lattice","size":"500 mm"}"#), Some(r#"{"kind":"tet","size":"500 mm"}"#)] {
        if let Some(mesher) = mesher {
            ok(&mut e, &format!(r#"{{"cmd":"mesh.set","mesher":{mesher}}}"#));
        }
        let warnings = e.warnings();
        let missing: Vec<_> = warnings.iter().filter(|w| w.code == "model.no-material").collect();
        assert_eq!(missing.len(), 2);
        assert!(missing.iter().all(|w| w.step.is_none()));
        assert!(missing.iter().any(|w| w.where_.as_deref() == Some("body 'unused'")));
        let dimension = warnings.iter().find(|w| w.code == "model.ill-posed").unwrap();
        assert_eq!(dimension.where_.as_deref(), Some("body 'unused3d'"));
    }
}
