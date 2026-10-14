//! Public checked-display boundaries, with exact authored values and independent SI oracles.
use super::{engine, ok, Engine, ErrorCode, Query, IMPORTED_TET};
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
    let file = e.export_file();
    let hash = e.model_hash();
    let revision = e.revision();
    let catalogue = e.query(Query::Results {}).unwrap();
    let error = e.query(serde_json::from_value(query).unwrap()).unwrap_err();
    assert_eq!(error.code, ErrorCode::UnitDisplay);
    assert_eq!(error.where_.as_deref(), Some("displayUnits"));
    assert!(error.suggestion.as_deref().unwrap().contains("model.setUnits"));
    assert_eq!(e.export_file(), file);
    assert_eq!(e.model_hash(), hash);
    assert_eq!(e.revision(), revision);
    assert_eq!(e.query(Query::Results {}).unwrap(), catalogue);
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
