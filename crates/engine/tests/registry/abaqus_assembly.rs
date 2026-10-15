//! Assembly source identity, typed transforms, includes and atomic unsupported intent.
use super::{engine, run};
use femlab_engine::{hash::sha256_hex, io::abaqus, units::Q};
use serde_json::json;
use std::collections::BTreeMap;
const ASSEMBLY: &str = include_str!("../fixtures/abaqus/assembly-two-instances.inp");

#[test]
fn abaqus_assembly_retains_instances_labels_sets_surfaces_and_true_transforms() {
    let conversion =
        abaqus::convert_mesh(ASSEMBLY, "assembly", "mesh", &Q::text("1 mm"), &sha256_hex(ASSEMBLY.as_bytes())).unwrap();
    let source = serde_json::to_value(&conversion.commands[2]).unwrap();
    assert_eq!(source["mesher"]["nodes"].as_array().unwrap().len(), 8);
    assert_eq!(source["mesher"]["elements"].as_array().unwrap().len(), 2);
    assert_eq!(source["mesher"]["nodeSets"]["ROOTS"], json!([1, 2, 3, 5, 6, 7]));
    assert_eq!(source["mesher"]["elementSets"]["BOTH"], json!([1, 2]));
    assert_eq!(source["mesher"]["surfaces"]["BOTTOMS"].as_array().unwrap().len(), 2);
    assert_eq!(
        source["mesher"]["provenance"]["nodeIdentities"]["5"],
        json!({"sourceLabel":10,"instance":"second instance","part":"Part A"})
    );
    assert_eq!(source["mesher"]["provenance"]["elementIdentities"]["2"]["sourceLabel"], 90);
    let commands = conversion.commands;
    let mut e = engine();
    for command in commands {
        run(&mut e, &serde_json::to_string(&command).unwrap()).unwrap();
    }
    let file = e.export_file();
    let before = e.model_hash();
    let mut replay = engine();
    for entry in &file.journal.entries {
        run(&mut replay, &serde_json::to_string(&entry.cmd).unwrap()).unwrap();
    }
    assert_eq!(replay.model_hash(), before);
    let second = &source["mesher"]["nodes"][5]["at"];
    assert!(second[0]["value"].as_f64().unwrap().abs() < 1e-15);
    assert!((second[1]["value"].as_f64().unwrap() - 0.003).abs() < 1e-15);
}

#[test]
fn abaqus_include_bundle_keeps_original_byte_hashes_and_failure_locations() {
    let root = "*INCLUDE, INPUT=\"Meshes/Part.inp\"\n";
    let files = BTreeMap::from([("Meshes/Part.inp".to_string(), ASSEMBLY.to_string())]);
    let conversion = abaqus::convert_mesh_sources(
        root,
        "assembly",
        "mesh",
        &Q::text("1 m"),
        Some("Main.inp"),
        &files,
        &sha256_hex(root.as_bytes()),
    )
    .unwrap();
    assert_eq!(conversion.report.input_bytes as usize, root.len() + ASSEMBLY.len());
    let source = serde_json::to_value(&conversion.commands[2]).unwrap();
    assert_eq!(source["mesher"]["provenance"]["sourceName"], "Main.inp");
    assert_eq!(source["mesher"]["provenance"]["sourceFiles"]["Meshes/Part.inp"], sha256_hex(ASSEMBLY.as_bytes()));
    let bad = BTreeMap::from([("Meshes/Part.inp".to_string(), "*END PART\n".to_string())]);
    let error = abaqus::convert_mesh_sources(
        root,
        "assembly",
        "mesh",
        &Q::text("1 m"),
        Some("Main.inp"),
        &bad,
        &sha256_hex(root.as_bytes()),
    )
    .unwrap_err();
    assert!(error.where_.unwrap().contains("Meshes/Part.inp: line 1"));
    let unsupported = ASSEMBLY.replace("*END PART\n", "*PLASTIC\n100,0\n*END PART\n");
    assert!(abaqus::convert_mesh(
        &unsupported,
        "assembly",
        "mesh",
        &Q::text("1 m"),
        &sha256_hex(unsupported.as_bytes())
    )
    .is_err());
}

#[test]
fn abaqus_dependency_query_and_mode_unit_guards_do_not_change_active_model() {
    let mut e = engine();
    let before = e.export_file();
    let query = serde_json::from_value(
        json!({"query":"query.abaqusDependencies","text":"*INCLUDE, INPUT=Mesh.inp\n","sourceName":"Main.inp"}),
    )
    .unwrap();
    let dependencies = serde_json::to_value(e.query(query).unwrap()).unwrap();
    assert_eq!(dependencies["missingFiles"], json!(["Mesh.inp"]));
    for (mode, time) in [("mesh", "1 s"), ("static", "0 s"), ("static", "-1 s"), ("static", "1 N")] {
        let mut query = json!({"query":"query.convertAbaqus","text":ASSEMBLY,"name":"units","body":"mesh","mode":mode,"unitLength":"1 m","unitTime":time,"sha256":sha256_hex(ASSEMBLY.as_bytes())});
        if mode == "static" {
            query["unitForce"] = json!("1 N");
        }
        let error = e.query(serde_json::from_value(query).unwrap()).unwrap_err();
        assert_eq!(error.where_.as_deref(), Some("unitTime"));
    }
    assert_eq!(e.export_file(), before);
}

#[test]
fn abaqus_included_connectivity_faces_sets_and_geometry_keep_the_authored_file_and_line() {
    let root = "*INCLUDE,INPUT=Parts/beam.inc\n";
    let original = include_str!("../fixtures/abaqus/sparse-label-tet.inp");
    for text in [
        original.replace("900, 40, 10, 70, 20", "900, 40, 10, 70, 999"),
        original.replace("900, S4", "900, S5"),
        format!("{original}*NSET,NSET=MISSING\n999\n"),
        original.replace("900, 40, 10, 70, 20", "900, 40, 70, 10, 20"),
    ] {
        let files = BTreeMap::from([("Parts/beam.inc".into(), text)]);
        let error = abaqus::convert_mesh_sources(
            root,
            "included",
            "beam",
            &Q::text("1 m"),
            Some("Main.inp"),
            &files,
            &sha256_hex(root.as_bytes()),
        )
        .unwrap_err();
        assert!(error.where_.as_deref().unwrap().starts_with("Parts/beam.inc: line "), "{error:?}");
        assert_eq!(error.where_.as_deref().unwrap().matches("Parts/beam.inc:").count(), 1);
    }
}
