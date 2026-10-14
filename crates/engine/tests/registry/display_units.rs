//! Public checked-display boundaries, with exact authored values and independent SI oracles.
use super::{engine, err, heat_bar, ok, Engine, ErrorCode, Query, IMPORTED_TET};
use serde_json::{json, Value};

fn command(e: &mut Engine, value: Value) {
    ok(e, &value.to_string());
}

fn fresh() -> Engine {
    let mut e = engine();
    command(&mut e, json!({"cmd":"model.new","name":"checked display paths"}));
    e
}

fn box_model() -> Engine {
    let mut e = fresh();
    command(&mut e, json!({"cmd":"geometry.addBox","name":"box","size":["1 m","1 m","1 m"]}));
    e
}

fn read(e: &mut Engine, value: Value) -> Value {
    serde_json::to_value(e.query(serde_json::from_value(value).unwrap()).unwrap()).unwrap()
}

fn rejected_read(e: &mut Engine, query: Value) {
    rejected_read_code(e, query, ErrorCode::UnitDisplay);
}

fn rejected_read_code(e: &mut Engine, query: Value, code: ErrorCode) {
    let file = e.export_file();
    let hash = e.model_hash();
    let revision = e.revision();
    let catalogue = e.query(Query::Results {}).unwrap();
    let error = e.query(serde_json::from_value(query).unwrap()).unwrap_err();
    assert_eq!(error.code, code, "{error:?}");
    if code == ErrorCode::UnitDisplay {
        assert_eq!(error.where_.as_deref(), Some("displayUnits"));
        assert!(error.suggestion.as_deref().unwrap().contains("model.setUnits"));
    }
    assert_eq!(e.export_file(), file);
    assert_eq!(e.model_hash(), hash);
    assert_eq!(e.revision(), revision);
    assert_eq!(e.query(Query::Results {}).unwrap(), catalogue);
}

fn rejected_command(e: &mut Engine, value: Value) {
    let file = e.export_file();
    let hash = e.model_hash();
    let revision = e.revision();
    let catalogue = e.query(Query::Results {}).unwrap();
    assert_eq!(err(e, &value.to_string()).code, ErrorCode::UnitDisplay);
    assert_eq!(e.export_file(), file);
    assert_eq!(e.model_hash(), hash);
    assert_eq!(e.revision(), revision);
    assert_eq!(e.query(Query::Results {}).unwrap(), catalogue);
}

fn axial_bar() -> Engine {
    let mut e = fresh();
    for value in [
        json!({"cmd":"geometry.addLine","name":"shaft","points":[["0 m","0 m","0 m"],["1 m","0 m","0 m"]],"divisions":2,"kind":"beam"}),
        json!({"cmd":"material.add","name":"steel","E":"200 GPa","nu":0.3}),
        json!({"cmd":"material.assign","material":"steel","bodies":["shaft"]}),
        json!({"cmd":"section.add","name":"round","shape":{"kind":"circle","radius":"50 mm"}}),
        json!({"cmd":"section.assign","section":"round","bodies":["shaft"]}),
        json!({"cmd":"mesh.set","mesher":{"kind":"lattice","size":"1 m"}}),
        json!({"cmd":"constraint.fix","name":"root","on":"shaft.p0"}),
        json!({"cmd":"load.force","name":"tip","on":"shaft.p1","total":["1000 N","0 N","0 N"]}),
        json!({"cmd":"step.add","name":"axial","procedure":"static","constraints":["root"],"loads":["tip"]}),
        json!({"cmd":"solve.run","step":"axial","solver":"cpu-direct"}),
    ] {
        command(&mut e, value);
    }
    e
}

#[test]
fn checked_display_bounds_and_vectors_check_every_public_component() {
    for axis in 0..3 {
        for low in [0.0, 1.0] {
            let mut e = fresh();
            let mut a = [0.0; 3];
            let mut b = [0.0; 3];
            a[axis] = low;
            b[axis] = low + 1.0;
            let quantities = |v: [f64; 3]| v.map(|x| format!("{x} m"));
            command(&mut e, json!({"cmd":"geometry.addLine","name":"member","points":[quantities(a),quantities(b)]}));
            let ordinary = read(&mut e, json!({"query":"query.model"}));
            assert_eq!(ordinary["bodies"][0]["bbox"][axis]["value"], low);
            assert_eq!(ordinary["bodies"][0]["bbox"][axis + 3]["value"], low + 1.0);
            command(&mut e, json!({"cmd":"model.setUnits","units":{"length":"nm^35/m^34"}}));
            rejected_read(&mut e, json!({"query":"query.model"}));
            command(&mut e, json!({"cmd":"model.setUnits","units":{"length":"m"}}));
            assert_eq!(read(&mut e, json!({"query":"query.model"}))["bodies"], ordinary["bodies"]);
        }
        let mut e = fresh();
        let mut at = ["0 m"; 3];
        at[axis] = "1 m";
        command(&mut e, json!({"cmd":"geometry.addMass","name":"point","at":at,"mass":"1 kg"}));
        command(&mut e, json!({"cmd":"model.setUnits","units":{"length":"nm^35/m^34"}}));
        rejected_read(&mut e, json!({"query":"query.model"}));
    }
}

#[test]
fn checked_display_material_optional_values_and_each_orthotropic_modulus_reject_overflow() {
    for field in ["E1", "E2", "E3", "G12", "G13", "G23"] {
        let mut e = fresh();
        let mut axes = json!({"E1":"1 Pa","E2":"1 Pa","E3":"1 Pa","G12":"1 Pa","G13":"1 Pa","G23":"1 Pa","nu12":0,"nu13":0,"nu23":0});
        axes[field] = json!("1e308 Pa");
        command(&mut e, json!({"cmd":"material.add","name":"axes","orthotropic":axes}));
        command(&mut e, json!({"cmd":"model.setUnits","units":{"stress":"mPa"}}));
        rejected_read(&mut e, json!({"query":"query.model"}));
        command(&mut e, json!({"cmd":"model.setUnits","units":{"stress":"Pa"}}));
        assert_eq!(read(&mut e, json!({"query":"query.model"}))["materials"][0]["orthotropic"][field]["value"], 1e308);
    }
    for (property, value, units) in
        [("rho", "1e308 kg/m^3", json!({"density":"g/m^3"})), ("yield", "1e308 Pa", json!({"stress":"mPa"}))]
    {
        let mut e = fresh();
        let mut material = json!({"cmd":"material.add","name":"finite","E":"1 Pa","nu":0});
        material[property] = json!(value);
        command(&mut e, material);
        command(&mut e, json!({"cmd":"model.setUnits","units":units}));
        rejected_read(&mut e, json!({"query":"query.model"}));
    }
    let mut e = fresh();
    command(&mut e, json!({"cmd":"geometry.addMass","name":"heavy","at":["0 m","0 m","0 m"],"mass":"1e308 kg"}));
    command(&mut e, json!({"cmd":"model.setUnits","units":{"mass":"g"}}));
    rejected_read(&mut e, json!({"query":"query.model"}));
}

#[test]
fn checked_display_unused_imported_node_sets_keep_exact_large_centroids_and_zero_measure() {
    // The independent mean of two equal finite coordinates is that same coordinate.
    // The three-MAX rounding defect stays in #593; do not require it to remain broken.
    for axis in 0..3 {
        let mut e = fresh();
        let mut source: Value = serde_json::from_str(IMPORTED_TET).unwrap();
        let nodes = source["mesher"]["nodes"].as_array_mut().unwrap();
        for label in [1001, 1002] {
            let mut at = json!(["0 m", "0 m", "0 m"]);
            at[axis] = json!({"value":1e308,"unit":"m"});
            nodes.push(json!({"label":label,"at":at}));
        }
        source["mesher"]["nodeSets"]["FAR"] = json!([1001, 1002]);
        command(&mut e, source);
        let physical = read(&mut e, json!({"query":"query.model"}));
        assert_eq!(physical["bodies"][0]["bbox"][3]["value"], 1.0);
        let file = e.export_file();
        let far = read(&mut e, json!({"query":"query.set","name":"part.nset_FAR"}));
        assert_eq!(far["sourceNodeLabels"], json!([1001, 1002]));
        assert_eq!(far["unusedSourceNodeLabels"], json!([1001, 1002]));
        assert_eq!(far["bbox"][axis]["value"], 1e308);
        assert_eq!(far["bbox"][axis + 3]["value"], 1e308);
        assert_eq!(far["centroid"][axis]["value"], 1e308);
        assert_eq!(far["measure"], json!({"value":0.0,"unit":"SI"}));
        assert_eq!(e.export_file(), file);
    }
}

#[test]
fn checked_display_authored_loads_keep_each_configured_dimension_truthful() {
    for (load, units) in [
        (json!({"cmd":"load.pressure","name":"p","on":"box.xmax","value":"1e308 Pa"}), json!({"stress":"mPa"})),
        (
            json!({"cmd":"load.traction","name":"p","on":"box.xmax","total":["0 N","1e308 N","0 N"]}),
            json!({"force":"mN"}),
        ),
        (json!({"cmd":"load.force","name":"p","on":"box.xmax","total":["0 N","0 N","1e308 N"]}), json!({"force":"mN"})),
        (
            json!({"cmd":"load.moment","name":"p","on":"box.xmax","total":["1e308 N m","0 N m","0 N m"]}),
            json!({"force":"mN"}),
        ),
        (
            json!({"cmd":"load.gravity","name":"p","g":["0 m/s^2","1e308 m/s^2","0 m/s^2"]}),
            json!({"acceleration":"mm/s^2"}),
        ),
        (
            json!({"cmd":"load.convection","name":"p","on":"box.xmax","h":"1 W/(m^2 K)","tInf":"1e308 K"}),
            json!({"temperature":"mK"}),
        ),
        (
            json!({"cmd":"load.radiation","name":"p","on":"box.xmax","emissivity":0.5,"tInf":"1e308 K"}),
            json!({"temperature":"mK"}),
        ),
        (
            json!({"cmd":"load.temperature","name":"p","bodies":["box"],"value":"1e308 K","reference":"1 K"}),
            json!({"temperature":"mK"}),
        ),
        (
            json!({"cmd":"load.temperature","name":"p","bodies":["box"],"value":"1 K","reference":"1e308 K"}),
            json!({"temperature":"mK"}),
        ),
    ] {
        let mut e = box_model();
        command(&mut e, load);
        command(&mut e, json!({"cmd":"model.setUnits","units":units}));
        rejected_read(&mut e, json!({"query":"query.model"}));
    }
    let mut e = fresh();
    command(&mut e, json!({"cmd":"model.setIdealisation","idealisation":{"kind":"axisymmetric","twist":true}}));
    command(
        &mut e,
        json!({"cmd":"mesh.set","mesher":{"kind":"mapped","body":"shaft","blocks":[{"corners":[["0 m","0 m"],["1 m","0 m"],["1 m","1 m"],["0 m","1 m"]],"n":[1,1],"tags":["zmin","outer","zmax","inner"]}]}}),
    );
    command(&mut e, json!({"cmd":"load.torque","name":"p","on":"shaft.zmax","total":"1e308 N m"}));
    command(&mut e, json!({"cmd":"model.setUnits","units":{"force":"mN"}}));
    rejected_read(&mut e, json!({"query":"query.model"}));
}

#[test]
fn checked_display_constraints_connections_and_thickness_do_not_hide_errors() {
    for definition in [
        json!({"cmd":"constraint.prescribe","name":"c","on":"p","dof":"ux","value":"1 m"}),
        json!({"cmd":"contact.add","name":"c","master":"p","slave":"q","kind":"bonded","tol":"1 m"}),
        json!({"cmd":"contact.add","name":"c","master":"p","slave":"q","kind":"frictionless","tol":"1 m"}),
    ] {
        let mut e = fresh();
        for name in ["p", "q"] {
            command(&mut e, json!({"cmd":"geometry.addMass","name":name,"at":["0 m","0 m","0 m"],"mass":"1 kg"}));
        }
        command(&mut e, definition);
        command(&mut e, json!({"cmd":"model.setUnits","units":{"length":"nm^35/m^34"}}));
        rejected_read(&mut e, json!({"query":"query.model"}));
    }
    let mut e = box_model();
    command(&mut e, json!({"cmd":"constraint.temperature","name":"c","on":"box.xmin","value":"1e308 K"}));
    command(&mut e, json!({"cmd":"model.setUnits","units":{"temperature":"mK"}}));
    rejected_read(&mut e, json!({"query":"query.model"}));
    let mut e = fresh();
    command(&mut e, json!({"cmd":"model.setIdealisation","idealisation":{"kind":"planeStress","thickness":"1 m"}}));
    command(&mut e, json!({"cmd":"model.setUnits","units":{"length":"nm^35/m^34"}}));
    rejected_read(&mut e, json!({"query":"query.model"}));
}

#[test]
fn checked_display_derived_body_mass_volume_and_total_member_length_are_checked() {
    let mut e = box_model();
    command(&mut e, json!({"cmd":"material.add","name":"dense","E":"1 Pa","nu":0,"rho":"1e308 kg/m^3"}));
    command(&mut e, json!({"cmd":"material.assign","material":"dense","bodies":["box"]}));
    command(&mut e, json!({"cmd":"model.setUnits","units":{"mass":"g"}}));
    rejected_read(&mut e, json!({"query":"query.model"}));

    let mut e = box_model();
    command(&mut e, json!({"cmd":"model.setUnits","units":{"length":"nm^12/m^11"}}));
    rejected_read(&mut e, json!({"query":"query.model"}));

    let mut e = fresh();
    command(
        &mut e,
        json!({"cmd":"geometry.addLine","name":"loop","points":[["0 m","0 m","0 m"],["1 m","0 m","0 m"],["1 m","1 m","0 m"],["0 m","1 m","0 m"]],"members":[[0,1],[1,2],[2,3],[3,0]]}),
    );
    assert_eq!(read(&mut e, json!({"query":"query.model"}))["bodies"][0]["measure"]["value"], 4.0);
    // Each bbox coordinate displays as1e308, but the independent perimeter4m overflows.
    command(&mut e, json!({"cmd":"model.setUnits","units":{"length":"nm^34*cm/m^34"}}));
    rejected_read(&mut e, json!({"query":"query.model"}));
}

#[test]
fn checked_display_report_force_sum_rejects_aggregate_overflow_after_individual_loads_pass() {
    let mut e = box_model();
    for name in ["a", "b"] {
        command(&mut e, json!({"cmd":"load.force","name":name,"on":"box.xmax","total":["1e308 N","0 N","0 N"]}));
    }
    // Every admitted force is finite and readable. Their exact sum2e308N is not.
    assert_eq!(read(&mut e, json!({"query":"query.model"}))["loads"].as_array().unwrap().len(), 2);
    rejected_read(&mut e, json!({"query":"query.report","include":["loads"]}));
}

#[test]
fn checked_display_empty_line_set_has_a_real_no_boundary_diagnostic() {
    let mut e = fresh();
    command(&mut e, json!({"cmd":"geometry.addLine","name":"line","points":[["0 m","0 m","0 m"],["1 m","0 m","0 m"]]}));
    command(&mut e, json!({"cmd":"mesh.set","mesher":{"kind":"lattice","size":"1 m"}}));
    command(
        &mut e,
        json!({"cmd":"geometry.nameRegion","name":"outside","where":{"kind":"bbox","min":["2 m","0 m","0 m"],"max":["3 m","1 m","1 m"]}}),
    );
    let file = e.export_file();
    let error = e.query(Query::Mesh {}).unwrap_err();
    assert_eq!(error.code, ErrorCode::SetEmpty);
    assert!(error.cause.contains("no boundary face"));
    assert_eq!(e.export_file(), file);
}

#[test]
fn checked_display_probe_path_and_study_field_errors_preserve_the_solved_context() {
    let mut e = axial_bar();
    let mut original = read(&mut e, json!({"query":"query.result","step":"axial"}));
    let probe = json!({"query":"query.probe","step":"axial","field":"stress","component":0,"at":["0.5 m","0 m","0 m"]});
    let path = json!({"query":"query.path","step":"axial","field":"stress","component":0,"from":["0 m","0 m","0 m"],"to":["1 m","0 m","0 m"],"n":3});
    let sigma = 1000.0 / (std::f64::consts::PI * 0.05_f64.powi(2));
    assert!((read(&mut e, probe.clone())["value"]["value"].as_f64().unwrap() - sigma).abs() < 1e-8);
    for value in read(&mut e, path.clone())["values"].as_array().unwrap() {
        assert!((value.as_f64().unwrap() - sigma).abs() < 1e-8);
    }
    command(&mut e, json!({"cmd":"model.setUnits","units":{"stress":"Pa*nm^34/m^34"}}));
    original["stale"] = json!(true);
    for query in [probe, path] {
        rejected_read_code(&mut e, query, ErrorCode::ResultStale);
        assert_eq!(read(&mut e, json!({"query":"query.result","resultId":original["resultId"]})), original);
    }
    rejected_command(
        &mut e,
        json!({"cmd":"study.converge","step":"axial","sizes":["1 m","0.5 m"],"quantity":{"kind":"max","field":"stress","component":0}}),
    );
    assert_eq!(read(&mut e, json!({"query":"query.result","resultId":original["resultId"]})), original);
}

#[test]
fn checked_display_convergence_size_rejects_before_replacing_the_mesh_or_result() {
    let mut e = axial_bar();
    command(&mut e, json!({"cmd":"model.setUnits","units":{"length":"nm^35/m^34"}}));
    rejected_command(
        &mut e,
        json!({"cmd":"study.converge","step":"axial","sizes":["1 m","0.5 m"],"quantity":{"kind":"max","field":"displacement","component":0}}),
    );
}

#[test]
fn checked_display_retained_frame_and_history_times_are_fallible_read_only_values() {
    let mut e = engine();
    heat_bar(&mut e);
    command(&mut e, json!({"cmd":"model.setUnits","units":{"temperature":"K","length":"m"}}));
    command(&mut e, json!({"cmd":"constraint.temperature","name":"held","on":"bar.xmin","value":"1 K"}));
    command(
        &mut e,
        json!({"cmd":"step.add","name":"constant","procedure":"heat-transient","constraints":["held"],"loads":[],"initial":"1 K","dt":"1 s","tEnd":"1 s"}),
    );
    command(&mut e, json!({"cmd":"solve.run","step":"constant","solver":"cpu-direct"}));
    let mut original = read(&mut e, json!({"query":"query.result","step":"constant"}));
    let frames = read(&mut e, json!({"query":"query.frames","step":"constant"}));
    assert_eq!(frames["frames"][1]["time"], json!({"value":1.0,"unit":"s"}));
    let frame = read(&mut e, json!({"query":"query.frame","step":"constant","index":1}));
    for node in frame["values"].as_array().unwrap().chunks_exact(3) {
        assert!((node[0].as_f64().unwrap() - 1.0).abs() < 2e-14);
        assert_eq!(node[1], 0.0);
        assert_eq!(node[2], 0.0);
    }
    command(&mut e, json!({"cmd":"model.setUnits","units":{"time":"s*nm^35/m^35"}}));
    original["stale"] = json!(true);
    rejected_read_code(&mut e, json!({"query":"query.frame","step":"constant","index":1}), ErrorCode::ResultStale);
    for query in [json!({"query":"query.frames","step":"constant"}), json!({"query":"query.result","step":"constant"})]
    {
        rejected_read(&mut e, query);
        assert_eq!(read(&mut e, json!({"query":"query.result","resultId":original["resultId"]})), original);
    }
}

#[test]
fn checked_display_thermal_history_extrema_do_not_hide_an_earlier_unrepresentable_frame() {
    for cold in ["0 K", "10 K"] {
        let mut e = engine();
        heat_bar(&mut e);
        command(&mut e, json!({"cmd":"model.setUnits","units":{"temperature":"K","length":"m"}}));
        command(&mut e, json!({"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":1,"ny":1,"nz":1}}}));
        command(&mut e, json!({"cmd":"constraint.temperature","name":"left","on":"bar.xmin","value":"10 K"}));
        command(&mut e, json!({"cmd":"constraint.temperature","name":"right","on":"bar.xmax","value":cold}));
        command(
            &mut e,
            json!({"cmd":"step.add","name":"cool","procedure":"heat-transient","constraints":["left","right"],"loads":[],"initial":"0 K","dt":"1 s","tEnd":"1 s","amplitude":{"kind":"table","t":["0 s","1 s"],"value":[1,0]}}),
        );
        command(&mut e, json!({"cmd":"solve.run","step":"cool","solver":"cpu-direct"}));
        let mut original = read(&mut e, json!({"query":"query.result","step":"cool"}));
        assert_eq!(original["history"][0]["max"]["value"], 10.0);
        assert_eq!(original["history"][0]["min"]["value"], if cold == "0 K" { 0.0 } else { 10.0 });
        assert_eq!(original["history"][1]["max"]["value"], 0.0);
        let mean_initial = if cold == "0 K" { 5.0 } else { 10.0 };
        // Stored thermal power is C*ΔT/Δt: rho*cp*V = 36110J/K, Δt=1s.
        assert!((original["storagePower"]["value"].as_f64().unwrap() + 36110.0 * mean_initial).abs() < 2e-9);
        command(&mut e, json!({"cmd":"model.setUnits","units":{"temperature":"K*nm^35/m^35"}}));
        original["stale"] = json!(true);
        rejected_read(&mut e, json!({"query":"query.result","step":"cool"}));
        assert_eq!(read(&mut e, json!({"query":"query.result","resultId":original["resultId"]})), original);
        command(&mut e, json!({"cmd":"model.setUnits","units":{"power":"W*nm^34/m^34"}}));
        rejected_read(&mut e, json!({"query":"query.result","step":"cool"}));
        assert_eq!(read(&mut e, json!({"query":"query.result","resultId":original["resultId"]})), original);
    }
}

#[test]
fn checked_display_thermal_reactions_and_applied_power_are_independently_checked() {
    for (loads, unit, individual) in
        [(Vec::new(), "W*nm^34*mm/m^35", 0.45), (vec!["source"], "W*nm^34*cm*cm/m^36", 0.01)]
    {
        let mut e = engine();
        heat_bar(&mut e);
        command(&mut e, json!({"cmd":"model.setUnits","units":{"temperature":"K","length":"m"}}));
        command(&mut e, json!({"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":1,"ny":1,"nz":1}}}));
        command(&mut e, json!({"cmd":"constraint.temperature","name":"left","on":"bar.xmin","value":"0 K"}));
        let hot = if loads.is_empty() { "1 K" } else { "0 K" };
        command(&mut e, json!({"cmd":"constraint.temperature","name":"right","on":"bar.xmax","value":hot}));
        command(&mut e, json!({"cmd":"load.heatSource","name":"source","bodies":["bar"],"q":"2 W/m^3"}));
        command(
            &mut e,
            json!({"cmd":"step.add","name":"heat","procedure":"heat-steady","constraints":["left","right"],"loads":loads}),
        );
        command(&mut e, json!({"cmd":"solve.run","step":"heat","solver":"cpu-direct"}));
        let mut original = read(&mut e, json!({"query":"query.result","step":"heat"}));
        // Fourier q=k*A*ΔT/L=0.45W, or uniform source q*V/2=0.01W per held end.
        assert!((original["reactions"][0]["total"][0]["value"].as_f64().unwrap().abs() - individual).abs() < 1e-13);
        command(&mut e, json!({"cmd":"model.setUnits","units":{"power":unit}}));
        original["stale"] = json!(true);
        rejected_read(&mut e, json!({"query":"query.result","step":"heat"}));
        assert_eq!(read(&mut e, json!({"query":"query.result","resultId":original["resultId"]})), original);
        if loads.is_empty() {
            // The final temperature's independent range0..1K has a representable minimum
            // but an unrepresentable maximum in this selected temperature unit.
            command(&mut e, json!({"cmd":"model.setUnits","units":{"temperature":"K*nm^35/m^35"}}));
            rejected_read(&mut e, json!({"query":"query.result","step":"heat"}));
        }
    }
}

#[test]
fn checked_display_public_vector_norm_rejects_a_truly_unrepresentable_magnitude() {
    let mut e = fresh();
    for value in [
        json!({"cmd":"geometry.addLine","name":"line","points":[["0 m","0 m","0 m"],["1 m","0 m","0 m"]],"kind":"truss"}),
        json!({"cmd":"material.add","name":"soft","E":"1 Pa","nu":0}),
        json!({"cmd":"material.assign","material":"soft","bodies":["line"]}),
        json!({"cmd":"section.add","name":"small","shape":{"kind":"circle","radius":"0.1 m"}}),
        json!({"cmd":"section.assign","section":"small","bodies":["line"]}),
        json!({"cmd":"mesh.set","mesher":{"kind":"lattice","size":"1 m"}}),
        json!({"cmd":"geometry.nameRegion","name":"all","where":{"kind":"body","name":"line"}}),
    ] {
        command(&mut e, value);
    }
    for (dof, value) in [("ux", f64::MAX), ("uy", f64::MAX), ("uz", 0.0)] {
        command(
            &mut e,
            json!({"cmd":"constraint.prescribe","name":dof,"on":"all","dof":dof,"value":{"value":value,"unit":"m"}}),
        );
    }
    command(
        &mut e,
        json!({"cmd":"step.add","name":"rigid","procedure":"static","constraints":["ux","uy","uz"],"loads":[]}),
    );
    command(&mut e, json!({"cmd":"solve.run","step":"rigid","solver":"cpu-direct"}));
    let original = read(&mut e, json!({"query":"query.result","step":"rigid"}));
    // Rigid translation has zero strain/stress/reaction. Both components are exactly MAX;
    // their mathematical norm is sqrt(2)*MAX, which cannot fit even with a stable norm.
    assert_eq!(original["staticEquilibrium"]["forceScale"]["value"], 0.0);
    for field in ["strain", "stress"] {
        let values = read(&mut e, json!({"query":"query.field","step":"rigid","field":field}));
        assert!(values["values"].as_array().unwrap().iter().all(|value| value.as_f64().unwrap() == 0.0));
    }
    for reaction in original["reactions"].as_array().unwrap() {
        for component in reaction["total"].as_array().unwrap() {
            assert_eq!(component["value"], 0.0);
        }
    }
    for component in [0, 1] {
        assert_eq!(
            read(
                &mut e,
                json!({"query":"query.probe","step":"rigid","field":"displacement","component":component,"at":["0.5 m","0 m","0 m"]})
            )["value"]["value"],
            f64::MAX
        );
    }
    for query in [
        json!({"query":"query.probe","step":"rigid","field":"displacement","at":["0.5 m","0 m","0 m"]}),
        json!({"query":"query.path","step":"rigid","field":"displacement","from":["0 m","0 m","0 m"],"to":["1 m","0 m","0 m"],"n":3}),
    ] {
        rejected_read(&mut e, query);
        assert_eq!(read(&mut e, json!({"query":"query.result","step":"rigid"})), original);
    }
    rejected_command(
        &mut e,
        json!({"cmd":"study.converge","step":"rigid","sizes":["1 m","0.5 m"],"quantity":{"kind":"max","field":"displacement"}}),
    );
    assert_eq!(read(&mut e, json!({"query":"query.result","step":"rigid"})), original);
}

#[test]
fn checked_display_extremum_coordinates_are_checked_after_a_readable_wrench_ledger() {
    for force in [1000.0, -1000.0] {
        let mut e = axial_bar();
        command(
            &mut e,
            json!({"cmd":"geometry.addLine","name":"shaft","points":[["1 m","0 m","0 m"],["2 m","0 m","0 m"]],"divisions":2,"kind":"beam"}),
        );
        command(
            &mut e,
            json!({"cmd":"load.force","name":"tip","on":"shaft.p1","total":[format!("{force} N"),"0 N","0 N"]}),
        );
        command(&mut e, json!({"cmd":"solve.run","step":"axial","solver":"cpu-direct"}));
        let mut original = read(&mut e, json!({"query":"query.result","step":"axial"}));
        assert_eq!(original["staticEquilibrium"]["characteristicLength"]["value"], 1.0);
        // Length factor1e-308 keeps the unit span and reference1m readable. Endpoint2m
        // is unrepresentable: tension selects maxAt, compression minAt at that endpoint.
        command(&mut e, json!({"cmd":"model.setUnits","units":{"length":"nm^34*cm/m^34","force":"GN"}}));
        rejected_read(&mut e, json!({"query":"query.result","step":"axial"}));
        original["stale"] = json!(true);
        assert_eq!(read(&mut e, json!({"query":"query.result","resultId":original["resultId"]})), original);
    }
}

#[test]
fn checked_display_admitted_thermal_coefficients_and_sources_keep_their_fixed_si_contract() {
    let mut e = box_model();
    for load in [
        json!({"cmd":"load.convection","name":"film","on":"box.xmax","h":"1e308 W/(m^2 K)","tInf":"1 K"}),
        json!({"cmd":"load.heatFlux","name":"flux","on":"box.xmax","q":"1e308 W/m^2"}),
        json!({"cmd":"load.heatSource","name":"source","bodies":["box"],"q":"1e308 W/m^3"}),
        json!({"cmd":"contact.add","name":"tie","master":"box.xmin","slave":"box.xmax","kind":"bonded"}),
        json!({"cmd":"contact.thermal","name":"conductance","of":"tie","conductance":"1e308 W/(m^2 K)"}),
    ] {
        command(&mut e, load);
    }
    let file = e.export_file();
    let summary = read(&mut e, json!({"query":"query.model"}));
    for load in summary["loads"].as_array().unwrap() {
        assert!(load["summary"].as_str().unwrap().contains("1e308 SI"));
    }
    for (name, field) in [("film", "h"), ("flux", "q"), ("source", "q"), ("conductance", "conductance")] {
        let definition = read(&mut e, json!({"query":"query.definition","kind":"load","name":name}));
        assert_eq!(definition["command"][field]["value"], 1e308);
    }
    assert_eq!(e.export_file(), file);
}

#[test]
fn checked_display_imported_body_and_active_set_measures_use_their_physical_dimensions() {
    for (units, queries) in [
        ("nm^35/m^34", vec![json!({"query":"query.model"})]),
        ("nm^12/m^11", vec![json!({"query":"query.model"}), json!({"query":"query.set","name":"part.elset_ALL"})]),
        ("nm^19/m^18", vec![json!({"query":"query.set","name":"part.surface_BASE"})]),
    ] {
        let mut e = fresh();
        command(&mut e, serde_json::from_str(IMPORTED_TET).unwrap());
        let model = read(&mut e, json!({"query":"query.model"}));
        // Unit coordinate simplex: det(I)/6 and its right-triangle base area 1/2.
        assert_eq!(model["bodies"][0]["bbox"][3], json!({"value":1.0,"unit":"m"}));
        assert_eq!(model["bodies"][0]["measure"]["unit"], "m^3");
        assert!((model["bodies"][0]["measure"]["value"].as_f64().unwrap() - 1.0 / 6.0).abs() < 1e-15);
        let element = read(&mut e, json!({"query":"query.set","name":"part.elset_ALL"}));
        assert!((element["measure"]["value"].as_f64().unwrap() - 1.0 / 6.0).abs() < 1e-15);
        let face = read(&mut e, json!({"query":"query.set","name":"part.surface_BASE"}));
        assert_eq!(face["measure"], json!({"value":0.5,"unit":"m^2"}));
        command(&mut e, json!({"cmd":"model.setUnits","units":{"length":units}}));
        for query in queries {
            rejected_read(&mut e, query);
        }
    }
}

#[test]
fn checked_display_pressure_area_is_checked_after_readable_geometric_face_length() {
    let mut e = fresh();
    for value in [
        json!({"cmd":"model.setIdealisation","idealisation":{"kind":"planeStress","thickness":"1e100 m"}}),
        json!({"cmd":"mesh.set","mesher":{"kind":"mapped","body":"square","blocks":[{"corners":[["0 m","0 m"],["1 m","0 m"],["1 m","1 m"],["0 m","1 m"]],"n":[1,1],"tags":["bottom","right","top","left"]}]}}),
    ] {
        command(&mut e, value);
    }
    let set = read(&mut e, json!({"query":"query.set","name":"square.bottom"}));
    assert_eq!(set["measure"], json!({"value":1.0,"unit":"m"}));
    assert_eq!(set["pressureArea"]["unit"], "m^2");
    // Loaded face area is edge length times authored thickness, 1*1e100 m².
    assert!((set["pressureArea"]["value"].as_f64().unwrap() / 1e100 - 1.0).abs() < 1e-14);
    command(&mut e, json!({"cmd":"model.setUnits","units":{"length":"nm^12/m^11"}}));
    // Bbox, 2D Body area, thickness and geometric face length remain representable.
    assert_eq!(
        read(&mut e, json!({"query":"query.model"}))["bodies"][0]["measure"]["unit"],
        "(nm^12/m^11)*(nm^12/m^11)"
    );
    rejected_read(&mut e, json!({"query":"query.set","name":"square.bottom"}));
}

#[test]
fn checked_display_mesh_edge_extremes_reject_only_after_readable_bounds() {
    for (points, min, max) in [
        ([[-1.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], std::f64::consts::SQRT_2, 2.0),
        ([[1.0, 1.0, 1.0], [-1.0, -1.0, 1.0], [-1.0, 1.0, -1.0], [1.0, -1.0, -1.0]], 8.0_f64.sqrt(), 8.0_f64.sqrt()),
    ] {
        let mut e = fresh();
        let nodes: Vec<Value> = points
            .iter()
            .enumerate()
            .map(|(i, point)| json!({"label":i+1,"at":point.map(|value| format!("{value} m"))}))
            .collect();
        command(
            &mut e,
            json!({"cmd":"mesh.set","mesher":{"kind":"imported","body":"part","nodes":nodes,"elements":[{"label":10,"kind":"tet4","nodes":[1,2,3,4]}]}}),
        );
        let mesh = read(&mut e, json!({"query":"query.mesh"}));
        assert_eq!(mesh["minEdge"], json!({"value":min,"unit":"m"}));
        assert_eq!(mesh["maxEdge"], json!({"value":max,"unit":"m"}));
        command(&mut e, json!({"cmd":"model.setUnits","units":{"length":"nm^34*mm*in/(m^33*cm*ft)"}}));
        // Each coordinate |x|<=1 converts below MAX at factor 8.333e-309. The
        // longest edge 2, or every regular-Tet edge sqrt(8), exceeds that limit.
        rejected_read(&mut e, json!({"query":"query.mesh"}));
    }
}

fn interference_rings(radial_cells: u32) -> Engine {
    let mut e = fresh();
    for value in [
        json!({"cmd":"model.setIdealisation","idealisation":{"kind":"axisymmetric"}}),
        json!({"cmd":"mesh.set","mesher":{"kind":"mapped","body":"rings","blocks":[
            {"corners":[["1 m","0 m"],["2 m","0 m"],["2 m","1 m"],["1 m","1 m"]],"n":[radial_cells,1],"tags":["bottom1","slave","top1","held"]},
            {"corners":[["1.99 m","0 m"],["3 m","0 m"],["3 m","1 m"],["1.99 m","1 m"]],"n":[radial_cells,1],"tags":["bottom2","held","top2","master"]}
        ]}}),
        json!({"cmd":"material.add","name":"elastic","E":"40 Pa","nu":0}),
        json!({"cmd":"material.assign","material":"elastic","bodies":["rings"]}),
        json!({"cmd":"constraint.fix","name":"anchor","on":"rings.held"}),
        json!({"cmd":"contact.add","name":"interface","kind":"frictionless","master":"rings.master","slave":"rings.slave","tol":"0.1 m"}),
        json!({"cmd":"step.add","name":"contact","procedure":"static","constraints":["anchor","interface"],"loads":[]}),
        json!({"cmd":"solve.run","step":"contact","solver":"cpu-direct"}),
    ] {
        command(&mut e, value);
    }
    e
}

#[test]
fn axisymmetric_interference_contact_converges_to_force_conservative_lame_compliance() {
    let (a, r, s, b) = (1.0_f64, 2.0_f64, 1.99_f64, 3.0_f64);
    // u=Ar+B/r, nu=0 and fixed u(a)=u(b)=0. Equal/opposite transmitted force
    // gives different pressures F/(2*pi*r*h) and F/(2*pi*s*h), not equal pressure.
    let compliance = (r * r - a * a) / (r * r + a * a) + (b * b - s * s) / (b * b + s * s);
    let exact = 2.0 * std::f64::consts::PI * 40.0 * (r - s) / compliance;
    let mut errors = Vec::new();
    for (n, tolerance) in [(2, 0.006), (4, 0.002), (8, 0.0005)] {
        let mut e = interference_rings(n);
        let result = read(&mut e, json!({"query":"query.result"}));
        let contact = &result["contacts"][0];
        assert_eq!(contact["active"], 2);
        assert_eq!(contact["paired"], 2);
        assert_eq!(contact["force"][0]["unit"], "N");
        let error = (contact["force"][0]["value"].as_f64().unwrap() + exact).abs() / exact;
        assert!(error < tolerance, "{n} radial cells, relative error {error}");
        errors.push(error);
    }
    for pair in errors.windows(2) {
        let rate = (pair[0] / pair[1]).log2();
        assert!((1.8..2.2).contains(&rate), "quadratic radial convergence, observed {rate}");
    }
}

#[test]
fn checked_display_contact_total_remains_checked_after_finite_reaction_components() {
    let mut e = interference_rings(4);
    let result = read(&mut e, json!({"query":"query.result"}));
    let id = result["resultId"].as_str().unwrap();
    let contact = result["contacts"][0].clone();
    // This validated unit has factor8.333e-309: its finite force limit is about1.498N.
    // Every earlier displayed reaction extreme and aggregate stays below1.4N, while
    // the independent Lamé force above exceeds2.5N. Axisymmetric has no Cartesian ledger.
    assert!(result["staticEquilibrium"].is_null());
    for extreme in result["extremes"].as_array().unwrap().iter().filter(|row| row["field"] == "reaction") {
        for bound in ["min", "max"] {
            assert!(extreme[bound]["value"].as_f64().unwrap().abs() < 1.4);
        }
    }
    assert!(result["reactions"][0]["total"][0]["value"].as_f64().unwrap().abs() < 1.4);
    assert!(contact["force"][0]["value"].as_f64().unwrap().abs() > 2.5);
    command(&mut e, json!({"cmd":"model.setUnits","units":{"force":"nN^34*mm*in/(N^33*cm*ft)"}}));
    read(&mut e, json!({"query":"query.model"}));
    rejected_read(&mut e, json!({"query":"query.result"}));
    assert_eq!(read(&mut e, json!({"query":"query.result","resultId":id}))["contacts"][0], contact);
}
