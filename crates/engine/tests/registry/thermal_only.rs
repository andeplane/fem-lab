//! Heat-only materials are transport definitions, with no invented elastic stiffness.

use super::*;
use serde_json::json;

#[test]
fn thermal_only_material_definitions_replay_and_undo_without_stiffness() {
    let mut e = engine();
    for extra in [
        json!({}),
        json!({"rho":"2 kg/m^3"}),
        json!({"cp":"3 J/(kg K)"}),
        json!({"rho":"2 kg/m^3","cp":"3 J/(kg K)","source":"conductivity measurement"}),
    ] {
        let before = e.export_file();
        let mut material = json!({"cmd":"material.add","name":"conductor","k":"6 W/(m K)"});
        material.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        ok(&mut e, &material.to_string());
        let mat = e.model().material("conductor").unwrap();
        assert_eq!((mat.e, mat.nu, mat.orthotropic), (None, None, None));
        assert_eq!(mat.k, Some(Axial::Isotropic(6.0)));
        let file = e.export_file();
        let wire = serde_json::to_value(&file.model.materials[0]).unwrap();
        for field in ["e", "nu", "orthotropic"] {
            assert!(wire.get(field).is_none(), "{field} must stay absent: {wire}");
        }
        let mut replayed = engine();
        let hashes = pollster::block_on(replayed.replay(&file.journal.entries, false, true)).unwrap();
        assert_eq!(hashes.last(), Some(&e.model_hash()));
        assert_eq!(replayed.export_file(), file);
        ok(&mut e, r#"{"cmd":"journal.undo"}"#);
        assert_eq!(e.export_file(), before);
        ok(&mut e, r#"{"cmd":"journal.redo"}"#);
        assert_eq!(e.export_file(), file);
    }
}

#[test]
fn thermal_only_material_errors_are_located_and_transactional() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"material.add","name":"conductor","k":"6 W/(m K)"}"#);
    for (extra, field, code) in [
        (json!({}), "k", ErrorCode::Schema),
        (json!({"rho":"2 kg/m^3","cp":"3 J/(kg K)"}), "k", ErrorCode::Schema),
        (json!({"k":"0 W/(m K)"}), "k", ErrorCode::Schema),
        (json!({"k":"-1 W/(m K)"}), "k", ErrorCode::Schema),
        (json!({"k":"1 m"}), "k", ErrorCode::UnitDimension),
        (json!({"k":"6 W/(m K)","rho":"0 kg/m^3"}), "rho", ErrorCode::Schema),
        (json!({"k":"6 W/(m K)","rho":"-1 kg/m^3"}), "rho", ErrorCode::Schema),
        (json!({"k":"6 W/(m K)","cp":"0 J/(kg K)"}), "cp", ErrorCode::Schema),
        (json!({"k":"6 W/(m K)","cp":"-1 J/(kg K)"}), "cp", ErrorCode::Schema),
        (json!({"k":"6 W/(m K)","E":"1 GPa"}), "E", ErrorCode::Schema),
        (json!({"k":"6 W/(m K)","nu":0.3}), "E", ErrorCode::Schema),
        (json!({"k":"6 W/(m K)","yield":"100 MPa","plasticity":{"H":"0 Pa"}}), "plasticity", ErrorCode::Schema),
    ] {
        let before = e.export_file();
        let mut material = json!({"cmd":"material.add","name":"conductor"});
        material.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        let bad = err(&mut e, &material.to_string());
        assert_eq!((bad.code, bad.where_.as_deref()), (code, Some(field)), "{material}: {bad:?}");
        assert!(!bad.cause.is_empty());
        if code != ErrorCode::UnitDimension {
            assert!(bad.suggestion.as_deref().unwrap().starts_with("material.add"));
        }
        assert_eq!(e.export_file(), before);
    }
}

#[test]
fn thermal_only_material_preserves_inactive_properties_without_inventing_stiffness() {
    let mut e = engine();
    heat_bar(&mut e);
    ok(&mut e, r#"{"cmd":"material.add","name":"steel","k":"45 W/(m K)","alpha":"1.2e-5 1/K","yield":"355 MPa"}"#);
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"cold","on":"bar.xmin","value":"0 degC"}"#);
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"hot","on":"bar.xmax","value":"100 degC"}"#);
    ok(&mut e, r#"{"cmd":"step.add","name":"heat","procedure":"heat-steady","constraints":["cold","hot"],"loads":[]}"#);
    ok(&mut e, r#"{"cmd":"solve.run","step":"heat"}"#);
    let temperature = e.field(Some("heat"), Field::Temperature).unwrap().clone();
    assert!((probe_at(&mut e, "heat", Field::Temperature, None, ["500 mm", "50 mm", "50 mm"]) - 50.0).abs() < 1e-9);
    let mat = e.model().material("steel").unwrap();
    assert_eq!((mat.e, mat.nu, mat.orthotropic), (None, None, None));
    assert_eq!(mat.alpha, Some(Axial::Isotropic(1.2e-5)));
    assert_eq!(mat.yield_, Some(355e6));
    ok(&mut e, r#"{"cmd":"step.add","name":"mechanical","procedure":"static","constraints":[],"loads":[]}"#);
    let bad = err(&mut e, r#"{"cmd":"solve.run","step":"mechanical"}"#);
    assert_eq!(bad.code, ErrorCode::MaterialProps);
    assert!(bad.cause.contains("no elastic stiffness"));
    let file = e.export_file();
    let mut replayed = engine();
    pollster::block_on(replayed.replay(&file.journal.entries, false, true)).unwrap();
    assert_eq!(replayed.export_file(), file);
    assert_eq!(replayed.field(Some("heat"), Field::Temperature).unwrap(), &temperature);
}

#[test]
fn rotated_anisotropic_conductivity_keeps_its_existing_heat_path() {
    let mut e = engine();
    heat_bar(&mut e);
    let mut orthotropic = lamina_block();
    orthotropic["k"] = json!(["2 W/(m K)", "8 W/(m K)", "3 W/(m K)"]);
    ok(
        &mut e,
        &json!({"cmd":"material.add","name":"steel","orthotropic":orthotropic,
        "orientation":{"axis":[0,0,1],"angle":"90 deg"}})
        .to_string(),
    );
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"cold","on":"bar.xmin","value":"0 degC"}"#);
    ok(&mut e, r#"{"cmd":"load.heatFlux","name":"heater","on":"bar.xmax","q":"800 W/m^2"}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"heat","procedure":"heat-steady","constraints":["cold"],"loads":["heater"]}"#,
    );
    ok(&mut e, r#"{"cmd":"solve.run","step":"heat"}"#);
    // Rotating 90° puts material axis 2 along x: ΔT = q L/k2 = 100 K.
    let temperature = probe_at(&mut e, "heat", Field::Temperature, None, ["1 m", "50 mm", "50 mm"]);
    assert!((temperature - 100.0).abs() < 1e-9, "{temperature}");
}

#[test]
fn thermal_only_transient_requires_capacity_while_steady_accepts_conductivity_alone() {
    let mut e = engine();
    heat_bar(&mut e);
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"cold","on":"bar.xmin","value":"300 K"}"#);
    ok(&mut e, r#"{"cmd":"step.add","name":"steady","procedure":"heat-steady","constraints":["cold"],"loads":[]}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"transient","procedure":"heat-transient","constraints":["cold"],"loads":[],"dt":"0.1 s","tEnd":"0.1 s","initial":"300 K"}"#,
    );
    for (capacity, missing) in
        [(json!({}), "rho"), (json!({"cp":"3 J/(kg K)"}), "rho"), (json!({"rho":"2 kg/m^3"}), "cp")]
    {
        let mut material = json!({"cmd":"material.add","name":"steel","k":"6 W/(m K)"});
        material.as_object_mut().unwrap().extend(capacity.as_object().unwrap().clone());
        ok(&mut e, &material.to_string());
        ok(&mut e, r#"{"cmd":"solve.run","step":"steady"}"#);
        let bad = err(&mut e, r#"{"cmd":"solve.run","step":"transient"}"#);
        assert_eq!(bad.code, ErrorCode::ModelIllPosed);
        assert_eq!(bad.where_.as_deref(), Some("body 'bar'"));
        assert!(bad.suggestion.as_deref().unwrap().ends_with(missing));
    }
    ok(&mut e, r#"{"cmd":"material.add","name":"steel","k":"6 W/(m K)","rho":"2 kg/m^3","cp":"3 J/(kg K)"}"#);
    ok(&mut e, r#"{"cmd":"solve.run","step":"transient"}"#);
    for node in e.field(Some("transient"), Field::Temperature).unwrap().data.chunks_exact(3) {
        assert!((node[0] - 300.0).abs() < 1e-10);
    }
}

#[test]
fn thermal_only_material_rejects_every_mechanical_procedure_but_not_an_unused_conductor() {
    let mut e = engine();
    cantilever(&mut e);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":1,"ny":1,"nz":1}}}"#);
    ok(&mut e, r#"{"cmd":"material.add","name":"unused","k":"6 W/(m K)"}"#);
    ok(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
    ok(&mut e, r#"{"cmd":"material.add","name":"steel","k":"6 W/(m K)"}"#);
    let before = e.export_file();
    let bad = err(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
    assert_eq!(bad.code, ErrorCode::MaterialProps);
    assert_eq!(bad.where_.as_deref(), Some("material 'steel'"));
    assert!(bad.cause.contains("beam") && bad.cause.contains("no elastic stiffness"));
    assert!(bad.suggestion.as_deref().unwrap().contains("material.add with E and nu"));
    assert_eq!(e.export_file(), before);
    let model = e.model().clone();
    let built = e.mesh().unwrap();
    for procedure in [
        Procedure::Static,
        Procedure::StaticNonlinear,
        Procedure::Modal,
        Procedure::Buckling,
        Procedure::Explicit,
        Procedure::Implicit,
        Procedure::Harmonic,
        Procedure::RandomVibration,
    ] {
        let mut step = model.step("static").unwrap().clone();
        step.procedure = procedure;
        let bad = femlab_engine::solve_run::build_problem(&model, built, &step).err().unwrap();
        assert_eq!(bad.code, ErrorCode::MaterialProps, "{procedure:?}");
    }
    ok(&mut e, r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3}"#);
    ok(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
}

#[test]
fn thermal_only_laminate_ply_cannot_supply_elastic_stiffness() {
    let mut e = engine();
    ok(
        &mut e,
        r#"{"cmd":"mesh.set","mesher":{"kind":"surface","body":"skin","patches":[{"corners":[["0 m","0 m","0 m"],["1 m","0 m","0 m"],["1 m","1 m","0 m"],["0 m","1 m","0 m"]],"n":[1,1],"tags":[null,"tip",null,"root"]}]}}"#,
    );
    ok(&mut e, r#"{"cmd":"material.add","name":"conductor","k":"6 W/(m K)"}"#);
    ok(
        &mut e,
        r#"{"cmd":"section.add","name":"cross","shape":{"kind":"laminate","plies":[{"material":"conductor","thickness":"5 mm"}]}}"#,
    );
    ok(&mut e, r#"{"cmd":"section.assign","section":"cross","bodies":["skin"]}"#);
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"root","on":"skin.root"}"#);
    ok(&mut e, r#"{"cmd":"step.add","name":"static","procedure":"static","constraints":["root"],"loads":[]}"#);
    let bad = err(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
    assert_eq!(bad.code, ErrorCode::MaterialProps);
    assert_eq!(bad.where_.as_deref(), Some("material 'conductor'"));
    assert!(bad.cause.contains("skin"));
}

#[test]
fn thermal_only_nafems_t3_preserves_the_independent_reference_over_refinement() {
    let fixture: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("../../benches/journals/bar-transient-heat.json")).unwrap();
    let mut errors = Vec::new();
    for nx in [10, 20, 40] {
        let mut e = engine();
        for entry in &fixture {
            let mut command = entry["cmd"].clone();
            if command["cmd"] == "material.add" {
                let fields = command.as_object_mut().unwrap();
                fields.remove("E");
                fields.remove("nu");
            }
            if command["cmd"] == "mesh.set" {
                command["mesher"]["size"]["nx"] = json!(nx);
            }
            ok(&mut e, &command.to_string());
        }
        let temperature = probe_at(&mut e, "transient", Field::Temperature, None, ["80 mm", "2.5 mm", "2.5 mm"]);
        // Fixture temperatures are kelvin increments, exactly the NAFEMS Celsius rise.
        let error = (temperature - 36.60).abs();
        println!("thermal-only NAFEMS T3 nx={nx}: {temperature} K, reference error {error} K");
        errors.push(error);
        let material = e.model().material("slab").unwrap();
        assert_eq!((material.e, material.nu, material.orthotropic), (None, None, None));
    }
    assert!(errors.windows(2).all(|pair| pair[1] < pair[0]), "{errors:?}");
    let rate = (errors[1] / errors[2]).log2();
    assert!(rate > 1.8, "linear elements retain second-order temperature convergence: {rate}");
    assert!(*errors.last().unwrap() < 0.5, "the finest mesh retains E3's 0.5 K tolerance: {errors:?}");
}
