use super::*;
use serde_json::{json, Value};

fn partitioned_bar(cells: u32, tetrahedra: bool) -> Value {
    let mut command = imported_bar_source(cells, tetrahedra);
    let per_cell = if tetrahedra { 6 } else { 1 };
    let ids: Vec<u32> = (0..cells * per_cell).map(|i| 401 + 17 * i).collect();
    let half = ids.len() / 2;
    command["mesher"]["regions"] = json!({"left":ids[..half], "right":ids[half..]});
    command
}

#[test]
fn imported_regions_series_bar_uses_shared_nodes_and_piecewise_material_at_three_refinements() {
    // Series compliance F/A * (L1/E1 + L2/E2), independently of FE kernels.
    for tetrahedra in [false, true] {
        for cells in [2, 4, 8] {
            let mut e = engine();
            ok(&mut e, &partitioned_bar(cells, tetrahedra).to_string());
            for command in [
                r#"{"cmd":"material.add","name":"stiff","E":"200 GPa","nu":0}"#,
                r#"{"cmd":"material.add","name":"soft","E":"100 GPa","nu":0}"#,
                r#"{"cmd":"material.assign","material":"stiff","bodies":["left"]}"#,
                r#"{"cmd":"material.assign","material":"soft","bodies":["right"]}"#,
                r#"{"cmd":"constraint.fix","name":"root","on":"bar.nset_ROOT"}"#,
                r#"{"cmd":"load.traction","name":"tip","on":"bar.surface_TIP","total":["1000 N","0 N","0 N"]}"#,
                r#"{"cmd":"step.add","name":"static","procedure":"static","constraints":["root"],"loads":["tip"]}"#,
                r#"{"cmd":"solve.run","step":"static","solver":"cpu-direct"}"#,
            ] {
                ok(&mut e, command);
            }
            let built = e.mesh().unwrap().clone();
            assert_eq!(built.mesh.n_nodes(), 4 * (cells + 1) as usize);
            assert_eq!(built.source_labels.nodes.len(), built.mesh.n_nodes());
            let displacement = e.field(Some("static"), Field::Displacement).unwrap();
            for (node, p) in built.mesh.coords.chunks_exact(3).enumerate() {
                let expected = 1e5 * (p[0].min(0.5) / 2e11 + (p[0] - 0.5).max(0.0) / 1e11);
                assert!(
                    (displacement.data[node * 3] - expected).abs() < 1e-17,
                    "cells={cells}, tet={tetrahedra}, x={}: {} vs {expected}",
                    p[0],
                    displacement.data[node * 3]
                );
            }
            for stress in e.field(Some("static"), Field::Stress).unwrap().data.chunks_exact(6) {
                assert!((stress[0] - 1e5).abs() < 1e-5);
                for transverse in &stress[1..] {
                    assert!(transverse.abs() < 1e-5);
                }
            }
            let reaction = e.field(Some("static"), Field::Reaction).unwrap();
            let total: f64 = built.sets["bar.nset_ROOT"].nodes.iter().map(|&n| reaction.data[n as usize * 3]).sum();
            assert!((total + 1000.0).abs() < 1e-8);
            assert!(!e.warnings().iter().any(|w| w.code == "model.no-material"));
            let summary = serde_json::to_value(e.query(Query::Model {}).unwrap()).unwrap();
            assert_eq!(summary["bodies"].as_array().unwrap().len(), 3);
            let left = summary["bodies"].as_array().unwrap().iter().find(|b| b["name"] == "left").unwrap();
            assert_eq!(left["material"], "stiff");
            assert!((left["measure"]["value"].as_f64().unwrap() - 0.005).abs() < 1e-15);
        }
    }
}

#[test]
fn imported_regions_disconnected_components_remain_distinct_without_welding() {
    let points = [
        [0., 0., 0.],
        [1., 0., 0.],
        [0., 1., 0.],
        [0., 0., 1.],
        [3., 0., 0.],
        [4., 0., 0.],
        [3., 1., 0.],
        [3., 0., 1.],
    ];
    let nodes: Vec<_> =
        points.iter().enumerate().map(|(i, p)| json!({"label":i+1,"at":p.map(|x|format!("{x} m"))})).collect();
    let mut e = engine();
    ok(
        &mut e,
        &json!({"cmd":"mesh.set","mesher":{"kind":"imported","body":"assembly","nodes":nodes,
        "elements":[{"label":11,"kind":"tet4","nodes":[1,2,3,4]},
                    {"label":21,"kind":"tet4","nodes":[5,6,7,8]}]}})
        .to_string(),
    );
    let mesh = e.mesh().unwrap();
    assert_eq!(mesh.mesh.n_nodes(), 8);
    assert_eq!(mesh.source_labels.elements, [11, 21]);
    assert_eq!(mesh.mesh.elem_nodes(1), [4, 5, 6, 7]);
}

#[test]
fn imported_regions_lifecycle_preserves_editable_assignments_and_identity_metadata() {
    let mut e = engine();
    let mut command = partitioned_bar(2, false);
    command["mesher"]["provenance"] = json!({"sha256":"a".repeat(64),"conversionVersion":"assembly-test/1",
        "nodeIdentities":{"101":{"sourceLabel":1,"instance":"Beam-1","part":"Quoted Beam"}},
        "elementIdentities":{"401":{"sourceLabel":1,"instance":"Beam-1","part":"Quoted Beam"}}});
    ok(&mut e, &command.to_string());
    for command in [
        r#"{"cmd":"material.add","name":"default","E":"200 GPa","nu":0}"#,
        r#"{"cmd":"material.add","name":"override","E":"100 GPa","nu":0}"#,
        r#"{"cmd":"material.assign","material":"default","bodies":["bar"]}"#,
        r#"{"cmd":"material.assign","material":"override","bodies":["right"]}"#,
        r#"{"cmd":"section.add","name":"section","shape":{"kind":"shell","thickness":"1 mm"}}"#,
        r#"{"cmd":"section.assign","section":"section","bodies":["left"],"orientation":"x"}"#,
        r#"{"cmd":"model.rename","kind":"body","name":"left","to":"first"}"#,
        r#"{"cmd":"model.rename","kind":"material","name":"override","to":"second_material"}"#,
        r#"{"cmd":"model.rename","kind":"section","name":"section","to":"renamed_section"}"#,
    ] {
        ok(&mut e, command);
    }
    let objects =
        serde_json::to_value(e.query(Query::Objects { kinds: Some(vec![ObjectKind::Body]) }).unwrap()).unwrap();
    for name in ["bar", "first", "right"] {
        let object = objects["objects"].as_array().unwrap().iter().find(|o| o["name"] == name).unwrap();
        assert_eq!(object["ref"], format!("body:{name}"));
        assert_eq!(object["kind"], "body");
    }
    assert_eq!(
        objects["objects"].as_array().unwrap().iter().find(|o| o["name"] == "first").unwrap()["summary"],
        "imported element region"
    );
    let model = e.export_file().model;
    assert_eq!(model.material_of_body("first"), Some("default"));
    assert_eq!(model.material_of_body("right"), Some("second_material"));
    assert_eq!(model.section_of_body("first").unwrap().name, "renamed_section");
    assert!(model.names(ObjectKind::Body).contains(&"first"));
    assert!(!model.names(ObjectKind::Body).contains(&"left"));
    let before = e.export_file();
    for command in [
        r#"{"cmd":"material.remove","name":"second_material"}"#,
        r#"{"cmd":"section.remove","name":"renamed_section"}"#,
        r#"{"cmd":"geometry.remove","name":"first"}"#,
        r#"{"cmd":"model.duplicate","kind":"body","name":"first","as":"copy"}"#,
    ] {
        assert!(run(&mut e, command).is_err());
        assert_eq!(e.export_file(), before);
    }
    let definition = e.query(Query::Definition { kind: ObjectKind::Body, name: "first".into() }).unwrap();
    let definition = serde_json::to_value(definition).unwrap();
    assert_eq!(definition["command"]["mesher"]["regions"]["first"], json!([401]));
    let mut opened = engine();
    opened.import_file(before.clone()).unwrap();
    assert_eq!(opened.export_file(), before);
    assert_eq!(opened.mesh().unwrap(), e.mesh().unwrap());
    let mut replayed = engine();
    pollster::block_on(replayed.replay(&before.journal.entries, false, true)).unwrap();
    assert_eq!(replayed.export_file().model, before.model);
    ok(&mut e, r#"{"cmd":"geometry.nameRegion","name":"first_elements","where":{"kind":"body","name":"first"}}"#);
    let protected = e.export_file();
    assert_eq!(err(&mut e, r#"{"cmd":"geometry.remove","name":"first"}"#).code, ErrorCode::InUse);
    assert_eq!(err(&mut e, r#"{"cmd":"geometry.remove","name":"bar"}"#).code, ErrorCode::InUse);
    let mut replacement = command;
    replacement["mesher"]["regions"] = json!({"right":[418]});
    assert!(run(&mut e, &replacement.to_string()).is_err());
    assert_eq!(e.export_file(), protected);
}

#[test]
fn imported_regions_invalid_memberships_and_provenance_fail_atomically() {
    let mut e = engine();
    let original = partitioned_bar(2, false);
    ok(&mut e, &original.to_string());
    let before = e.export_file();
    for regions in [
        json!({"left":[]}),
        json!({"bar":[401]}),
        json!({"bad.name":[401]}),
        json!({"left":[999]}),
        json!({"left":[401],"right":[401]}),
    ] {
        let mut command = original.clone();
        command["mesher"]["regions"] = regions;
        assert!(run(&mut e, &command.to_string()).is_err());
        assert_eq!(e.export_file(), before);
    }
    for identity in [
        json!({"101":{"sourceLabel":0}}),
        json!({"9999":{"sourceLabel":1}}),
        json!({"101":{"sourceLabel":1,"instance":" "}}),
        json!({"101":{"sourceLabel":1,"part":"x".repeat(257)}}),
    ] {
        let mut command = original.clone();
        command["mesher"]["provenance"] =
            json!({"sha256":"a".repeat(64),"conversionVersion":"test", "nodeIdentities":identity});
        assert!(run(&mut e, &command.to_string()).is_err());
        assert_eq!(e.export_file(), before);
    }
}

#[test]
fn imported_regions_quoted_names_and_root_rename_keep_exact_references() {
    let mut e = engine();
    let mut command = partitioned_bar(2, false);
    let quoted = "\"Instance.One\".\"Root Set\"";
    command["mesher"]["nodeSets"][quoted] = command["mesher"]["nodeSets"]["ROOT"].clone();
    command["mesher"]["provenance"] = json!({"sha256":"b".repeat(64),"conversionVersion":"bundle/1",
        "sourceName":"Model.inp", "sourceFiles":{"Model.inp":"b".repeat(64), "parts/Beam.inp":"c".repeat(64)}});
    ok(&mut e, &command.to_string());
    ok(&mut e, &json!({"cmd":"constraint.fix","name":"held","on":format!("bar.nset_{quoted}")}).to_string());
    let saved = e.export_file();
    assert_eq!(err(&mut e, r#"{"cmd":"geometry.remove","name":"bar"}"#).code, ErrorCode::InUse);
    assert_eq!(e.export_file(), saved);
    ok(&mut e, r#"{"cmd":"model.rename","kind":"body","name":"bar","to":"renamed"}"#);
    assert_eq!(e.export_file().model.constraints[0].on, format!("renamed.nset_{quoted}"));
    assert_eq!(set_info(&mut e, &format!("renamed.nset_{quoted}")).count, 4);
    assert!(!e.export_file().model.knows_set("left.xmin"));
    let renamed = e.export_file();
    ok(&mut e, r#"{"cmd":"journal.undo"}"#);
    assert_eq!(e.export_file().model, saved.model);
    ok(&mut e, r#"{"cmd":"journal.redo"}"#);
    assert_eq!(e.export_file().model, renamed.model);
    ok(&mut e, r#"{"cmd":"geometry.nameRegion","name":"whole","where":{"kind":"body","name":"renamed"}}"#);
    assert_eq!(set_info(&mut e, "whole").count, 2);
    ok(
        &mut e,
        r#"{"cmd":"geometry.nameFace","name":"interface","of":"left","where":{"kind":"normal","normal":[1,0,0]}}"#,
    );
    assert_eq!(set_info(&mut e, "interface").count, 1);
    assert_eq!(e.mesh().unwrap().sets["interface"].nodes.len(), 4);
    let mut opened = engine();
    opened.import_file(e.export_file()).unwrap();
    assert_eq!(opened.export_file().model, e.export_file().model);
}

#[test]
fn imported_regions_source_manifest_and_identity_key_validation_are_bounded() {
    let mut e = engine();
    let original = partitioned_bar(2, false);
    ok(&mut e, &original.to_string());
    let before = e.export_file();
    let too_many: serde_json::Map<String, Value> =
        (0..129).map(|i| (format!("part-{i}.inp"), json!("a".repeat(64)))).collect();
    for files in [
        json!({"../part.inp":"a".repeat(64)}),
        json!({"/part.inp":"a".repeat(64)}),
        json!({"a\\part.inp":"a".repeat(64)}),
        json!({"a/./part.inp":"a".repeat(64)}),
        json!({"part.inp":"A".repeat(64)}),
        json!({"part.inp":"bad"}),
        Value::Object(too_many),
    ] {
        let mut command = original.clone();
        command["mesher"]["provenance"] =
            json!({"sha256":"a".repeat(64),"conversionVersion":"test","sourceFiles":files});
        assert!(run(&mut e, &command.to_string()).is_err());
        assert_eq!(e.export_file(), before);
    }
    for identities in [json!(42), json!({"x":{"sourceLabel":1}}), json!({"0101":{"sourceLabel":1}})] {
        let mut command = original.clone();
        command["mesher"]["provenance"] =
            json!({"sha256":"a".repeat(64),"conversionVersion":"test","nodeIdentities":identities});
        assert!(run(&mut e, &command.to_string()).is_err());
        assert_eq!(e.export_file(), before);
    }
    let mut command = original;
    command["mesher"]["provenance"] =
        json!({"sha256":"a".repeat(64),"conversionVersion":"test","sourceName":"../root.inp"});
    assert!(run(&mut e, &command.to_string()).is_err());
    assert_eq!(e.export_file(), before);
}

#[test]
fn imported_regions_aggregate_support_warnings_accept_quoted_sets_and_region_selectors() {
    for target in ["quoted", "region", "face"] {
        let mut e = engine();
        let mut command = partitioned_bar(2, false);
        let quoted = "\"Part.Instance\".\"Root Set\"";
        command["mesher"]["nodeSets"][quoted] = command["mesher"]["nodeSets"]["ROOT"].clone();
        ok(&mut e, &command.to_string());
        for command in [
            r#"{"cmd":"material.add","name":"stiff","E":"200 GPa","nu":0}"#,
            r#"{"cmd":"material.add","name":"soft","E":"100 GPa","nu":0}"#,
            r#"{"cmd":"material.assign","material":"stiff","bodies":["left"]}"#,
            r#"{"cmd":"material.assign","material":"soft","bodies":["right"]}"#,
        ] {
            ok(&mut e, command);
        }
        let on = if target == "quoted" {
            format!("bar.nset_{quoted}")
        } else {
            let selector = if target == "region" {
                json!({"cmd":"geometry.nameRegion","name":"selected","where":{"kind":"body","name":"left"}})
            } else {
                json!({"cmd":"geometry.nameFace","name":"selected","of":"left","where":{"kind":"normal","normal":[-1,0,0]}})
            };
            ok(&mut e, &selector.to_string());
            "selected".into()
        };
        ok(&mut e, &json!({"cmd":"constraint.fix","name":"held","on":on}).to_string());
        assert!(!e.warnings().iter().any(|w| w.code == "model.unconstrained"), "pre-step {target}: {:?}", e.warnings());
        ok(&mut e, r#"{"cmd":"load.traction","name":"pull","on":"bar.surface_TIP","total":["1000 N","0 N","0 N"]}"#);
        ok(
            &mut e,
            r#"{"cmd":"step.add","name":"static","procedure":"static","constraints":["held"],"loads":["pull"]}"#,
        );
        assert!(!e.warnings().iter().any(|w| w.code == "model.unconstrained"), "step {target}: {:?}", e.warnings());
        ok(&mut e, r#"{"cmd":"solve.run","step":"static","solver":"cpu-direct"}"#);
        let tip = e.mesh().unwrap().sets["bar.nset_TIP"].nodes.clone();
        let displacement = e.field(Some("static"), Field::Displacement).unwrap();
        let expected = if target == "region" { 5e-7 } else { 7.5e-7 };
        for node in tip {
            assert!((displacement.data[node as usize * 3] - expected).abs() < 1e-17, "{target}");
        }
    }
}

#[test]
fn imported_regions_replacement_keeps_retained_region_assignments_when_root_owner_changes() {
    let mut e = engine();
    let original = partitioned_bar(2, false);
    ok(&mut e, &original.to_string());
    for command in [
        r#"{"cmd":"material.add","name":"stiff","E":"200 GPa","nu":0}"#,
        r#"{"cmd":"material.add","name":"soft","E":"100 GPa","nu":0}"#,
        r#"{"cmd":"material.assign","material":"stiff","bodies":["bar","left"]}"#,
        r#"{"cmd":"material.assign","material":"soft","bodies":["right"]}"#,
    ] {
        ok(&mut e, command);
    }
    let before = e.export_file();
    let mut replacement = original;
    replacement["mesher"]["body"] = json!("new_source");
    ok(&mut e, &replacement.to_string());
    let after = e.export_file();
    assert_eq!(after.model.implicit_body(), Some("new_source"));
    assert_eq!(after.model.mesher_material, None, "the removed root identity loses its default");
    assert_eq!(after.model.imported_region_assignments, before.model.imported_region_assignments);
    assert_eq!(after.model.material_of_body("left"), Some("stiff"));
    assert_eq!(after.model.material_of_body("right"), Some("soft"));
    assert!(!e.warnings().iter().any(|w| w.code == "model.no-material"));
    ok(&mut e, r#"{"cmd":"journal.undo"}"#);
    assert_eq!(e.export_file().model, before.model);
    ok(&mut e, r#"{"cmd":"journal.redo"}"#);
    assert_eq!(e.export_file().model, after.model);
    let mut replayed = engine();
    pollster::block_on(replayed.replay(&after.journal.entries, false, true)).unwrap();
    assert_eq!(replayed.export_file().model, after.model);
}

#[test]
fn imported_regions_gravity_density_warnings_follow_effective_region_materials() {
    let mut e = engine();
    ok(&mut e, &partitioned_bar(2, false).to_string());
    for command in [
        r#"{"cmd":"material.add","name":"dense","E":"200 GPa","nu":0,"rho":"1000 kg/m^3"}"#,
        r#"{"cmd":"material.add","name":"missing","E":"100 GPa","nu":0}"#,
        r#"{"cmd":"material.assign","material":"dense","bodies":["left"]}"#,
        r#"{"cmd":"material.assign","material":"missing","bodies":["right"]}"#,
        r#"{"cmd":"load.gravity","name":"gravity","g":["0 m/s^2","0 m/s^2","-9.81 m/s^2"]}"#,
    ] {
        ok(&mut e, command);
    }
    let warnings = e.warnings();
    let missing: Vec<_> = warnings.iter().filter(|w| w.code == "load.no-density").collect();
    assert_eq!(missing.len(), 1);
    assert!(missing[0].text.contains("'right'"));
    ok(&mut e, r#"{"cmd":"material.assign","material":"dense","bodies":["right"]}"#);
    assert!(!e.warnings().iter().any(|w| w.code == "load.no-density"));
}

#[test]
fn imported_regions_names_cannot_replace_other_geometry_owners_in_either_order() {
    let source = partitioned_bar(2, false).to_string();
    let point = r#"{"cmd":"geometry.addMass","name":"left","at":["2 m","0 m","0 m"],"mass":"1 kg"}"#;
    for first_point in [false, true] {
        let mut e = engine();
        let (first, second) = if first_point { (point, source.as_str()) } else { (source.as_str(), point) };
        ok(&mut e, first);
        let before = e.export_file();
        assert_eq!(err(&mut e, second).code, ErrorCode::NameTaken);
        assert_eq!(e.export_file(), before);
    }
}

fn separated_region_tetrahedra(tiny_volume: bool) -> Value {
    // The other component supplies the aggregate x=0 lower bound and a regular
    // nonzero volume; it is separated in z, so no approximate contact is involved.
    let small = if tiny_volume {
        [[0., 0., 0.], [1e-20, 0., 0.], [0., 1e-20, 0.], [0., 0., 1e-20]]
    } else {
        [[1e-230, 0., 0.], [1., 0., 0.], [1e-230, 1., 0.], [1e-230, 0., 1.]]
    };
    let other = [[0., 0., 3.], [1., 0., 3.], [0., 1., 3.], [0., 0., 4.]];
    let nodes: Vec<_> = small
        .into_iter()
        .chain(other)
        .enumerate()
        .map(|(i, p)| json!({"label":i+1,"at":p.map(|v|format!("{v} m"))}))
        .collect();
    json!({"cmd":"mesh.set","mesher":{"kind":"imported","body":"source","nodes":nodes,
        "elements":[{"label":11,"kind":"tet4","nodes":[1,2,3,4]},{"label":21,"kind":"tet4","nodes":[5,6,7,8]}],
        "regions":{"near":[11],"other":[21]}}})
}

#[test]
fn imported_regions_unrepresentable_region_bounds_and_measures_are_structured_read_errors() {
    // A 10^99 m display length is finite and its cubic factor 10^297 is finite.
    // Aggregate bounds and volume still fit. A region's internal 10^-230 m bound
    // or 10^-60 m^3 volume cannot be represented in those requested units.
    for tiny_volume in [false, true] {
        let mut e = engine();
        ok(&mut e, &separated_region_tetrahedra(tiny_volume).to_string());
        let summary = serde_json::to_value(e.query(Query::Model {}).unwrap()).unwrap();
        assert!(summary["bodies"][0]["measure"]["value"].as_f64().unwrap() > 0.1);
        ok(&mut e, r#"{"cmd":"model.setUnits","units":{"length":"m*km^33/m^33"}}"#);
        let before = e.export_file();
        let hash = e.model_hash();
        let error = e.query(Query::Model {}).unwrap_err();
        assert_eq!(error.code, ErrorCode::UnitDisplay);
        assert!(error.cause.contains("underflows to zero"), "{error:?}");
        let dimension = if tiny_volume { "volume" } else { "length" };
        assert!(error.cause.contains(dimension), "{error:?}");
        assert_eq!(e.export_file(), before);
        assert_eq!(e.model_hash(), hash);
        ok(&mut e, r#"{"cmd":"model.setUnits","units":{"length":"m"}}"#);
        assert!(e.query(Query::Model {}).is_ok());
    }
}

#[test]
fn imported_regions_source_temperature_expands_all_material_regions_at_three_refinements() {
    // Free isotropic expansion u=alpha*DeltaT*x is independent of both elastic
    // moduli; the three symmetry planes remove rigid motion without restraining it.
    for cells in [2, 4, 8] {
        let mut e = engine();
        let mut source = partitioned_bar(cells, false);
        let node = |x: u32, y: u32, z: u32| 101 + 13 * (4 * x + 2 * z + y);
        source["mesher"]["nodeSets"]["Y0"] =
            json!((0..=cells).flat_map(|x| (0..=1).map(move |z| node(x, 0, z))).collect::<Vec<_>>());
        source["mesher"]["nodeSets"]["Z0"] =
            json!((0..=cells).flat_map(|x| (0..=1).map(move |y| node(x, y, 0))).collect::<Vec<_>>());
        ok(&mut e, &source.to_string());
        for command in [
            r#"{"cmd":"material.add","name":"stiff","E":"200 GPa","nu":0,"alpha":"1e-5 1/K"}"#,
            r#"{"cmd":"material.add","name":"soft","E":"100 GPa","nu":0,"alpha":"1e-5 1/K"}"#,
            r#"{"cmd":"material.assign","material":"stiff","bodies":["left"]}"#,
            r#"{"cmd":"material.assign","material":"soft","bodies":["right"]}"#,
            r#"{"cmd":"constraint.fix","name":"x0","on":"bar.nset_ROOT","dofs":["ux"]}"#,
            r#"{"cmd":"constraint.fix","name":"y0","on":"bar.nset_Y0","dofs":["uy"]}"#,
            r#"{"cmd":"constraint.fix","name":"z0","on":"bar.nset_Z0","dofs":["uz"]}"#,
            r#"{"cmd":"load.temperature","name":"warm","bodies":["bar"],"value":"303.15 K","reference":"293.15 K"}"#,
            r#"{"cmd":"step.add","name":"thermal","procedure":"static","constraints":["x0","y0","z0"],"loads":["warm"]}"#,
            r#"{"cmd":"solve.run","step":"thermal","solver":"cpu-direct"}"#,
        ] {
            ok(&mut e, command);
        }
        let coordinates = e.mesh().unwrap().mesh.coords.clone();
        let displacement = e.field(Some("thermal"), Field::Displacement).unwrap();
        for (actual, coordinate) in displacement.data.iter().zip(coordinates) {
            assert!((actual - 1e-4 * coordinate).abs() < 1e-12, "cells={cells}: {actual} at {coordinate}");
        }
        for value in &e.field(Some("thermal"), Field::Stress).unwrap().data {
            assert!(value.abs() < 1e-3, "cells={cells}: stress {value}");
        }
    }
}
