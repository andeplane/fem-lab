//! Independent text decks checked against closed-form elasticity, conservation and replay.
//! Included by the single registry integration binary; no writer or engine mesher builds them.

use super::{cantilever, engine, ok, run};
use femlab_engine::command::Field;
use femlab_engine::hash::sha256_hex;
use femlab_engine::query::{AbaqusConversion, Query};
use femlab_engine::{Engine, Error, ErrorCode, NoClock};
use proptest::prelude::*;
use serde_json::json;

const HEX: &str = include_str!("../fixtures/abaqus-static/bar-hex-mm-n.inp");

fn request(text: &str, length: &str, force: &str) -> Query {
    serde_json::from_value(json!({
        "query":"query.convertAbaqus", "mode":"static", "text":text,
        "name":"Independent imported bar", "body":"bar", "unitLength":length, "unitForce":force,
        "sha256":sha256_hex(text.as_bytes()),
    }))
    .unwrap()
}

fn convert(e: &mut Engine, text: &str, length: &str, force: &str) -> Result<AbaqusConversion, Error> {
    let output = e.query(request(text, length, force))?;
    Ok(serde_json::from_value(serde_json::to_value(output).unwrap()).unwrap())
}

fn install(e: &mut Engine, conversion: &AbaqusConversion) {
    for command in &conversion.commands {
        run(e, &serde_json::to_string(command).unwrap()).unwrap();
    }
}

fn node(x: u32, y: u32, z: u32) -> u32 {
    101 + 13 * (4 * x + 2 * z + y)
}

/// An authored Cartesian grid. The constant six-tet pattern has positive determinants and
/// a common 000→111 diagonal. No geometry builder, exported mesh or imported reader is used.
fn mesh_text(cells: u32, tetrahedra: bool, mm: bool) -> String {
    let unit = if mm { 1000.0 } else { 1.0 };
    let mut text = String::from("** Independent analytical bar topology\n*NODE\n");
    for x in 0..=cells {
        for z in 0..=1 {
            for y in 0..=1 {
                text.push_str(&format!(
                    "{},{},{},{}\n",
                    node(x, y, z),
                    f64::from(x) / f64::from(cells) * unit,
                    f64::from(y) * 0.1 * unit,
                    f64::from(z) * 0.1 * unit
                ));
            }
        }
    }
    text.push_str(if tetrahedra { "*ELEMENT,TYPE=C3D4,ELSET=SOLID\n" } else { "*ELEMENT,TYPE=C3D8,ELSET=SOLID\n" });
    for x in 0..cells {
        let corners = [
            node(x, 0, 0),
            node(x + 1, 0, 0),
            node(x + 1, 1, 0),
            node(x, 1, 0),
            node(x, 0, 1),
            node(x + 1, 0, 1),
            node(x + 1, 1, 1),
            node(x, 1, 1),
        ];
        let connectivity = if tetrahedra {
            vec![
                vec![0, 1, 2, 6],
                vec![0, 2, 3, 6],
                vec![0, 3, 7, 6],
                vec![0, 7, 4, 6],
                vec![0, 4, 5, 6],
                vec![0, 5, 1, 6],
            ]
        } else {
            vec![vec![0, 1, 2, 3, 4, 5, 6, 7]]
        };
        for (index, local) in connectivity.iter().enumerate() {
            let label = 401 + 17 * (x * connectivity.len() as u32 + index as u32);
            text.push_str(&label.to_string());
            for &corner in local {
                text.push_str(&format!(",{}", corners[corner]));
            }
            text.push('\n');
        }
    }
    for (set, x) in [("ROOT", 0), ("TIP", cells)] {
        text.push_str(&format!(
            "*NSET,NSET={set}\n{},{},{},{}\n",
            node(x, 0, 0),
            node(x, 1, 0),
            node(x, 0, 1),
            node(x, 1, 1)
        ));
    }
    text.push_str(&format!(
        "*NSET,NSET=TIP_DIAG\n{},{}\n*NSET,NSET=TIP_OFF\n{},{}\n",
        node(cells, 0, 0),
        node(cells, 1, 1),
        node(cells, 1, 0),
        node(cells, 0, 1)
    ));
    text
}

fn material_text(mm: bool, nu: f64) -> String {
    let young = if mm { 200000.0 } else { 200e9 };
    format!("*MATERIAL,NAME=STEEL\n*ELASTIC\n{young},{nu}\n*SOLID SECTION,ELSET=SOLID,MATERIAL=STEEL\n")
}

fn bar(cells: u32, tetrahedra: bool, mm: bool) -> String {
    let mut text = mesh_text(cells, tetrahedra, mm);
    text.push_str(&material_text(mm, 0.0));
    text.push_str("*BOUNDARY\nROOT,1,3\n*STEP,NAME=AXIAL,NLGEOM=NO\n*STATIC\n*CLOAD\n");
    // Integrating each linear triangle shape function gives area/3. The shared end
    // diagonal belongs to two half-area triangles, unlike the two off-diagonal corners.
    if tetrahedra {
        text.push_str(&format!("TIP_DIAG,1,{}\nTIP_OFF,1,{}\n", 1000.0 / 3.0, 1000.0 / 6.0));
    } else {
        text.push_str("TIP,1,250\n");
    }
    text.push_str("*END STEP\n");
    text
}

#[test]
fn abaqus_static_authored_si_and_mm_fixtures_solve_the_same_physical_bar() {
    for (text, length) in [
        (HEX, "1 mm"),
        (include_str!("../fixtures/abaqus-static/bar-hex-si.inp"), "1 m"),
        (include_str!("../fixtures/abaqus-static/bar-tet-mm-n.inp"), "1 mm"),
        (include_str!("../fixtures/abaqus-static/bar-tet-si.inp"), "1 m"),
    ] {
        let mut e = engine();
        let conversion = convert(&mut e, text, length, "1 N").unwrap();
        install(&mut e, &conversion);
        ok(&mut e, r#"{"cmd":"solve.run","step":"AXIAL","solver":"cpu-direct"}"#);
        let mesh = e.mesh().unwrap().clone();
        for &id in &mesh.sets["bar.nset_TIP"].nodes {
            assert!((e.field(Some("AXIAL"), Field::Displacement).unwrap().data[id as usize * 3] - 5e-7).abs() < 1e-16);
        }
        for stress in e.field(Some("AXIAL"), Field::Stress).unwrap().data.chunks_exact(6) {
            assert!((stress[0] - 1e5).abs() < 1e-6);
        }
        let reaction: f64 = e.field(Some("AXIAL"), Field::Reaction).unwrap().data.chunks_exact(3).map(|r| r[0]).sum();
        assert!((reaction + 1000.0).abs() < 1e-8);
    }
}

#[test]
fn abaqus_static_defaults_direct_targets_and_nonunit_force_scale_preserve_physics() {
    for increments in ["", ",,,", "0", "0,0,0", "1,0,0", "0,1,1e-5"] {
        let text = HEX
            .replace("ROOT,1,3", "ROOT,1\nROOT,2,,0\nROOT,3,3,0")
            .replace("*STEP,NAME=AXIAL,NLGEOM=NO", "*step,NLGEOM=no")
            .replace("1,1,1e-5", increments)
            .replace("TIP,1,250", "+205,1,250\n218,1,250\n231,1,250\n244,1,250");
        let mut e = engine();
        let conversion = convert(&mut e, &text, "1 mm", "2 N").unwrap();
        assert_eq!(conversion.report.analysis.as_ref().unwrap().step, "STATIC");
        let source = serde_json::to_value(&conversion.commands[2]).unwrap();
        assert_eq!(source["mesher"]["nodeTargets"], json!([205, 218, 231, 244]));
        let material = serde_json::to_value(&conversion.commands[3]).unwrap();
        assert_eq!(material["E"]["value"], 400e9);
        install(&mut e, &conversion);
        ok(&mut e, r#"{"cmd":"solve.run","step":"STATIC","solver":"cpu-direct"}"#);
        let mesh = e.mesh().unwrap().clone();
        for &id in &mesh.sets["bar.nset_TIP"].nodes {
            assert!((e.field(Some("STATIC"), Field::Displacement).unwrap().data[id as usize * 3] - 5e-7).abs() < 1e-16);
        }
        for stress in e.field(Some("STATIC"), Field::Stress).unwrap().data.chunks_exact(6) {
            assert!((stress[0] - 2e5).abs() < 1e-6);
        }
        let reaction: f64 = e.field(Some("STATIC"), Field::Reaction).unwrap().data.chunks_exact(3).map(|r| r[0]).sum();
        assert!((reaction + 2000.0).abs() < 1e-8);
    }
}

#[test]
fn abaqus_static_semantic_zero_is_portable_through_browser_json_and_native_replay() {
    let text = HEX
        .replace("200000,0\n", "200000,-0\n")
        .replace("101,0,0,0", "101,-0,-0,-0")
        .replace("ROOT,1,3\n", "ROOT,1,3,-0\n")
        .replace("TIP,1,250", "TIP,1,250\nTIP,2,-0\nTIP,3,-0");
    let mut e = engine();
    let conversion = convert(&mut e, &text, "1 mm", "1 N").unwrap();
    assert_eq!(conversion.report.sha256, sha256_hex(text.as_bytes()));
    let wire = serde_json::to_string(&conversion.commands).unwrap();
    assert!(!wire.contains("-0.0"));
    assert_eq!(
        serde_json::to_value(&conversion.commands[2]).unwrap()["mesher"]["provenance"]["sha256"],
        conversion.report.sha256
    );
    let mut browser = engine();
    install(&mut e, &conversion);
    for command in serde_json::from_str::<Vec<femlab_engine::Command>>(&wire).unwrap() {
        run(&mut browser, &serde_json::to_string(&command).unwrap()).unwrap();
    }
    assert_eq!(browser.export_file(), e.export_file());
    assert_eq!(browser.model_hash(), e.model_hash());
}

#[test]
fn abaqus_static_axial_bars_match_independent_si_oracles_at_three_refinements() {
    for tetrahedra in [false, true] {
        for mm in [false, true] {
            for cells in [2, 4, 8] {
                let text = bar(cells, tetrahedra, mm);
                let mut e = engine();
                let before = e.export_file();
                let conversion = convert(&mut e, &text, if mm { "1 mm" } else { "1 m" }, "1 N").unwrap();
                assert_eq!(e.export_file(), before);
                assert!(conversion.report.analysis_configured);
                assert_eq!(conversion.report.unit_force.as_ref().unwrap().si().unwrap(), 1.0);
                assert_eq!(conversion.report.analysis.as_ref().unwrap().material, "STEEL");
                assert_eq!(conversion.report.analysis.as_ref().unwrap().step, "AXIAL");
                assert!(conversion.report.analysis.as_ref().unwrap().final_equilibrium_only);
                let commands = serde_json::to_value(&conversion.commands).unwrap();
                assert_eq!(commands[2]["formulation"], if tetrahedra { "full" } else { "mean-dilatation" });
                assert_eq!(commands[2]["order"], 1);
                assert!(commands.as_array().unwrap().iter().all(|command| command["cmd"] != "solve.run"));
                assert_eq!(commands[2]["mesher"]["provenance"]["conversionVersion"], "abaqus-static/3");
                assert!(commands[2]["mesher"].get("nodeTargets").is_none());
                install(&mut e, &conversion);
                let results = serde_json::to_value(e.query(Query::Results {}).unwrap()).unwrap();
                assert_eq!(results["records"].as_array().unwrap().len(), 0);
                ok(&mut e, r#"{"cmd":"solve.run","step":"AXIAL","solver":"cpu-direct"}"#);
                let mesh = e.mesh().unwrap().clone();
                let displacement = e.field(Some("AXIAL"), Field::Displacement).unwrap();
                for &node in &mesh.sets["bar.nset_TIP"].nodes {
                    assert!(
                        (displacement.data[node as usize * 3] - 5e-7).abs() < 1e-16,
                        "tet={tetrahedra},mm={mm},cells={cells}"
                    );
                }
                for stress in e.field(Some("AXIAL"), Field::Stress).unwrap().data.chunks_exact(6) {
                    assert!((stress[0] - 1e5).abs() < 1e-6);
                    assert!(stress[1..].iter().all(|value| value.abs() < 1e-6));
                }
                let reactions = &e.field(Some("AXIAL"), Field::Reaction).unwrap().data;
                let axial: f64 = mesh.sets["bar.nset_ROOT"].nodes.iter().map(|&id| reactions[id as usize * 3]).sum();
                assert!((axial + 1000.0).abs() < 1e-8);
            }
        }
    }
}

#[test]
fn abaqus_static_affine_prescribed_patch_matches_hooke_stress_and_reaction_conservation() {
    let strain = [1e-4, 2e-4, -1e-4, 0.5e-4, 0.7e-4, -0.3e-4];
    let young = 200e9;
    let poisson = 0.25;
    let mu = young / (2.0 * (1.0 + poisson));
    let lambda = young * poisson / ((1.0 + poisson) * (1.0 - 2.0 * poisson));
    let trace = strain[0] + strain[1] + strain[2];
    let exact = [
        lambda * trace + 2.0 * mu * strain[0],
        lambda * trace + 2.0 * mu * strain[1],
        lambda * trace + 2.0 * mu * strain[2],
        mu * strain[3],
        mu * strain[4],
        mu * strain[5],
    ];
    for tetrahedra in [false, true] {
        for mm in [false, true] {
            for cells in [2, 4, 8] {
                let mut text = mesh_text(cells, tetrahedra, mm);
                text.push_str(&material_text(mm, poisson));
                text.push_str("*STEP,NAME=PATCH\n*STATIC\n*BOUNDARY,TYPE=DISPLACEMENT\n");
                let scale = if mm { 1000.0 } else { 1.0 };
                for x in 0..=cells {
                    for z in 0..=1 {
                        for y in 0..=1 {
                            let p = [f64::from(x) / f64::from(cells), f64::from(y) * 0.1, f64::from(z) * 0.1];
                            let u = [
                                strain[0] * p[0] + 0.5 * strain[3] * p[1] + 0.5 * strain[4] * p[2],
                                0.5 * strain[3] * p[0] + strain[1] * p[1] + 0.5 * strain[5] * p[2],
                                0.5 * strain[4] * p[0] + 0.5 * strain[5] * p[1] + strain[2] * p[2],
                            ];
                            for (axis, value) in u.into_iter().enumerate() {
                                text.push_str(&format!("{},{},,{}\n", node(x, y, z), axis + 1, value * scale));
                            }
                        }
                    }
                }
                text.push_str("*END STEP\n");
                let mut e = engine();
                let conversion = convert(&mut e, &text, if mm { "1 mm" } else { "1 m" }, "1 N").unwrap();
                install(&mut e, &conversion);
                ok(&mut e, r#"{"cmd":"solve.run","step":"PATCH","solver":"cpu-direct"}"#);
                for stress in e.field(Some("PATCH"), Field::Stress).unwrap().data.chunks_exact(6) {
                    for axis in 0..6 {
                        assert!(
                            (stress[axis] - exact[axis]).abs() < 1e-5,
                            "tet={tetrahedra},mm={mm},cells={cells},axis={axis}"
                        );
                    }
                }
                for axis in 0..3 {
                    let total: f64 = e
                        .field(Some("PATCH"), Field::Reaction)
                        .unwrap()
                        .data
                        .chunks_exact(3)
                        .map(|reaction| reaction[axis])
                        .sum();
                    assert!(total.abs() < 1e-5);
                }
            }
        }
    }
}

#[test]
fn abaqus_static_set_loads_are_per_node_and_numeric_targets_are_reported_singletons() {
    let text = HEX.replace("TIP,1,250", "TIP,1,3\nTIP,2,-5\nTIP,3,7\n101,1,10");
    let mut e = engine();
    let conversion = convert(&mut e, &text, "1 mm", "1 N").unwrap();
    let source = serde_json::to_value(&conversion.commands[2]).unwrap();
    assert_eq!(source["mesher"]["nodeTargets"], json!([101]));
    let mapping = conversion.report.sets.iter().find(|mapping| mapping.source == "101").unwrap();
    assert_eq!(mapping.target, "bar.node_101");
    assert_eq!(mapping.count, 1);
    let loads: Vec<_> = conversion
        .commands
        .iter()
        .filter(|command| command.name() == "load.force")
        .map(|command| serde_json::to_value(command).unwrap())
        .collect();
    assert_eq!(loads.len(), 4);
    let mut totals = [0.0; 3];
    for load in &loads {
        for axis in 0..3 {
            totals[axis] += load["total"][axis]["value"].as_f64().unwrap();
        }
    }
    assert_eq!(totals, [22.0, -20.0, 28.0]);
    install(&mut e, &conversion);
    ok(&mut e, r#"{"cmd":"solve.run","step":"AXIAL","solver":"cpu-direct"}"#);
    for axis in 0..3 {
        let reaction: f64 =
            e.field(Some("AXIAL"), Field::Reaction).unwrap().data.chunks_exact(3).map(|r| r[axis]).sum();
        assert!((reaction + totals[axis]).abs() < 1e-9);
    }
}

#[test]
fn abaqus_static_nonzero_step_displacements_and_equal_boundary_overlap_are_preserved() {
    let text = HEX.replace("*CLOAD\nTIP,1,250", "*BOUNDARY\nTIP,1,,0.001\nROOT,1,3\n101,1,1,0");
    let mut e = engine();
    let conversion = convert(&mut e, &text, "1 mm", "1 N").unwrap();
    // Equal overlapping source targets resolve to one prescribed value per labelled DOF;
    // three ROOT axes and the nonzero TIP axis form four effective constraints.
    assert_eq!(conversion.report.analysis.as_ref().unwrap().constraints.len(), 4);
    assert!(conversion.report.analysis.as_ref().unwrap().loads.is_empty());
    install(&mut e, &conversion);
    ok(&mut e, r#"{"cmd":"solve.run","step":"AXIAL","solver":"cpu-direct"}"#);
    let mesh = e.mesh().unwrap().clone();
    for &id in &mesh.sets["bar.nset_TIP"].nodes {
        assert!((e.field(Some("AXIAL"), Field::Displacement).unwrap().data[id as usize * 3] - 1e-6).abs() < 1e-17);
    }
    for stress in e.field(Some("AXIAL"), Field::Stress).unwrap().data.chunks_exact(6) {
        assert!((stress[0] - 2e5).abs() < 1e-6);
    }
    let reactions = &e.field(Some("AXIAL"), Field::Reaction).unwrap().data;
    let root: f64 = mesh.sets["bar.nset_ROOT"].nodes.iter().map(|&id| reactions[id as usize * 3]).sum();
    assert!((root + 2000.0).abs() < 1e-8);
    for axis in 0..3 {
        assert!(reactions.chunks_exact(3).map(|r| r[axis]).sum::<f64>().abs() < 1e-8);
    }
}

#[test]
fn abaqus_static_conversion_is_read_only_and_replay_needs_no_original_deck() {
    let mut e = engine();
    cantilever(&mut e);
    ok(&mut e, r#"{"cmd":"solve.run","step":"static","solver":"cpu-direct"}"#);
    let before = e.export_file();
    let field = e.field(Some("static"), Field::Displacement).unwrap().clone();
    let conversion = convert(&mut e, HEX, "1 mm", "1 N").unwrap();
    assert_eq!(e.export_file(), before);
    assert_eq!(e.field(Some("static"), Field::Displacement).unwrap(), &field);
    let mut imported = engine();
    install(&mut imported, &conversion);
    ok(&mut imported, r#"{"cmd":"solve.run","step":"AXIAL","solver":"cpu-direct"}"#);
    let file = imported.export_file();
    for threads in [1, 3] {
        let mut replay = Engine::new(None, Box::new(NoClock), threads);
        let hashes = pollster::block_on(replay.replay(&file.journal.entries, false, true)).unwrap();
        assert_eq!(hashes.last(), Some(&imported.model_hash()));
        assert_eq!(replay.export_file().model, file.model);
        assert_eq!(
            replay.field(Some("AXIAL"), Field::Displacement).unwrap(),
            imported.field(Some("AXIAL"), Field::Displacement).unwrap()
        );
    }
    let mut reopened = engine();
    reopened.import_file(file.clone()).unwrap();
    assert_eq!(reopened.export_file(), file);
}

#[test]
fn abaqus_static_rejects_unsupported_keywords_parameters_and_conflicts_without_mutation() {
    let mut e = engine();
    cantilever(&mut e);
    ok(&mut e, r#"{"cmd":"solve.run","step":"static","solver":"cpu-direct"}"#);
    let before = e.export_file();
    let field = e.field(Some("static"), Field::Stress).unwrap().clone();
    for (from, to, code, where_) in [
        ("*MATERIAL,NAME=STEEL", "*MATERIAL,NAME=STEEL,EXTRA=YES", ErrorCode::Unsupported, "*MATERIAL EXTRA"),
        ("*ELASTIC,TYPE=ISOTROPIC", "*ELASTIC,TYPE=ORTHOTROPIC", ErrorCode::Unsupported, "*ELASTIC TYPE"),
        ("*ELASTIC,TYPE=ISOTROPIC", "*ELASTIC,DEPENDENCIES=1", ErrorCode::Unsupported, "*ELASTIC DEPENDENCIES"),
        ("200000,0", "200000,0,300", ErrorCode::Schema, "*ELASTIC record"),
        ("200000,0", "200000,0\n210000,0", ErrorCode::Unsupported, "*ELASTIC data"),
        ("200000,0", "0,0", ErrorCode::Schema, "*ELASTIC E/nu"),
        ("200000,0", "200000,-1", ErrorCode::Schema, "*ELASTIC E/nu"),
        ("200000,0", "200000,0.5", ErrorCode::Schema, "*ELASTIC E/nu"),
        ("1.0\n*BOUNDARY", "2.0\n*BOUNDARY", ErrorCode::Unsupported, "*SOLIDSECTION attribute"),
        ("ELSET=SOLID,MATERIAL=STEEL", "ELSET=SOLID,MATERIAL=ABSENT", ErrorCode::Schema, "*SOLIDSECTION MATERIAL"),
        ("ELSET=SOLID,MATERIAL=STEEL", "ELSET=ABSENT,MATERIAL=STEEL", ErrorCode::Schema, "*SOLIDSECTION ELSET"),
        ("ROOT,1,3", "ROOT,1,3,1", ErrorCode::Unsupported, "*BOUNDARY magnitude"),
        ("ROOT,1,3", "ROOT,3,1", ErrorCode::Schema, "*BOUNDARY DOF range"),
        ("*BOUNDARY\nROOT", "*BOUNDARY,TYPE=VELOCITY\nROOT", ErrorCode::Unsupported, "*BOUNDARY TYPE"),
        ("TIP,1,250", "TIP,4,250", ErrorCode::Unsupported, "*CLOAD DOF"),
        ("TIP,1,250", "TIP,1", ErrorCode::Schema, "*CLOAD record"),
        ("TIP,1,250", "TIP,1,250\n244,1,1", ErrorCode::Unsupported, "*CLOAD target"),
        ("TIP,1,250", "TIP,1,250\nTIP,1,250", ErrorCode::Unsupported, "*CLOAD target"),
        ("TIP,1,250", "ABSENT,1,250", ErrorCode::Schema, "*CLOAD target"),
        ("TIP,1,250", "9999,1,250", ErrorCode::Schema, "*CLOAD target"),
        ("NLGEOM=NO", "NLGEOM=YES", ErrorCode::Unsupported, "*STEP NLGEOM"),
    ] {
        let text = HEX.replace(from, to);
        assert_ne!(text, HEX);
        let error = convert(&mut e, &text, "1 mm", "1 N").unwrap_err();
        assert_eq!(error.code, code, "{to}: {error:?}");
        assert!(error.where_.as_deref().unwrap().contains(where_), "{error:?}");
        assert!(error.where_.as_deref().unwrap().starts_with("line "));
        assert!(error.suggestion.is_some());
        assert_eq!(e.export_file(), before);
        assert_eq!(e.field(Some("static"), Field::Stress).unwrap(), &field);
    }
    for keyword in [
        "DENSITY",
        "CONDUCTIVITY",
        "EXPANSION",
        "SPECIFIC HEAT",
        "PLASTIC",
        "CONTACT",
        "AMPLITUDE",
        "DYNAMIC",
        "FREQUENCY",
        "HEAT TRANSFER",
    ] {
        let text = HEX.replace("*END STEP", &format!("*{keyword}\n*END STEP"));
        let error = convert(&mut e, &text, "1 mm", "1 N").unwrap_err();
        assert_eq!(error.code, ErrorCode::Unsupported, "{keyword}: {error:?}");
        assert_eq!(e.export_file(), before);
    }
}

#[test]
fn abaqus_static_rejects_invalid_keyword_arguments_and_records_without_mutation() {
    let mut e = engine();
    cantilever(&mut e);
    ok(&mut e, r#"{"cmd":"solve.run","step":"static","solver":"cpu-direct"}"#);
    let before = e.export_file();
    let stress = e.field(Some("static"), Field::Stress).unwrap().clone();
    for (from, to, code, location) in [
        ("*END STEP", "*MATERIAL,NAME=SECOND\n*END STEP", ErrorCode::Unsupported, "*MATERIAL keyword"),
        ("*MATERIAL,NAME=STEEL", "*MATERIAL", ErrorCode::Schema, "*MATERIAL NAME"),
        ("NAME=STEEL\n*ELASTIC", "NAME=BAD.NAME\n*ELASTIC", ErrorCode::Unsupported, "*MATERIAL NAME"),
        ("*END STEP", "*ELASTIC\n*END STEP", ErrorCode::Unsupported, "*ELASTIC keyword"),
        ("*ELASTIC,TYPE=ISOTROPIC", "*ELASTIC,TYPE", ErrorCode::Schema, "*ELASTIC TYPE"),
        (
            "*END STEP",
            "*SOLID SECTION,ELSET=SOLID,MATERIAL=STEEL\n*END STEP",
            ErrorCode::Unsupported,
            "*SOLIDSECTION keyword",
        ),
        (
            "ELSET=SOLID,MATERIAL=STEEL",
            "ELSET=SOLID,MATERIAL=STEEL,CONTROLS=HOURGLASS",
            ErrorCode::Unsupported,
            "*SOLIDSECTION CONTROLS",
        ),
        (
            "*SOLID SECTION,ELSET=SOLID,MATERIAL=STEEL",
            "*SOLID SECTION,MATERIAL=STEEL",
            ErrorCode::Schema,
            "*SOLIDSECTION ELSET",
        ),
        (
            "*SOLID SECTION,ELSET=SOLID,MATERIAL=STEEL",
            "*SOLID SECTION,ELSET=BAD.NAME,MATERIAL=STEEL",
            ErrorCode::Unsupported,
            "*SOLIDSECTION ELSET",
        ),
        (
            "*SOLID SECTION,ELSET=SOLID,MATERIAL=STEEL",
            "*SOLID SECTION,ELSET=SOLID",
            ErrorCode::Schema,
            "*SOLIDSECTION MATERIAL",
        ),
        (
            "*SOLID SECTION,ELSET=SOLID,MATERIAL=STEEL",
            "*SOLID SECTION,ELSET=SOLID,MATERIAL=BAD.NAME",
            ErrorCode::Unsupported,
            "*SOLIDSECTION MATERIAL",
        ),
        ("*BOUNDARY\n", "*BOUNDARY,OP=NEW\n", ErrorCode::Unsupported, "*BOUNDARY OP"),
        ("*BOUNDARY\n", "*BOUNDARY,TYPE\n", ErrorCode::Schema, "*BOUNDARY TYPE"),
        ("NLGEOM=NO", "NLGEOM", ErrorCode::Schema, "*STEP NLGEOM"),
        ("NAME=AXIAL", "NAME", ErrorCode::Schema, "*STEP NAME"),
        ("NAME=AXIAL", "NAME=BAD.NAME", ErrorCode::Unsupported, "*STEP NAME"),
        ("*END STEP", "*END STEP,EXTRA=YES", ErrorCode::Unsupported, "*ENDSTEP EXTRA"),
        ("200000,0\n", "BAD,0\n", ErrorCode::Schema, "*ELASTIC E"),
        ("200000,0\n", "200000,BAD\n", ErrorCode::Schema, "*ELASTIC nu"),
        ("1.0\n*BOUNDARY", "1.0,1.0\n*BOUNDARY", ErrorCode::Schema, "*SOLIDSECTION record"),
        ("1.0\n*BOUNDARY", "BAD\n*BOUNDARY", ErrorCode::Schema, "*SOLIDSECTION attribute"),
        ("ROOT,1,3", "ROOT,1,3,0,EXTRA", ErrorCode::Schema, "*BOUNDARY record"),
        ("ROOT,1,3", "BAD.NAME,1,3", ErrorCode::Schema, "*BOUNDARY target"),
        ("ROOT,1,3", "ROOT,1,3,BAD", ErrorCode::Schema, "*BOUNDARY magnitude"),
        ("1,1,1e-5", "1,1,1e-5,,EXTRA", ErrorCode::Schema, "*STATIC record"),
        ("1,1,1e-5", "BAD,1,1e-5", ErrorCode::Schema, "*STATIC increment field 1"),
        ("ROOT,1,3", "ABSENT,1,3", ErrorCode::Schema, "*BOUNDARY target"),
        ("*HEADING", "*HEADING\n\0", ErrorCode::Schema, "*INPUT physical line"),
        ("*NODE\n", "*NODE,NSET=A,NSET=B\n", ErrorCode::Schema, "*NODE parameter"),
    ] {
        let text = HEX.replace(from, to);
        assert_ne!(text, HEX);
        let error = convert(&mut e, &text, "1 mm", "1 N").unwrap_err();
        assert_eq!(error.code, code, "{to}: {error:?}");
        assert!(error.where_.as_deref().unwrap().contains(location), "{to}: {error:?}");
        assert!(error.suggestion.is_some());
        assert_eq!(e.export_file(), before);
        assert_eq!(e.field(Some("static"), Field::Stress).unwrap(), &stress);
    }
}

#[test]
fn abaqus_static_requires_explicit_finite_scales_and_full_material_section_step_coverage() {
    let mut e = engine();
    for (length, force, code, path) in [
        ("0 m", "1 N", ErrorCode::Schema, "unitLength"),
        ("-1 m", "1 N", ErrorCode::Schema, "unitLength"),
        ("1 N", "1 N", ErrorCode::UnitDimension, "unitLength"),
        ("1 mm", "1 m", ErrorCode::UnitDimension, "unitForce"),
        ("1 mm", "0 N", ErrorCode::Schema, "unitForce"),
        ("1 mm", "-1 N", ErrorCode::Schema, "unitForce"),
        ("1 mm", "1e309 N", ErrorCode::Schema, "unitForce"),
        ("1e-300 m", "1 N", ErrorCode::Schema, "unitForce"),
        ("1e300 m", "1e-300 N", ErrorCode::Schema, "unitForce"),
    ] {
        let error = convert(&mut e, HEX, length, force).unwrap_err();
        assert_eq!(error.code, code);
        assert_eq!(error.where_.as_deref(), Some(path));
    }
    for (from, to, needle) in [
        ("*ELASTIC,TYPE=ISOTROPIC\n200000,0\n", "", "ELASTIC"),
        ("*SOLID SECTION,ELSET=SOLID,MATERIAL=STEEL\n1.0\n", "", "SOLIDSECTION"),
        ("*END STEP\n", "", "STEP"),
        ("*STATIC\n1,1,1e-5\n", "", "CLOAD"),
        ("*MATERIAL,NAME=STEEL\n", "", "ELASTIC"),
        (
            "*SOLID SECTION,ELSET=SOLID,MATERIAL=STEEL",
            "*ELSET,ELSET=PARTIAL\n401\n*SOLID SECTION,ELSET=PARTIAL,MATERIAL=STEEL",
            "SOLIDSECTION",
        ),
        ("*MATERIAL,NAME=STEEL", "*MATERIAL,NAME=STEEL\n*MATERIAL,NAME=SECOND", "MATERIAL"),
        (
            "*SOLID SECTION,ELSET=SOLID,MATERIAL=STEEL\n1.0",
            "*SOLID SECTION,ELSET=SOLID,MATERIAL=STEEL\n1.0\n*SOLID SECTION,ELSET=SOLID,MATERIAL=STEEL",
            "SOLIDSECTION",
        ),
    ] {
        let error = convert(&mut e, &HEX.replace(from, to), "1 mm", "1 N").unwrap_err();
        assert!(error.where_.as_deref().unwrap().contains(needle), "{error:?}");
    }
    // A retained but unused source node must never receive invented finite-element DOFs.
    let text = HEX.replace("*MATERIAL", "*NODE\n9999,0,0,0\n*MATERIAL").replace("TIP,1,250", "9999,1,250");
    assert!(convert(&mut e, &text, "1 mm", "1 N").unwrap_err().where_.as_deref().unwrap().contains("source node 9999"));
    let text = HEX.replace("TIP,1,250", "TIP,1,1e308");
    assert!(convert(&mut e, &text, "1 mm", "1 N").unwrap_err().where_.as_deref().unwrap().contains("Set total"));
}

#[test]
fn abaqus_static_rejects_malformed_history_records_and_requires_the_static_force_scale() {
    let mut e = engine();
    let before = e.export_file();
    for text in ["", "** comments do not define a model\n", "*HEADING\nNo mesh\n"] {
        let error = convert(&mut e, text, "1 mm", "1 N").unwrap_err();
        assert_eq!(error.code, ErrorCode::Schema);
        assert_eq!(error.where_.as_deref(), Some("line 1 *INPUT mesh"));
        assert_eq!(e.export_file(), before);
    }
    let text = format!("{}*MATERIAL,NAME=STEEL\n*ELASTIC\n", HEX.split("*MATERIAL").next().unwrap());
    let error = convert(&mut e, &text, "1 mm", "1 N").unwrap_err();
    assert_eq!(error.code, ErrorCode::Schema);
    assert!(error.where_.as_deref().unwrap().contains("*ELASTIC data"));
    assert_eq!(e.export_file(), before);
    for (from, to) in [
        ("*HEADING", "1,0,0,0\n*HEADING"),
        ("*NODE\n101,0,0,0", "*NODE\n*NODE\n101,0,0,0"),
        ("101,0,0,0", "101,BAD,0,0"),
        ("401,101,153,166,114,127,179,192,140", "401,999,153,166,114,127,179,192,140"),
        ("*MATERIAL,NAME=STEEL\n*ELASTIC", "*MATERIAL,NAME=STEEL\n1\n*ELASTIC"),
        ("200000,0", "200000,0\n*ELASTIC\n200000,0"),
        ("200000,0\n", ""),
        ("*MATERIAL,NAME=STEEL\n*ELASTIC,TYPE=ISOTROPIC\n200000,0\n", ""),
        ("*STEP,NAME=AXIAL,NLGEOM=NO", "*STEP,NAME=AXIAL,NLGEOM=NO\n1"),
        ("*STATIC\n1,1,1e-5", "*STEP,NAME=NESTED\n*STATIC\n1,1,1e-5"),
        ("*STATIC\n1,1,1e-5", "*STATIC\n1,1,1e-5\n*STATIC"),
        ("*STATIC\n1,1,1e-5", "*STATIC\n1,1,1e-5\n1,1,1e-5"),
        ("*STATIC\n1,1,1e-5", "*BOUNDARY\nTIP,1\n*STATIC\n1,1,1e-5"),
        ("*STEP,NAME=AXIAL,NLGEOM=NO", "*STATIC\n*STEP,NAME=AXIAL,NLGEOM=NO"),
        ("*STEP,NAME=AXIAL,NLGEOM=NO\n*STATIC\n1,1,1e-5\n*CLOAD\nTIP,1,250\n*END STEP", "*END STEP"),
        ("*STEP,NAME=AXIAL,NLGEOM=NO\n*STATIC\n1,1,1e-5\n*CLOAD\nTIP,1,250\n*END STEP\n", ""),
        ("*END STEP", "*END STEP\n1"),
        ("1.0\n*BOUNDARY", "1.0\n1.0\n*BOUNDARY"),
        ("ROOT,1,3", "ROOT,x,3"),
        ("ROOT,1,3", "ROOT,1,4"),
        ("ROOT,1,3", "ROOT,1,BAD"),
        ("ROOT,1,3\n", ""),
        ("TIP,1,250\n", ""),
        ("TIP,1,250", "TIP,1,BAD"),
        ("TIP,1,250", ",1,250"),
        ("*CLOAD", "*CLOAD,AMPLITUDE=A"),
    ] {
        let text = HEX.replace(from, to);
        assert_ne!(text, HEX);
        let error = convert(&mut e, &text, "1 mm", "1 N").unwrap_err();
        assert!(error.where_.as_deref().unwrap().starts_with("line "), "{error:?}");
        assert_eq!(e.export_file(), before);
    }
    let mut missing = serde_json::to_value(request(HEX, "1 mm", "1 N")).unwrap();
    missing.as_object_mut().unwrap().remove("unitForce");
    let error = e.query(serde_json::from_value(missing).unwrap()).unwrap_err();
    assert_eq!(error.code, ErrorCode::Schema);
    assert_eq!(error.where_.as_deref(), Some("unitForce"));
    let mesh_mode = json!({"query":"query.convertAbaqus","mode":"mesh","text":HEX,"body":"bar","name":"Mesh mode","unitLength":"1 mm","unitForce":"1 N","sha256":sha256_hex(HEX.as_bytes())});
    let error = e.query(serde_json::from_value(mesh_mode).unwrap()).unwrap_err();
    assert_eq!(error.code, ErrorCode::Schema);
    assert_eq!(error.where_.as_deref(), Some("unitForce"));
    let mut unnamed = serde_json::to_value(request(HEX, "1 mm", "1 N")).unwrap();
    unnamed["name"] = json!(" ");
    let error = e.query(serde_json::from_value(unnamed).unwrap()).unwrap_err();
    assert_eq!(error.code, ErrorCode::Schema);
    assert_eq!(error.where_.as_deref(), Some("name"));
    assert_eq!(e.export_file(), before);
}

#[test]
fn abaqus_static_response_bound_counts_analysis_commands_after_mesh_conversion() {
    let mut text = mesh_text(2, false, true);
    // Many independent source load cases retain their own Commands and report entries.
    // Equal overlapping node aliases are intentionally deduplicated by the translator,
    // so they are not an honest witness for analysis response growth anymore.
    let body = "B".repeat(80);
    let mesh_bytes = text.len();
    let mesh_request = json!({"query":"query.convertAbaqus","mode":"mesh","text":text,"name":"Bounded source","body":body,"unitLength":"1 mm","sha256":sha256_hex(text.as_bytes())});
    let mut e = engine();
    let before = e.export_file();
    let mesh = e.query(serde_json::from_value(mesh_request).unwrap()).unwrap();
    assert!(serde_json::to_vec(&mesh).unwrap().len() < 16 * 1024 * 1024);
    text.push_str(&material_text(true, 0.0));
    text.push_str("*BOUNDARY\nROOT,1,3\n");
    for index in 0..20000 {
        text.push_str(&format!("*STEP,NAME=CASE_{index}\n*STATIC\n*END STEP\n"));
    }
    assert!(text.len() > mesh_bytes && text.len() < 16 * 1024 * 1024);
    let query = json!({"query":"query.convertAbaqus","mode":"static","text":text,"name":"Bounded source","body":body,"unitLength":"1 mm","unitForce":"1 N","sha256":sha256_hex(text.as_bytes())});
    let error = e
        .query(serde_json::from_value(query).unwrap())
        .expect_err("independent retained Steps must exceed the unchanged response bound");
    assert_eq!(error.code, ErrorCode::Schema);
    assert_eq!(error.where_.as_deref(), Some("text"));
    assert!(error.cause.contains("serialized Abaqus conversion response"));
    assert_eq!(e.export_file(), before);
}

proptest! {
    #![proptest_config(proptest::test_runner::Config::with_cases(64))]
    #[test]
    fn abaqus_static_arbitrary_text_never_panics(text in any::<String>()) {
        let mut e = engine();
        let before = e.export_file();
        let _ = convert(&mut e,&text,"1 mm","1 N");
        prop_assert_eq!(e.export_file(),before);
    }
}

/// Both source pressure syntaxes act inward for positive pressure. Pulling the right face
/// with p=-100 kPa gives F=1000 N and u=FL/(EA)=0.5 µm at every refinement.
#[test]
fn abaqus_static_surface_and_element_pressures_match_bar_oracles_at_three_refinements() {
    for cells in [2, 4, 8] {
        for surface in [false, true] {
            let mut text = mesh_text(cells, false, false);
            let last = 401 + 17 * (cells - 1);
            text.push_str(&format!("*SURFACE,TYPE=ELEMENT,NAME=PULL\n{last},S4\n"));
            text.push_str(&material_text(false, 0.0));
            text.push_str("*BOUNDARY\nROOT,ENCASTRE\n*STEP,NAME=PULL\n*STATIC,DIRECT\n.1,1,1e-8,1\n");
            if surface {
                text.push_str("*DSLOAD\nPULL,P,-100000\n");
            } else {
                text.push_str(&format!("*DLOAD\n{last},P4,-100000\n"));
            }
            text.push_str("*END STEP\n");
            let mut e = engine();
            let conversion = convert(&mut e, &text, "1 m", "1 N").unwrap();
            install(&mut e, &conversion);
            ok(&mut e, r#"{"cmd":"solve.run","step":"PULL","solver":"cpu-direct"}"#);
            let mesh = e.mesh().unwrap().clone();
            let field = e.field(Some("PULL"), Field::Displacement).unwrap();
            for &node in &mesh.sets["bar.nset_TIP"].nodes {
                assert!((field.data[node as usize * 3] - 5e-7).abs() < 1e-16);
            }
            let reaction: f64 =
                e.field(Some("PULL"), Field::Reaction).unwrap().data.chunks_exact(3).map(|r| r[0]).sum();
            assert!((reaction + 1000.0).abs() < 1e-8);
            assert_eq!(conversion.report.analyses.len(), 1);
            assert!(conversion.report.notes.iter().any(|note| note.keyword == "STATIC"));
        }
    }
}

/// Two half-length elastic regions share the original labelled interface nodes. Series
/// compliance, not an engine-built reference model, fixes u=F/A*(.5/E1+.5/E2)=0.75 µm.
#[test]
fn abaqus_static_exact_material_regions_preserve_shared_interface_and_series_compliance() {
    for half_cells in [1, 2, 4] {
        let cells = 2 * half_cells;
        let mut text = mesh_text(cells, false, false);
        for (set, start, end) in [("LEFT", 0, half_cells), ("RIGHT", half_cells, cells)] {
            text.push_str(&format!("*ELSET,ELSET={set}\n"));
            text.push_str(&(start..end).map(|cell| (401 + 17 * cell).to_string()).collect::<Vec<_>>().join(","));
            text.push('\n');
        }
        text.push_str("*MATERIAL,NAME=STIFF\n*ELASTIC\n200e9,0\n*MATERIAL,NAME=SOFT\n*ELASTIC\n100e9,0\n*SOLID SECTION,ELSET=LEFT,MATERIAL=STIFF\n*SOLID SECTION,ELSET=RIGHT,MATERIAL=SOFT\n*BOUNDARY\nROOT,PINNED\n*STEP,NAME=SERIES\n*STATIC\n*CLOAD\nTIP,1,250\n*END STEP\n");
        let mut e = engine();
        let conversion = convert(&mut e, &text, "1 m", "1 N").unwrap();
        assert_eq!(conversion.report.analyses[0].materials, ["SOFT", "STIFF"]);
        assert_eq!(conversion.report.analyses[0].sections.len(), 2);
        install(&mut e, &conversion);
        ok(&mut e, r#"{"cmd":"solve.run","step":"SERIES","solver":"cpu-direct"}"#);
        let mesh = e.mesh().unwrap().clone();
        assert_eq!(mesh.mesh.n_nodes(), (cells as usize + 1) * 4);
        let displacement = e.field(Some("SERIES"), Field::Displacement).unwrap();
        for &node in &mesh.sets["bar.nset_TIP"].nodes {
            assert!((displacement.data[node as usize * 3] - 7.5e-7).abs() < 1e-16);
        }
        for value in e.field(Some("SERIES"), Field::Stress).unwrap().data.chunks_exact(6) {
            assert!((value[0] - 1e5).abs() < 1e-6);
        }
        let reaction: f64 = e.field(Some("SERIES"), Field::Reaction).unwrap().data.chunks_exact(3).map(|r| r[0]).sum();
        assert!((reaction + 1000.0).abs() < 1e-8);
    }
}

#[test]
fn abaqus_static_multiple_load_cases_inherit_modify_and_reset_effective_state() {
    let mut text = bar(2, false, false);
    text.push_str("*STEP,NAME=INHERITED\n*STATIC\n*END STEP\n*STEP,NAME=DOUBLED\n*STATIC\n*CLOAD,OP=MOD\nTIP,1,500\n*END STEP\n*STEP,NAME=RESET\n*STATIC\n*CLOAD,OP=NEW\nTIP,1,-125\n*END STEP\n*STEP,NAME=PRESSURE\n*STATIC\n*CLOAD,OP=NEW\nTIP,1,0\n*DLOAD\n418,P4,-100000\n*END STEP\n*STEP,NAME=PRESSURE_RESET\n*STATIC\n*DLOAD,OP=NEW\n418,P4,50000\n*END STEP\n");
    let mut e = engine();
    let conversion = convert(&mut e, &text, "1 m", "1 N").unwrap();
    assert_eq!(conversion.report.analyses.len(), 6);
    install(&mut e, &conversion);
    for (step, displacement, resultant) in [
        ("AXIAL", 5e-7, 1000.0),
        ("INHERITED", 5e-7, 1000.0),
        ("DOUBLED", 1e-6, 2000.0),
        ("RESET", -2.5e-7, -500.0),
        ("PRESSURE", 5e-7, 1000.0),
        ("PRESSURE_RESET", -2.5e-7, -500.0),
    ] {
        ok(&mut e, &format!(r#"{{"cmd":"solve.run","step":"{step}","solver":"cpu-direct"}}"#));
        let mesh = e.mesh().unwrap().clone();
        for &node in &mesh.sets["bar.nset_TIP"].nodes {
            assert!(
                (e.field(Some(step), Field::Displacement).unwrap().data[node as usize * 3] - displacement).abs()
                    < 1e-16,
                "{step}"
            );
        }
        let reaction: f64 = e.field(Some(step), Field::Reaction).unwrap().data.chunks_exact(3).map(|r| r[0]).sum();
        assert!((reaction + resultant).abs() < 1e-8, "{step}");
    }
    let file = e.export_file();
    let mut reopened = engine();
    reopened.import_file(file.clone()).unwrap();
    assert_eq!(reopened.export_file(), file);
}

#[test]
fn abaqus_static_density_requires_explicit_time_and_preserves_coherent_mass_units() {
    let text = HEX.replace("*ELASTIC,TYPE=ISOTROPIC", "*DENSITY\n7.8e-9\n*ELASTIC,TYPE=ISOTROPIC");
    let mut e = engine();
    let before = e.export_file();
    let missing = convert(&mut e, &text, "1 mm", "1 N").unwrap_err();
    assert_eq!(missing.where_.as_deref(), Some("unitTime"));
    for (time, expected) in [("1 s", 7800.0), ("1 ms", 0.0078)] {
        let mut request = serde_json::to_value(request(&text, "1 mm", "1 N")).unwrap();
        request["unitTime"] = json!(time);
        let result = e.query(serde_json::from_value(request).unwrap()).unwrap();
        let conversion: AbaqusConversion = serde_json::from_value(serde_json::to_value(result).unwrap()).unwrap();
        let materials = serde_json::to_value(&conversion.commands).unwrap();
        let material = materials.as_array().unwrap().iter().find(|command| command["cmd"] == "material.add").unwrap();
        let value = material["rho"]["value"].as_f64().unwrap();
        assert!((value - expected).abs() < expected * 1e-14);
        assert_eq!(
            conversion.report.unit_time.as_ref().unwrap().si().unwrap(),
            if time == "1 s" { 1.0 } else { 0.001 }
        );
        assert_eq!(e.export_file(), before);
    }
}

#[test]
fn abaqus_static_rejects_unrepresentable_pressure_and_update_semantics_atomically() {
    let base = bar(2, false, false);
    let mut e = engine();
    let before = e.export_file();
    for history in [
        "*DLOAD\n418,P7,1\n",
        "*DSLOAD\nMISSING,TRVEC,1\n",
        "*BOUNDARY\nTIP,XSYMM,1\n",
        "*STATIC,DIRECT=YES\n",
        "*RESTART,READ\n",
        "*RESTART,WRITE=YES\n",
        "*RESTART,WRITE\n1\n",
        "*DLOAD\n418,GRAV,9.81\n",
        "*DSLOAD\nMISSING,P,1\n",
        "*DLOAD\n418,P4,1\n418,P4,2\n",
        "*CLOAD,OP=BAD\nTIP,2,1\n",
        "*CLOAD,OP=NEW\nTIP,2,1\n",
        "*BOUNDARY\nTIP,1,,1\nTIP,1,,2\n",
        "*BOUNDARY,OP=NEW\nTIP,1\n*BOUNDARY,OP=MOD\nROOT,1,3\n",
    ] {
        let text = base.replace("*END STEP", &format!("{history}*END STEP"));
        let error = convert(&mut e, &text, "1 m", "1 N").unwrap_err();
        assert!(error.where_.as_deref().unwrap().contains("line "));
        assert_eq!(e.export_file(), before);
    }
    for (time, expected) in [("0 s", ErrorCode::Schema), ("-1 s", ErrorCode::Schema), ("1 N", ErrorCode::UnitDimension)]
    {
        let mut value = serde_json::to_value(request(&base, "1 m", "1 N")).unwrap();
        value["unitTime"] = json!(time);
        assert_eq!(e.query(serde_json::from_value(value).unwrap()).unwrap_err().code, expected);
        assert_eq!(e.export_file(), before);
    }
}

#[test]
fn abaqus_static_symbolic_solid_boundaries_retain_only_active_translation_components() {
    use femlab_engine::command::{Command, Dof};
    for (symbolic, expected) in [
        ("ENCASTRE", vec![Dof::Ux, Dof::Uy, Dof::Uz]),
        ("PINNED", vec![Dof::Ux, Dof::Uy, Dof::Uz]),
        ("XSYMM", vec![Dof::Ux]),
        ("YSYMM", vec![Dof::Uy]),
        ("ZSYMM", vec![Dof::Uz]),
        ("XASYMM", vec![Dof::Uy, Dof::Uz]),
        ("YASYMM", vec![Dof::Ux, Dof::Uz]),
        ("ZASYMM", vec![Dof::Ux, Dof::Uy]),
    ] {
        let text = bar(2, false, false).replace("ROOT,1,3", &format!("ROOT,{symbolic}"));
        let mut e = engine();
        let conversion = convert(&mut e, &text, "1 m", "1 N").unwrap();
        let mut actual = Vec::new();
        for command in &conversion.commands {
            if let Command::ConstraintPrescribe { dof, value, .. } = command {
                actual.push(*dof);
                assert_eq!(value.si().unwrap(), 0.0);
            }
        }
        assert_eq!(actual, expected, "{symbolic}");
    }
}

#[test]
fn abaqus_static_boundary_modification_and_new_reset_restore_the_source_load_case() {
    let mut text = bar(2, false, false);
    text.push_str("*STEP,NAME=PRESCRIBED\n*STATIC\n*BOUNDARY,OP=MOD\nTIP,1,,1e-6\n*END STEP\n*STEP,NAME=RELEASED\n*STATIC\n*BOUNDARY,OP=NEW\nROOT,ENCASTRE\n*END STEP\n");
    let mut e = engine();
    let conversion = convert(&mut e, &text, "1 m", "1 N").unwrap();
    install(&mut e, &conversion);
    for (step, expected) in [("AXIAL", 5e-7), ("PRESCRIBED", 1e-6), ("RELEASED", 5e-7)] {
        ok(&mut e, &format!(r#"{{"cmd":"solve.run","step":"{step}","solver":"cpu-direct"}}"#));
        let mesh = e.mesh().unwrap().clone();
        for &node in &mesh.sets["bar.nset_TIP"].nodes {
            assert!(
                (e.field(Some(step), Field::Displacement).unwrap().data[node as usize * 3] - expected).abs() < 1e-16
            );
        }
        let reaction: f64 = e.field(Some(step), Field::Reaction).unwrap().data.chunks_exact(3).map(|r| r[0]).sum();
        assert!((reaction + 1000.0).abs() < 1e-8);
    }
}

#[test]
fn abaqus_static_normal_export_output_requests_are_reported_without_discarding_physics() {
    let text = bar(2, false, false).replace("MATERIAL=STEEL\n", "MATERIAL=STEEL\n,\n").replace("*END STEP", "*OUTPUT,FIELD,VARIABLE=PRESELECT\n*NODE OUTPUT,NSET=TIP\nU,RF\n*ELEMENT OUTPUT,ELSET=SOLID\nS,E\n*OUTPUT,HISTORY\n*ENERGY OUTPUT\nALLSE\n*NODE PRINT,NSET=TIP,FREQUENCY=1\nU\n*EL PRINT,ELSET=SOLID\nS\n*NODE FILE\nU\n*EL FILE\nS\n*ENERGY PRINT\nALLSE\n*ENERGY FILE\nALLSE\n*RESTART,WRITE,FREQUENCY=0\n*END STEP");
    let mut e = engine();
    let conversion = convert(&mut e, &text, "1 m", "1 N").unwrap();
    for key in [
        "OUTPUT",
        "NODEOUTPUT",
        "ELEMENTOUTPUT",
        "ENERGYOUTPUT",
        "NODEPRINT",
        "ELPRINT",
        "NODEFILE",
        "ELFILE",
        "ENERGYPRINT",
        "ENERGYFILE",
        "RESTART",
    ] {
        assert!(conversion.report.notes.iter().any(|note| note.keyword == key), "{key}");
    }
    assert!(conversion.report.notes.iter().any(|note| note.keyword == "NODEOUTPUT" && note.cause.contains("RF")));
    install(&mut e, &conversion);
    ok(&mut e, r#"{"cmd":"solve.run","step":"AXIAL","solver":"cpu-direct"}"#);
    let reaction: f64 = e.field(Some("AXIAL"), Field::Reaction).unwrap().data.chunks_exact(3).map(|r| r[0]).sum();
    assert!((reaction + 1000.0).abs() < 1e-8);
}

#[test]
fn abaqus_static_quoted_material_and_step_labels_have_lossless_callable_mappings() {
    let text = bar(2, false, false)
        .replace("NAME=STEEL", "NAME=\"Structural Steel: A.1\"")
        .replace("MATERIAL=STEEL", "MATERIAL=\"Structural Steel: A.1\"")
        .replace("NAME=AXIAL", "NAME=\"Service Load: A.1\"");
    let mut e = engine();
    let conversion = convert(&mut e, &text, "1 m", "1 N").unwrap();
    let analysis = &conversion.report.analyses[0];
    assert_eq!(analysis.source_step, "Service Load: A.1");
    assert_eq!(analysis.step, "abaqus_step_1");
    assert_eq!(analysis.sections[0].source_material, "Structural Steel: A.1");
    assert_eq!(analysis.sections[0].material, "abaqus_material_1");
    install(&mut e, &conversion);
    ok(&mut e, r#"{"cmd":"solve.run","step":"abaqus_step_1","solver":"cpu-direct"}"#);
    let mesh = e.mesh().unwrap().clone();
    for &node in &mesh.sets["bar.nset_TIP"].nodes {
        assert!(
            (e.field(Some("abaqus_step_1"), Field::Displacement).unwrap().data[node as usize * 3] - 5e-7).abs() < 1e-16
        );
    }
}

#[test]
fn abaqus_static_invalid_step_controls_and_combined_load_overflow_are_atomic() {
    let base = bar(2, false, false);
    let mut e = engine();
    let before = e.export_file();
    for text in [
        base.replace("NAME=AXIAL,NLGEOM=NO", "NAME=AXIAL,INC=0"),
        base.replace("NAME=AXIAL,NLGEOM=NO", "NAME=AXIAL,AMPLITUDE=UNKNOWN"),
        base.replace("*STATIC\n", "*STATIC\n-.1,1\n"),
        base.replace("*STATIC\n", "*STATIC,DIRECT=YES\n"),
        base.replace("*MATERIAL,NAME=STEEL", "*MATERIAL,NAME=\"1st material\""),
        format!("{base}*STEP,NAME=AXIAL\n*STATIC\n*END STEP\n"),
        base.replace("TIP,1,250", &format!("{},1,1e308\n{},1,1e308\n", node(2, 0, 0), node(2, 1, 0))),
    ] {
        assert!(convert(&mut e, &text, "1 m", "1 N").is_err());
        assert_eq!(e.export_file(), before);
    }
}

#[test]
fn abaqus_static_anonymous_cases_and_generated_name_collisions_are_explicit() {
    let mut text = bar(2, false, false)
        .replace(
            "*MATERIAL,NAME=STEEL",
            "*MATERIAL,NAME=\"abaqus_material_1\"\n*ELASTIC\n1e9,0\n*MATERIAL,NAME=\"A material\"",
        )
        .replace("MATERIAL=STEEL", "MATERIAL=\"A material\"")
        .replace("NAME=AXIAL,NLGEOM=NO", "NLGEOM=NO");
    text.push_str("*STEP\n*STATIC\n*END STEP\n");
    let mut e = engine();
    let conversion = convert(&mut e, &text, "1 m", "1 N").unwrap();
    assert_eq!(conversion.report.analyses[0].step, "STATIC");
    assert_eq!(conversion.report.analyses[1].step, "STATIC_2");
    assert_eq!(conversion.report.analyses[0].sections[0].material, "abaqus_material_1_");
    install(&mut e, &conversion);
    ok(&mut e, r#"{"cmd":"solve.run","step":"STATIC_2","solver":"cpu-direct"}"#);
    let reaction: f64 = e.field(Some("STATIC_2"), Field::Reaction).unwrap().data.chunks_exact(3).map(|r| r[0]).sum();
    assert!((reaction + 1000.0).abs() < 1e-8);
}

#[test]
fn abaqus_static_overlapping_named_pressures_keep_independent_source_load_identity() {
    let mut text = mesh_text(2, false, false);
    text.push_str("*SURFACE,NAME=PULL_A,TYPE=ELEMENT\n418,S4\n*SURFACE,NAME=PULL_B,TYPE=ELEMENT\n418,S4\n");
    text.push_str(&material_text(false, 0.0));
    text.push_str("*BOUNDARY\nROOT,ENCASTRE\n*STEP,NAME=BOTH\n*STATIC\n*DSLOAD\nPULL_A,P,-50000\nPULL_B,P,-50000\n*END STEP\n*STEP,NAME=MODIFIED\n*STATIC\n*DSLOAD,OP=MOD\nPULL_A,P,-100000\n*END STEP\n*STEP,NAME=RESET\n*STATIC\n*DSLOAD,OP=NEW\nPULL_B,P,50000\n*END STEP\n");
    let mut e = engine();
    let conversion = convert(&mut e, &text, "1 m", "1 N").unwrap();
    assert_eq!(conversion.report.analyses[0].loads.len(), 2);
    assert_eq!(conversion.report.analyses[1].loads.len(), 2);
    assert_eq!(conversion.report.analyses[2].loads.len(), 1);
    install(&mut e, &conversion);
    for (step, total) in [("BOTH", 1000.0), ("MODIFIED", 1500.0), ("RESET", -500.0)] {
        ok(&mut e, &format!(r#"{{"cmd":"solve.run","step":"{step}","solver":"cpu-direct"}}"#));
        let mesh = e.mesh().unwrap().clone();
        for &node in &mesh.sets["bar.nset_TIP"].nodes {
            assert!(
                (e.field(Some(step), Field::Displacement).unwrap().data[node as usize * 3] - total / (0.01 * 200e9))
                    .abs()
                    < 1e-16
            );
        }
        let reaction: f64 = e.field(Some(step), Field::Reaction).unwrap().data.chunks_exact(3).map(|r| r[0]).sum();
        assert!((reaction + total).abs() < 1e-8);
    }
}

#[test]
fn abaqus_static_empty_new_blocks_really_remove_inherited_families() {
    let mut text = bar(2, false, false).replace("*MATERIAL", "*SURFACE,NAME=PULL,TYPE=ELEMENT\n418,S4\n*MATERIAL");
    text.push_str("*STEP,NAME=UNLOADED\n*STATIC\n*CLOAD,OP=NEW\n*END STEP\n*STEP,NAME=PRESSURED\n*STATIC\n*DLOAD\n418,P4,-100000\n*END STEP\n*STEP,NAME=UNPRESSURED\n*STATIC\n*DLOAD,OP=NEW\n*END STEP\n*STEP,NAME=SURFACED\n*STATIC\n*DSLOAD\nPULL,P,-100000\n*END STEP\n*STEP,NAME=SURFACE_CLEAR\n*STATIC\n*DSLOAD,OP=NEW\n*END STEP\n*STEP,NAME=FREE\n*STATIC\n*BOUNDARY,OP=NEW\n*END STEP\n");
    let mut e = engine();
    let conversion = convert(&mut e, &text, "1 m", "1 N").unwrap();
    assert!(conversion.report.analyses.last().unwrap().constraints.is_empty());
    assert!(conversion.report.analyses.last().unwrap().loads.is_empty());
    install(&mut e, &conversion);
    for (step, expected) in
        [("UNLOADED", 0.0), ("PRESSURED", 5e-7), ("UNPRESSURED", 0.0), ("SURFACED", 5e-7), ("SURFACE_CLEAR", 0.0)]
    {
        ok(&mut e, &format!(r#"{{"cmd":"solve.run","step":"{step}","solver":"cpu-direct"}}"#));
        let mesh = e.mesh().unwrap().clone();
        for &node in &mesh.sets["bar.nset_TIP"].nodes {
            assert!(
                (e.field(Some(step), Field::Displacement).unwrap().data[node as usize * 3] - expected).abs() < 1e-16
            );
        }
    }
}

/// Unchanged separately licensed author Abaqus/CAE model, not a deck generated by FEM Lab.
/// The corpus declared this global U tolerance before the formulation diagnostic (#656).
#[test]
fn abaqus_author_cae_c3d8_reference_matches_every_node_and_replays_at_one_and_four_threads() {
    const DECK: &str = include_str!("../fixtures/third-party/brief-finite-element-net/case06/Job-11.inp");
    const REFERENCE: &str =
        include_str!("../fixtures/third-party/brief-finite-element-net/case06/author-abaqus-probes-checked.json");
    let reference: serde_json::Value = serde_json::from_str(REFERENCE).unwrap();
    assert_eq!(sha256_hex(DECK.as_bytes()), reference["source_deck_sha256"].as_str().unwrap());
    let amplitude = reference["displacements"]
        .as_object()
        .unwrap()
        .values()
        .flat_map(|v| v.as_array().unwrap())
        .map(|v| v.as_f64().unwrap().abs())
        .fold(0.0, f64::max);
    let tolerance = 1e-13 + 2e-6 * amplitude;
    let mut first = None;
    for threads in [1, 4] {
        let mut e = Engine::new(None, Box::new(NoClock), threads);
        let conversion = convert(&mut e, DECK, "1 m", "1 N").unwrap();
        assert_eq!((conversion.report.source_nodes, conversion.report.source_elements), (275, 160));
        let source = serde_json::to_value(&conversion.commands[2]).unwrap();
        assert_eq!(source["formulation"], "mean-dilatation");
        let step = conversion.report.analysis.as_ref().unwrap().step.clone();
        install(&mut e, &conversion);
        let before = e.export_file();
        let labels = e.mesh().unwrap().source_labels.nodes.clone();
        let coords = e.mesh().unwrap().mesh.coords.clone();
        ok(&mut e, &json!({"cmd":"solve.run","step":step,"solver":"cpu-direct"}).to_string());
        let u = e.field(Some(&step), Field::Displacement).unwrap().data.clone();
        let reaction = e.field(Some(&step), Field::Reaction).unwrap().data.clone();
        assert_eq!(u.len(), 825);
        for (dense, label) in labels.iter().enumerate() {
            let identity = &source["mesher"]["provenance"]["nodeIdentities"][label.to_string()];
            assert_eq!(identity["instance"], "BEAM-1");
            let original = identity["sourceLabel"].as_u64().unwrap().to_string();
            for axis in 0..3 {
                assert_eq!(coords[3 * dense + axis], reference["coordinates"][&original][axis].as_f64().unwrap());
                let wanted = reference["displacements"][&original][axis].as_f64().unwrap();
                assert!(
                    (u[3 * dense + axis] - wanted).abs() <= tolerance,
                    "node{original},axis{axis}: {} vs{wanted}, tolerance{tolerance}",
                    u[3 * dense + axis]
                );
            }
        }
        for (axis, wanted) in [0.0, 4e6, 0.0].iter().enumerate() {
            let total: f64 = reaction.chunks_exact(3).map(|r| r[axis]).sum();
            assert!((total - wanted).abs() < 1e-4, "axis{axis}: reaction{total}");
        }
        let mut replay = Engine::new(None, Box::new(NoClock), threads);
        pollster::block_on(replay.replay(&before.journal.entries, true, true)).unwrap();
        assert_eq!(replay.export_file(), before);
        match &first {
            Some(previous) => assert_eq!(&u, previous),
            None => first = Some(u),
        }
    }
}
