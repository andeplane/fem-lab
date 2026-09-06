//! Independent retained-Result oracles: Fourier conduction and uniform heating.
//! Included by registry.rs so coverage sees one integration-test instantiation.
use super::*;
use serde_json::{json, Value};

fn retained_query(e: &mut Engine, value: Value) -> Value {
    let query: Query = serde_json::from_value(value).unwrap();
    serde_json::to_value(e.query(query).unwrap()).unwrap()
}

fn retained_error(e: &mut Engine, value: Value) -> Error {
    let query: Query = serde_json::from_value(value).unwrap();
    e.query(query).unwrap_err()
}

fn retained_records(e: &mut Engine) -> Vec<Value> {
    let result = retained_query(e, json!({"query":"query.results"}));
    assert_eq!(result["limit"], 8);
    result["records"].as_array().unwrap().clone()
}

fn retained_conductor(e: &mut Engine) {
    heat_bar(e);
    ok(e, r#"{"cmd":"constraint.temperature","name":"cold","on":"bar.xmin","value":"0 degC"}"#);
    ok(e, r#"{"cmd":"load.heatFlux","name":"heater","on":"bar.xmax","q":"900 W/m^2"}"#);
    ok(
        e,
        r#"{"cmd":"step.add","name":"conduct","procedure":"heat-steady","constraints":["cold"],"loads":["heater"],"output":["temperature"]}"#,
    );
}

fn retained_solve(e: &mut Engine, step: &str) -> String {
    ok(e, &json!({"cmd":"solve.run","step":step,"solver":"cpu-direct"}).to_string());
    retained_query(e, json!({"query":"query.result","step":step}))["resultId"].as_str().unwrap().to_owned()
}

fn retained_close(actual: &Value, expected: f64) {
    let actual = actual.as_f64().unwrap();
    assert!((actual - expected).abs() < 1e-8, "{actual} versus independent value {expected}");
}

fn difference(e: &mut Engine, left: Value, right: Value, onto: &str) -> femlab_engine::query::DifferenceField {
    let query: Query =
        serde_json::from_value(json!({"query":"query.difference","left":left,"right":right,"onto":onto})).unwrap();
    let QueryResult::Difference(field) = e.query(query).unwrap() else { panic!("a difference field") };
    field
}

fn conductivity_solve(e: &mut Engine, nx: u32, order: u32, conductivity: u32) -> (String, Vec<f64>) {
    let material = format!("difference-k{conductivity}");
    ok(
        e,
        &json!({"cmd":"material.add","name":material,"E":"210 GPa","nu":0.3,
        "rho":"10 kg/m^3","cp":"2 J/(kg K)","k":format!("{conductivity} W/(m K)")})
        .to_string(),
    );
    ok(e, &json!({"cmd":"material.assign","material":material,"bodies":["bar"]}).to_string());
    ok(
        e,
        &json!({"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":nx,"ny":1,"nz":1}},"order":order}).to_string(),
    );
    let id = retained_solve(e, "conduct");
    (id, e.mesh().unwrap().mesh.coords.clone())
}

#[test]
fn difference_fields_project_closed_form_temperature_between_unequal_linear_and_quadratic_meshes() {
    let mut e = engine();
    retained_conductor(&mut e);
    let (left_id, left_coords) = conductivity_solve(&mut e, 2, 1, 45);
    ok(&mut e, r#"{"cmd":"model.setUnits","units":{"length":"in","temperature":"K"}}"#);
    let (right_id, right_coords) = conductivity_solve(&mut e, 4, 2, 90);
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"cold","on":"bar.xmin","value":"10 degC"}"#);
    let (offset_id, _) = conductivity_solve(&mut e, 4, 2, 45);
    let before = serde_json::to_value(e.export_file()).unwrap();
    let retained_before = retained_query(&mut e, json!({"query":"query.results"}));
    for (onto, coords) in [("left", &left_coords), ("right", &right_coords)] {
        let field = difference(
            &mut e,
            json!({"resultId":left_id,"field":"temperature"}),
            json!({"resultId":right_id,"field":"temperature"}),
            onto,
        );
        assert!(field.interpolated);
        assert_eq!(field.unit, "K");
        assert_eq!(field.components, 3);
        assert_eq!(field.node_count * 3, field.values.len());
        assert_eq!((field.coverage.inside_nodes, field.coverage.total_nodes), (field.node_count, field.node_count));
        assert!(field.coverage.outside_nodes.is_empty());
        assert_eq!(field.comparison_result_id, if onto == "left" { left_id.as_str() } else { right_id.as_str() });
        assert_eq!((field.left.field.as_str(), field.right.field.as_str()), ("temperature", "temperature"));
        assert_eq!((field.left.source_components, field.right.source_components), (3, 3));
        for (point, value) in coords.chunks_exact(3).zip(field.values.chunks_exact(3)) {
            assert!((value[0].unwrap() - 10.0 * point[0]).abs() < 1e-8);
            assert_eq!(&value[1..], &[Some(0.0), Some(0.0)]);
        }
    }
    let constant = difference(
        &mut e,
        json!({"resultId":offset_id,"field":"temperature","component":0}),
        json!({"resultId":left_id,"field":"temperature","component":0}),
        "right",
    );
    assert!(constant.interpolated);
    assert!(constant.values.iter().all(|value| value.is_some_and(|value| (value - 10.0).abs() < 1e-8)));
    let reversed = difference(
        &mut e,
        json!({"resultId":right_id,"field":"temperature","component":0}),
        json!({"resultId":left_id,"field":"temperature","component":0}),
        "left",
    );
    for (point, value) in right_coords.chunks_exact(3).zip(&reversed.values) {
        assert!((value.unwrap() + 10.0 * point[0]).abs() < 1e-8);
    }
    assert_eq!(
        reversed,
        difference(
            &mut e,
            json!({"resultId":right_id,"field":"temperature","component":0}),
            json!({"resultId":left_id,"field":"temperature","component":0}),
            "left",
        )
    );
    let zero = difference(
        &mut e,
        json!({"resultId":right_id,"field":"temperature"}),
        json!({"resultId":right_id,"field":"temperature"}),
        "right",
    );
    assert!(!zero.interpolated);
    assert!(zero.values.iter().all(|value| *value == Some(0.0)));
    assert_eq!(serde_json::to_value(e.export_file()).unwrap(), before);
    assert_eq!(retained_query(&mut e, json!({"query":"query.results"})), retained_before);
}

#[test]
fn difference_fields_report_partial_and_zero_coverage_without_filling_outside_nodes() {
    let mut e = engine();
    retained_conductor(&mut e);
    let (left_id, left_coords) = conductivity_solve(&mut e, 2, 1, 45);
    ok(
        &mut e,
        r#"{"cmd":"geometry.addBox","name":"bar","size":["1 m","100 mm","100 mm"],"at":["500 mm","0 m","0 m"]}"#,
    );
    let (right_id, right_coords) = conductivity_solve(&mut e, 2, 1, 45);
    for (onto, coords, outside) in [
        (
            "left",
            &left_coords,
            left_coords
                .chunks_exact(3)
                .enumerate()
                .filter(|(_, p)| p[0] < 0.5)
                .map(|(i, _)| i as u32)
                .collect::<Vec<_>>(),
        ),
        (
            "right",
            &right_coords,
            right_coords
                .chunks_exact(3)
                .enumerate()
                .filter(|(_, p)| p[0] > 1.0)
                .map(|(i, _)| i as u32)
                .collect::<Vec<_>>(),
        ),
    ] {
        let field = difference(
            &mut e,
            json!({"resultId":left_id,"field":"temperature","component":0}),
            json!({"resultId":right_id,"field":"temperature","component":0}),
            onto,
        );
        assert_eq!(field.coverage.outside_nodes, outside);
        assert_eq!(field.coverage.inside_nodes + outside.len(), coords.len() / 3);
        for (node, value) in field.values.iter().enumerate() {
            assert_eq!(value.is_none(), outside.contains(&(node as u32)));
            if let Some(value) = value {
                assert!((value - 10.0).abs() < 1e-8, "covered node {node}: {value} K versus 10 K");
            }
        }
    }
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"bar","size":["1 m","100 mm","100 mm"],"at":["2 m","0 m","0 m"]}"#);
    let (far_id, far_coords) = conductivity_solve(&mut e, 1, 2, 45);
    let none = difference(
        &mut e,
        json!({"resultId":left_id,"field":"temperature","component":0}),
        json!({"resultId":far_id,"field":"temperature","component":0}),
        "right",
    );
    assert_eq!(none.coverage.inside_nodes, 0);
    assert_eq!(none.coverage.outside_nodes, (0..far_coords.len() as u32 / 3).collect::<Vec<_>>());
    assert!(none.values.iter().all(Option::is_none));
}

#[test]
fn difference_reactions_require_the_same_physical_quantity_and_keep_thermal_power_in_watts() {
    let mut e = engine();
    cantilever(&mut e);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":2,"ny":1,"nz":1}},"order":1}"#);
    let mechanical_id = retained_solve(&mut e, "static");
    ok(
        &mut e,
        r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"rho":"7850 kg/m^3","k":"45 W/(m K)","cp":"460 J/(kg K)"}"#,
    );
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"cold","on":"beam.xmin","value":"0 degC"}"#);
    ok(&mut e, r#"{"cmd":"load.heatFlux","name":"heater","on":"beam.xmax","q":"900 W/m^2"}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"conduct","procedure":"heat-steady","constraints":["cold"],"loads":["heater"],"output":["temperature"]}"#,
    );
    let thermal_left = retained_solve(&mut e, "conduct");
    let thermal_right = retained_solve(&mut e, "conduct");

    let mismatch = retained_error(
        &mut e,
        json!({"query":"query.difference",
          "left":{"resultId":mechanical_id,"field":"reaction"},
          "right":{"resultId":thermal_left,"field":"reaction"},"onto":"left"}),
    );
    assert_eq!((mismatch.code, mismatch.where_.as_deref()), (ErrorCode::UnitDimension, Some("right.field")));

    let thermal = difference(
        &mut e,
        json!({"resultId":thermal_left,"field":"reaction"}),
        json!({"resultId":thermal_right,"field":"reaction"}),
        "left",
    );
    assert_eq!(thermal.unit, "W");
    assert!(!thermal.interpolated);
    assert_eq!(thermal.coverage.inside_nodes, thermal.node_count);
    assert!(thermal.values.iter().all(|value| *value == Some(0.0)));
}

#[test]
fn difference_fields_keep_two_dimensional_holes_outside_and_all_components_null() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"holed sheet"}"#);
    ok(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStress","thickness":"10 mm"}}"#);
    let full = r#"{"cmd":"geometry.add","name":"plate","shape":{"kind":"sheet","sketch":{"outer":[
      {"kind":"line","to":["1 m","0 m"],"tag":"bottom"},{"kind":"line","to":["1 m","1 m"],"tag":"right"},
      {"kind":"line","to":["0 m","1 m"],"tag":"top"},{"kind":"line","to":["0 m","0 m"],"tag":"left"}]}}}"#;
    ok(&mut e, full);
    ok(&mut e, r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3}"#);
    ok(&mut e, r#"{"cmd":"material.assign","material":"steel","bodies":["plate"]}"#);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":4,"ny":4,"nz":1}},"order":1}"#);
    ok(
        &mut e,
        r#"{"cmd":"geometry.nameRegion","name":"root-edge","where":{"kind":"bbox","min":["-1 mm","-1 mm","-1 mm"],"max":["1 mm","1001 mm","1 mm"]}}"#,
    );
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"root","on":"root-edge"}"#);
    ok(&mut e, r#"{"cmd":"step.add","name":"zero","procedure":"static","constraints":["root"],"loads":[]}"#);
    let full_id = retained_solve(&mut e, "zero");
    let full_coords = e.mesh().unwrap().mesh.coords.clone();
    let holed = r#"{"cmd":"geometry.add","name":"plate","shape":{"kind":"sheet","sketch":{"outer":[
      {"kind":"line","to":["1 m","0 m"],"tag":"bottom"},{"kind":"line","to":["1 m","1 m"],"tag":"right"},
      {"kind":"line","to":["0 m","1 m"],"tag":"top"},{"kind":"line","to":["0 m","0 m"],"tag":"left"}],
      "holes":[[{"kind":"line","to":["0.7 m","0.3 m"],"tag":"hole"},{"kind":"line","to":["0.7 m","0.7 m"],"tag":"hole"},
      {"kind":"line","to":["0.3 m","0.7 m"],"tag":"hole"},{"kind":"line","to":["0.3 m","0.3 m"],"tag":"hole"}]]}}}"#;
    ok(&mut e, holed);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":4,"ny":4,"nz":1}},"order":2}"#);
    let holed_id = retained_solve(&mut e, "zero");
    let onto_full = difference(
        &mut e,
        json!({"resultId":full_id,"field":"displacement"}),
        json!({"resultId":holed_id,"field":"displacement"}),
        "left",
    );
    let expected: Vec<u32> = full_coords
        .chunks_exact(3)
        .enumerate()
        .filter(|(_, point)| (0.3..0.7).contains(&point[0]) && (0.3..0.7).contains(&point[1]))
        .map(|(node, _)| node as u32)
        .collect();
    assert!(!expected.is_empty());
    assert_eq!(onto_full.coverage.outside_nodes, expected);
    for (node, values) in onto_full.values.chunks_exact(3).enumerate() {
        assert_eq!(values.iter().all(Option::is_none), expected.contains(&(node as u32)));
        assert!(values.iter().all(|value| value.is_none_or(|value| value.abs() < 1e-14)));
    }
    let onto_hole = difference(
        &mut e,
        json!({"resultId":full_id,"field":"displacement"}),
        json!({"resultId":holed_id,"field":"displacement"}),
        "right",
    );
    assert_eq!(onto_hole.coverage.inside_nodes, onto_hole.node_count);
    assert!(onto_hole.coverage.outside_nodes.is_empty());
    assert!(onto_hole.values.iter().all(|value| value.is_some_and(|value| value.abs() < 1e-14)));
}

#[test]
fn difference_field_rejects_ambiguous_layout_dimensions_geometry_and_missing_operands() {
    let mut e = engine();
    cantilever(&mut e);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":2,"ny":1,"nz":1}},"order":1}"#);
    let static_id = retained_solve(&mut e, "static");
    ok(&mut e, r#"{"cmd":"step.add","name":"modes","procedure":"modal","constraints":["root"],"loads":[],"nModes":2}"#);
    let modal_id = retained_solve(&mut e, "modes");
    ok(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStress","thickness":"10 mm"}}"#);
    ok(
        &mut e,
        r#"{"cmd":"geometry.add","name":"beam","shape":{"kind":"sheet","sketch":{"outer":[
          {"kind":"line","to":["1 m","0 m"],"tag":"ymin"},{"kind":"line","to":["1 m","100 mm"],"tag":"xmax"},
          {"kind":"line","to":["0 m","100 mm"],"tag":"ymax"},{"kind":"line","to":["0 m","0 m"],"tag":"xmin"}]}}}"#,
    );
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":2,"ny":1,"nz":1}},"order":1}"#);
    ok(&mut e, r#"{"cmd":"step.add","name":"zero-2d","procedure":"static","constraints":["root"],"loads":[]}"#);
    let two_dimensional_id = retained_solve(&mut e, "zero-2d");
    let before = e.export_file();
    for (left, right, code, where_) in [
        (
            json!({"resultId":"absent","field":"displacement"}),
            json!({"resultId":modal_id,"field":"mode:1"}),
            ErrorCode::NotFound,
            "left.resultId",
        ),
        (
            json!({"resultId":static_id,"field":"displacement"}),
            json!({"resultId":"absent","field":"mode:1"}),
            ErrorCode::NotFound,
            "right.resultId",
        ),
        (
            json!({"resultId":static_id,"field":"typo"}),
            json!({"resultId":modal_id,"field":"mode:1"}),
            ErrorCode::Schema,
            "left.field",
        ),
        (
            json!({"resultId":static_id,"field":"temperature"}),
            json!({"resultId":modal_id,"field":"mode:1"}),
            ErrorCode::NotFound,
            "left.field",
        ),
        (
            json!({"resultId":static_id,"field":"stressUnaveraged"}),
            json!({"resultId":static_id,"field":"stressUnaveraged"}),
            ErrorCode::Unsupported,
            "left.field",
        ),
        (
            json!({"resultId":static_id,"field":"displacement","component":3}),
            json!({"resultId":modal_id,"field":"mode:1","component":0}),
            ErrorCode::Schema,
            "left.component",
        ),
        (
            json!({"resultId":static_id,"field":"displacement","component":0}),
            json!({"resultId":modal_id,"field":"mode:1"}),
            ErrorCode::Schema,
            "right.component",
        ),
        (
            json!({"resultId":static_id,"field":"displacement"}),
            json!({"resultId":static_id,"field":"stress"}),
            ErrorCode::Unsupported,
            "right.field",
        ),
        (
            json!({"resultId":static_id,"field":"displacement","component":0}),
            json!({"resultId":static_id,"field":"stress","component":0}),
            ErrorCode::UnitDimension,
            "right.field",
        ),
        (
            json!({"resultId":static_id,"field":"displacement"}),
            json!({"resultId":two_dimensional_id,"field":"displacement"}),
            ErrorCode::Unsupported,
            "onto",
        ),
    ] {
        let error = retained_error(&mut e, json!({"query":"query.difference","left":left,"right":right,"onto":"left"}));
        assert_eq!((error.code, error.where_.as_deref()), (code, Some(where_)));
        assert!(error.suggestion.is_some());
    }
    let raw = difference(
        &mut e,
        json!({"resultId":modal_id,"field":"mode:1","component":0}),
        json!({"resultId":modal_id,"field":"mode:2","component":0}),
        "left",
    );
    let mode_1 = retained_query(&mut e, json!({"query":"query.field","resultId":modal_id,"field":"mode:1"}));
    let mode_2 = retained_query(&mut e, json!({"query":"query.field","resultId":modal_id,"field":"mode:2"}));
    assert!(
        mode_1["values"]
            .as_array()
            .unwrap()
            .iter()
            .zip(mode_2["values"].as_array().unwrap())
            .enumerate()
            .any(|(component, (left, right))| component % 3 == 0
                && left.as_f64().unwrap() * right.as_f64().unwrap() < 0.0)
    );
    for (node, value) in raw.values.iter().enumerate() {
        retained_close(
            &json!(value.unwrap()),
            mode_1["values"][node * 3].as_f64().unwrap() - mode_2["values"][node * 3].as_f64().unwrap(),
        );
    }
    assert_eq!(raw.warnings[0].code, "result.mode-uncorrelated");
    assert_eq!(serde_json::to_value(e.export_file()).unwrap(), serde_json::to_value(before).unwrap());
}

#[test]
fn retained_conduction_fields_keep_each_solved_mesh_material_and_display_units() {
    let mut e = engine();
    retained_conductor(&mut e);
    let mut solved = Vec::new();
    // Fourier's law: T(x) = 273.15 + q*x/k; the three materials produce distinct fields.
    for (nx, conductivity) in [(2, 45), (4, 90), (8, 180)] {
        let material = format!("k{conductivity}");
        ok(
            &mut e,
            &json!({"cmd":"material.add","name":material,"E":"210 GPa","nu":0.3,
            "rho":"10 kg/m^3","cp":"2 J/(kg K)","k":format!("{conductivity} W/(m K)")})
            .to_string(),
        );
        ok(&mut e, &json!({"cmd":"material.assign","material":material,"bodies":["bar"]}).to_string());
        ok(&mut e, &json!({"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":nx,"ny":1,"nz":1}}}).to_string());
        let coords = e.mesh().unwrap().mesh.coords.clone();
        let hash = e.model_hash();
        let id = retained_solve(&mut e, "conduct");
        let records = retained_records(&mut e);
        let record = records.last().unwrap();
        assert_eq!(record["id"], id);
        assert_eq!(record["step"], "conduct");
        assert_eq!(record["solvedRevision"], e.revision());
        assert_eq!(record["modelHash"], hash);
        assert_eq!(record["modelName"], "heat");
        assert_eq!(record["nodes"], 4 * (nx + 1));
        assert_eq!(record["elements"], nx);
        assert_eq!(record["stale"], false);
        assert_eq!(record["inputHash"].as_str().unwrap().len(), 64);
        assert!(record["meshBytes"].as_u64().unwrap() >= coords.len() as u64 * 8);
        assert_eq!(record["modelJsonBytes"], serde_json::to_vec(e.model()).unwrap().len());
        let field = retained_query(&mut e, json!({"query":"query.field","field":"temperature"}));
        assert_eq!(field["resultId"], id);
        assert_eq!(field["unit"], "K");
        assert_eq!(field["components"], 3);
        assert_eq!(field["per"], "node");
        assert_eq!(field["nodeCount"], 4 * (nx + 1));
        assert_eq!(field["entityCount"], field["nodeCount"]);
        let values = field["values"].as_array().unwrap();
        assert_eq!(values.len(), coords.len());
        assert!(record["fieldBytes"].as_u64().unwrap() >= values.len() as u64 * 8);
        for (point, value) in coords.chunks_exact(3).zip(values.chunks_exact(3)) {
            retained_close(&value[0], 273.15 + 900.0 * point[0] / f64::from(conductivity));
            retained_close(&value[1], 0.0);
            retained_close(&value[2], 0.0);
        }
        solved.push((id, conductivity, field, record.clone()));
    }
    ok(&mut e, r#"{"cmd":"model.setUnits","units":{"length":"m","temperature":"K","time":"ms"}}"#);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":3,"ny":2,"nz":2}}}"#);
    // Force construction of a different live Mesh before asking for historical samples.
    assert_eq!(e.mesh().unwrap().mesh.n_elems(), 12);
    let before = e.export_file();
    let records = retained_records(&mut e);
    for (index, (id, conductivity, original, metadata)) in solved.iter().enumerate() {
        assert_eq!(records[index]["stale"], true);
        for key in [
            "id",
            "step",
            "solvedRevision",
            "modelName",
            "modelHash",
            "inputHash",
            "nodes",
            "elements",
            "fieldBytes",
            "meshBytes",
            "modelJsonBytes",
        ] {
            assert_eq!(records[index][key], metadata[key]);
        }
        assert_eq!(
            retained_query(&mut e, json!({"query":"query.field","resultId":id,"field":"temperature"})),
            *original
        );
        let summary = retained_query(&mut e, json!({"query":"query.result","resultId":id,"step":"conduct"}));
        assert_eq!(summary["resultId"], *id);
        assert_eq!(summary["stale"], true);
        let probe = retained_query(
            &mut e,
            json!({"query":"query.probe","resultId":id,"field":"temperature","at":["500 mm","50 mm","50 mm"]}),
        );
        assert_eq!(probe["value"]["unit"], "degC");
        retained_close(&probe["value"]["value"], 450.0 / f64::from(*conductivity));
        let path = retained_query(
            &mut e,
            json!({"query":"query.path","resultId":id,"field":"temperature",
            "from":["0 m","50 mm","50 mm"],"to":["1 m","50 mm","50 mm"],"n":5}),
        );
        assert_eq!(path["unit"], "degC");
        for (i, value) in path["values"].as_array().unwrap().iter().enumerate() {
            retained_close(value, 900.0 * i as f64 / (4.0 * f64::from(*conductivity)));
        }
    }
    for query in [
        json!({"query":"query.field","step":"conduct","field":"temperature"}),
        json!({"query":"query.probe","field":"temperature","at":["0.5 m","0.05 m","0.05 m"]}),
        json!({"query":"query.path","field":"temperature","from":["0 m","0 m","0 m"],"to":["1 m","0 m","0 m"],"n":3}),
    ] {
        let error = retained_error(&mut e, query);
        assert_eq!(error.code, ErrorCode::ResultStale);
    }
    assert_eq!(serde_json::to_value(e.export_file()).unwrap(), serde_json::to_value(before).unwrap());
}

#[test]
fn retained_ids_are_distinct_oldest_first_and_reads_or_failures_do_not_change_eviction() {
    let mut e = engine();
    retained_conductor(&mut e);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":2,"ny":1,"nz":1}}}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"other","procedure":"heat-steady","constraints":["cold"],"loads":["heater"]}"#,
    );
    let first = retained_solve(&mut e, "conduct");
    let mut ids = vec![first.clone()];
    for _ in 0..7 {
        let id = retained_solve(&mut e, "other");
        assert!(!ids.contains(&id), "identical inputs still yield a new solve identity");
        ids.push(id);
    }
    let full = retained_records(&mut e);
    assert_eq!(full.len(), 8);
    for (record, id) in full.iter().zip(&ids) {
        assert_eq!(record["id"], *id);
        assert_eq!(record["inputHash"], full[0]["inputHash"]);
        assert_eq!(record["modelHash"], full[0]["modelHash"]);
    }
    let before = e.export_file();
    let failure = err(&mut e, r#"{"cmd":"solve.run","step":"missing"}"#);
    assert_eq!(failure.code, ErrorCode::NotFound);
    assert_eq!(retained_records(&mut e), full);
    assert_eq!(serde_json::to_value(e.export_file()).unwrap(), serde_json::to_value(before).unwrap());
    // Reading the oldest record does not turn FIFO retention into LRU retention.
    assert_eq!(retained_query(&mut e, json!({"query":"query.result","resultId":first}))["resultId"], first);
    let ninth = retained_solve(&mut e, "other");
    ids.remove(0);
    ids.push(ninth.clone());
    let records = retained_records(&mut e);
    assert_eq!(records.len(), 8);
    for (record, id) in records.iter().zip(ids) {
        assert_eq!(record["id"], id);
    }
    assert_eq!(retained_error(&mut e, json!({"query":"query.result","resultId":first})).code, ErrorCode::NotFound);
    assert_eq!(retained_error(&mut e, json!({"query":"query.result","step":"conduct"})).code, ErrorCode::NotFound);
    assert_eq!(retained_query(&mut e, json!({"query":"query.result"}))["resultId"], ninth);
    assert_eq!(
        retained_query(&mut e, json!({"query":"query.field","step":"other","field":"temperature"}))["resultId"],
        ninth
    );
    // Evicting an older solve of the same Step must preserve its newest default.
    let tenth = retained_solve(&mut e, "other");
    assert_eq!(retained_records(&mut e).len(), 8);
    assert_eq!(
        retained_error(&mut e, json!({"query":"query.result","resultId":full[1]["id"]})).code,
        ErrorCode::NotFound
    );
    assert_eq!(retained_query(&mut e, json!({"query":"query.result","step":"other"}))["resultId"], tenth);
    assert_eq!(retained_query(&mut e, json!({"query":"query.result","resultId":ninth}))["resultId"], ninth);
}

#[test]
fn retained_selection_reports_missing_ids_and_step_mismatches_for_every_consumer() {
    let mut e = engine();
    retained_conductor(&mut e);
    let id = retained_solve(&mut e, "conduct");
    let before = e.export_file();
    let consumers = [
        json!({"query":"query.result"}),
        json!({"query":"query.field","field":"temperature"}),
        json!({"query":"query.frames"}),
        json!({"query":"query.frame","index":0}),
        json!({"query":"query.probe","field":"temperature","at":["0 m","0 m","0 m"]}),
        json!({"query":"query.path","field":"temperature","from":["0 m","0 m","0 m"],"to":["1 m","0 m","0 m"],"n":3}),
    ];
    for mut query in consumers {
        query["resultId"] = json!("absent-result");
        let absent = retained_error(&mut e, query.clone());
        assert_eq!(absent.code, ErrorCode::NotFound);
        assert_eq!(absent.where_.as_deref(), Some("resultId"));
        query["resultId"] = json!(id);
        query["step"] = json!("another-step");
        let mismatch = retained_error(&mut e, query);
        assert_eq!(mismatch.code, ErrorCode::Schema);
        assert_eq!(mismatch.where_.as_deref(), Some("step"));
    }
    assert_eq!(
        retained_error(&mut e, json!({"query":"query.field","resultId":id,"field":"displacement"})).code,
        ErrorCode::NotFound
    );
    assert_eq!(
        retained_error(&mut e, json!({"query":"query.field","resultId":id,"field":"not-a-field"})).code,
        ErrorCode::Schema
    );
    assert_eq!(serde_json::to_value(e.export_file()).unwrap(), serde_json::to_value(before).unwrap());
}

#[test]
fn retained_transient_samples_keep_their_identity_mesh_units_and_uniform_heating_solution() {
    let mut e = engine();
    heat_bar(&mut e);
    ok(
        &mut e,
        r#"{"cmd":"material.add","name":"thermal","E":"1 GPa","nu":0.3,"rho":"10 kg/m^3","cp":"2 J/(kg K)","k":"45 W/(m K)"}"#,
    );
    ok(&mut e, r#"{"cmd":"material.assign","material":"thermal","bodies":["bar"]}"#);
    ok(&mut e, r#"{"cmd":"load.heatSource","name":"source","bodies":["bar"],"q":"40 W/m^3"}"#);
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"ramp","on":"bar.xmin","value":"1 K"}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"warm","procedure":"heat-transient","constraints":["ramp"],"loads":["source"],"dt":"0.1 s","tEnd":"0.3 s","initial":"300 K","amplitude":{"kind":"table","t":["0 s","0.3 s"],"value":[300,300.6]},"theta":1,"outputEvery":1,"output":["temperature"]}"#,
    );
    let mut ids = Vec::new();
    for nx in [2, 4, 8] {
        ok(&mut e, &json!({"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":nx,"ny":1,"nz":1}}}).to_string());
        ids.push((retained_solve(&mut e, "warm"), 4 * (nx + 1)));
    }
    let catalogue = retained_records(&mut e);
    assert_eq!(catalogue.len(), 3);
    assert!(catalogue.iter().all(|record| record["fieldBytes"].as_u64().unwrap() > 0));
    ok(&mut e, r#"{"cmd":"model.setUnits","units":{"temperature":"K","time":"ms","length":"m"}}"#);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":3,"ny":1,"nz":1}}}"#);
    e.mesh().unwrap();
    let before = e.export_file();
    for (id, nodes) in ids {
        let frames = retained_query(&mut e, json!({"query":"query.frames","resultId":id}));
        assert_eq!(frames["resultId"], id);
        assert_eq!(frames["nodeCount"], nodes);
        assert_eq!(frames["stale"], true);
        assert_eq!(frames["frames"].as_array().unwrap().len(), 4);
        for index in 0..4 {
            let time = index as f64 * 0.1;
            retained_close(&frames["frames"][index]["time"]["value"], time);
            assert_eq!(frames["frames"][index]["time"]["unit"], "s");
            let frame = retained_query(&mut e, json!({"query":"query.frame","resultId":id,"index":index}));
            assert_eq!(frame["sample"]["resultId"], id);
            assert_eq!(frame["sample"]["modelHash"], frames["modelHash"]);
            assert_eq!(frame["nodeCount"], nodes);
            assert_eq!(frame["unit"], "K");
            let values = frame["values"].as_array().unwrap();
            assert_eq!(values.len(), 3 * nodes);
            // Independent energy balance rho*cp*dT/dt=q: T=300+2t everywhere.
            for value in values.chunks_exact(3) {
                retained_close(&value[0], 300.0 + 2.0 * time);
                retained_close(&value[1], 0.0);
                retained_close(&value[2], 0.0);
            }
            let sample = json!({"kind":"time","time":format!("{time} s"),"sampling":"exact"});
            let probe = retained_query(
                &mut e,
                json!({"query":"query.probe","resultId":id,"field":"temperature","sample":sample,"at":["0.5 m","0.05 m","0.05 m"]}),
            );
            assert_eq!(probe["sample"]["resultId"], id);
            assert_eq!(probe["sample"]["frame"]["index"], index);
            assert_eq!(probe["value"]["unit"], "degC");
            retained_close(&probe["value"]["value"], 26.85 + 2.0 * time);
            let path = retained_query(
                &mut e,
                json!({"query":"query.path","resultId":id,"field":"temperature","sample":sample,
                "from":["0 m","0 m","0 m"],"to":["1 m","0 m","0 m"],"n":3}),
            );
            assert_eq!(path["sample"]["resultId"], id);
            assert_eq!(path["unit"], "degC");
            for value in path["values"].as_array().unwrap() {
                retained_close(value, 26.85 + 2.0 * time);
            }
        }
    }
    assert_eq!(
        retained_error(&mut e, json!({"query":"query.frame","step":"warm","index":1})).code,
        ErrorCode::ResultStale
    );
    assert_eq!(serde_json::to_value(e.export_file()).unwrap(), serde_json::to_value(before).unwrap());
}

#[test]
fn retained_records_clear_on_new_import_and_replay_without_recycling_ids_or_journal_hashes() {
    let mut e = engine();
    retained_conductor(&mut e);
    let first = retained_solve(&mut e, "conduct");
    let file = e.export_file();
    let original_hash = e.model_hash();
    ok(&mut e, r#"{"cmd":"model.new","name":"empty"}"#);
    assert!(retained_records(&mut e).is_empty());
    assert_eq!(retained_error(&mut e, json!({"query":"query.result","resultId":first})).code, ErrorCode::NotFound);
    e.import_file(file.clone()).unwrap();
    assert!(retained_records(&mut e).is_empty());
    let second = retained_solve(&mut e, "conduct");
    assert_ne!(first, second);
    e.import_file(file.clone()).unwrap();
    assert!(retained_records(&mut e).is_empty());
    assert_eq!(
        retained_error(&mut e, json!({"query":"query.field","resultId":second,"field":"temperature"})).code,
        ErrorCode::NotFound
    );
    let third = retained_solve(&mut e, "conduct");
    assert_ne!(second, third);
    let hashes = pollster::block_on(e.replay(&file.journal.entries, true, true)).unwrap();
    assert!(retained_records(&mut e).is_empty());
    assert_eq!(e.model_hash(), original_hash);
    assert_eq!(hashes, file.journal.entries.iter().map(|entry| entry.hash_after.clone()).collect::<Vec<_>>());
    let fourth = retained_solve(&mut e, "conduct");
    for previous in [&first, &second, &third] {
        assert_ne!(*previous, fourth);
    }
    let replay_hashes = pollster::block_on(e.replay(&file.journal.entries, false, true)).unwrap();
    assert_eq!(replay_hashes, hashes);
    assert_eq!(retained_records(&mut e).len(), 1);
    let fifth = retained_query(&mut e, json!({"query":"query.result"}))["resultId"].as_str().unwrap().to_owned();
    for previous in [&first, &second, &third, &fourth] {
        assert_ne!(*previous, fifth);
    }
    assert_eq!(e.model_hash(), original_hash);
    assert_eq!(serde_json::to_value(e.export_file()).unwrap(), serde_json::to_value(file).unwrap());
}

#[test]
fn retained_fields_preserve_modal_shapes_and_unaveraged_entity_layout() {
    let mut e = engine();
    cantilever(&mut e);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":2,"ny":1,"nz":1}},"order":1}"#);
    let static_id = retained_solve(&mut e, "static");
    let field = retained_query(&mut e, json!({"query":"query.field","resultId":static_id,"field":"stressUnaveraged"}));
    assert_eq!(field["per"], "elementNode");
    assert_eq!(field["entityCount"], 16);
    assert_eq!(field["components"], 6);
    assert_eq!(field["values"].as_array().unwrap().len(), 96);
    assert_eq!(field["unit"], "Pa");
    ok(&mut e, r#"{"cmd":"step.add","name":"modes","procedure":"modal","constraints":["root"],"loads":[],"nModes":2}"#);
    let modal_id = retained_solve(&mut e, "modes");
    let modes = [
        e.field_named(Some("modes"), "mode:1").unwrap().data.clone(),
        e.field_named(Some("modes"), "mode:2").unwrap().data.clone(),
    ];
    let records = retained_records(&mut e);
    assert_eq!(records.len(), 2);
    let summary = retained_query(&mut e, json!({"query":"query.result","resultId":modal_id}));
    assert!(summary["frequencies"][0]["value"].as_f64().unwrap() > 0.0);
    assert!(records[1]["fieldBytes"].as_u64().unwrap() >= modes.iter().map(|mode| mode.len() as u64 * 8).sum::<u64>());
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"beam","size":["2 m","100 mm","100 mm"]}"#);
    for (index, expected) in modes.iter().enumerate() {
        let field = retained_query(
            &mut e,
            json!({"query":"query.field","resultId":modal_id,"field":format!("mode:{}",index+1)}),
        );
        assert_eq!(field["values"], json!(expected)); // routing preserves the actual retained mode, without recomputation
        assert_eq!(field["per"], "node");
        assert_eq!(field["unit"], "m");
        assert_eq!(field["nodeCount"], 12);
    }
    for name in ["mode:0", "mode:3", "mode:bad"] {
        assert_eq!(
            retained_error(&mut e, json!({"query":"query.field","resultId":modal_id,"field":name})).code,
            ErrorCode::NotFound
        );
    }
    assert_eq!(
        retained_error(&mut e, json!({"query":"query.field","resultId":modal_id,"field":"typo"})).code,
        ErrorCode::Schema
    );
}

#[test]
fn evicting_the_only_result_of_a_step_removes_its_default_selection() {
    let mut e = engine();
    retained_conductor(&mut e);
    let mut oldest = String::new();
    for index in 0..9 {
        let step = format!("conduct-{index}");
        ok(
            &mut e,
            &json!({"cmd":"step.add","name":step,"procedure":"heat-steady","constraints":["cold"],"loads":["heater"]})
                .to_string(),
        );
        let id = retained_solve(&mut e, &step);
        if index == 0 {
            oldest = id;
        }
    }
    assert_eq!(retained_records(&mut e).len(), 8);
    assert_eq!(retained_error(&mut e, json!({"query":"query.result","resultId":oldest})).code, ErrorCode::NotFound);
    assert_eq!(retained_error(&mut e, json!({"query":"query.result","step":"conduct-0"})).code, ErrorCode::NotFound);
    assert_eq!(retained_query(&mut e, json!({"query":"query.result"}))["step"], "conduct-8");
}

#[test]
fn retained_cost_counts_all_live_records_before_the_next_solve() {
    for nx in [2, 4, 8] {
        let mut e = engine();
        retained_conductor(&mut e);
        ok(&mut e, &json!({"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":nx,"ny":1,"nz":1}}}).to_string());
        let empty = retained_query(&mut e, json!({"query":"query.cost","step":"conduct"}));
        assert_eq!(empty["residentResultBytes"], 0);
        for _ in 0..9 {
            retained_solve(&mut e, "conduct");
            let records = retained_records(&mut e);
            let expected: u64 =
                records.iter().map(|r| r["fieldBytes"].as_u64().unwrap() + r["meshBytes"].as_u64().unwrap()).sum();
            let cost = retained_query(&mut e, json!({"query":"query.cost","step":"conduct"}));
            assert_eq!(cost["residentResultBytes"], expected);
            assert_eq!(cost["resultMeshBytes"], records[0]["meshBytes"]);
            assert_eq!(cost["bytes"].as_u64().unwrap(), empty["bytes"].as_u64().unwrap() + expected);
        }
        let records = retained_records(&mut e);
        assert_eq!(records.len(), 8);
        // The oldest record still contributes; it is evicted only after the next solve succeeds.
        let cost = retained_query(&mut e, json!({"query":"query.cost","step":"conduct"}));
        assert_eq!(
            cost["residentResultBytes"].as_u64().unwrap(),
            8 * (records[0]["fieldBytes"].as_u64().unwrap() + records[0]["meshBytes"].as_u64().unwrap())
        );
    }
}

#[test]
fn retained_thermal_reaction_fields_and_samples_use_power_with_solved_units() {
    for nx in [2, 4, 8] {
        let mut e = engine();
        retained_conductor(&mut e);
        ok(&mut e, &json!({"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":nx,"ny":1,"nz":1}}}).to_string());
        let id = retained_solve(&mut e, "conduct");
        ok(&mut e, r#"{"cmd":"model.setUnits","units":{"power":"kW","force":"N"}}"#);
        ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":12,"ny":2,"nz":2}}}"#);
        let field = retained_query(&mut e, json!({"query":"query.field","resultId":id,"field":"reaction"}));
        assert_eq!(field["unit"], "W");
        let total: f64 = field["values"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).sum();
        // Fourier end flux times area: 900 W/m² × 0.01 m² = 9 W removed at the cold face.
        assert!((total - 9.0).abs() < 1e-8);
        let summary = retained_query(&mut e, json!({"query":"query.result","resultId":id}));
        assert_eq!(summary["reactionQuantity"], "power");
        assert_eq!(summary["reactions"][0]["total"][0]["unit"], "W");
        let probe = retained_query(
            &mut e,
            json!({"query":"query.probe","resultId":id,"field":"reaction","component":0,"at":["0 m","0 m","0 m"]}),
        );
        assert_eq!(probe["value"]["unit"], "W");
        retained_close(&probe["value"]["value"], 2.25);
        let path = retained_query(
            &mut e,
            json!({"query":"query.path","resultId":id,"field":"reaction","component":0,"from":["0 m","0 m","0 m"],"to":["0 m","0.1 m","0 m"],"n":3}),
        );
        assert_eq!(path["unit"], "W");
        for value in path["values"].as_array().unwrap() {
            retained_close(value, 2.25);
        }
    }
}
