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

#[test]
fn abaqus_included_instance_transforms_and_overrides_keep_the_offending_file() {
    let root = "*INCLUDE,INPUT=Parts/assembly.inc\n";
    let invalid_axis = ASSEMBLY.replace("0,0,0,0,0,1,90", "0,0,0,0,0,0,90");
    let assembly_with_override = ASSEMBLY.replace(
        "*INSTANCE, NAME=\"first instance\", PART=\"Part A\"\n",
        "*INSTANCE, NAME=\"first instance\", PART=\"Part A\"\n*INCLUDE,INPUT=Overrides.inc\n",
    );
    for (assembly, overrides, expected, cause) in [
        (invalid_axis, "", "Parts/assembly.inc: line 22 *INSTANCE axis", "rotation axis"),
        (
            assembly_with_override.clone(),
            "*NSET,NSET=\"Root, = Face\"\n10\n",
            "Overrides.inc: line 1 *NSET NSET",
            "cannot override inherited part sets",
        ),
        (
            assembly_with_override.clone(),
            "*NODE\n50,0,0,0\n",
            "Overrides.inc: line 1 *INSTANCE mesh",
            "part mesh or section cannot be overridden",
        ),
        (assembly_with_override, "*NSET\n10\n", "Overrides.inc: line 1 *NSET NSET", "required"),
    ] {
        let files =
            BTreeMap::from([("Parts/assembly.inc".into(), assembly), ("Overrides.inc".into(), overrides.into())]);
        let error = abaqus::convert_mesh_sources(
            root,
            "included",
            "mesh",
            &Q::text("1 m"),
            Some("Main.inp"),
            &files,
            &sha256_hex(root.as_bytes()),
        )
        .unwrap_err();
        assert_eq!(error.where_.as_deref(), Some(expected), "{error:?}");
        assert!(error.cause.contains(cause), "{error:?}");
    }
}

const ALTERNATE_ROOT: &str = include_str!("../fixtures/abaqus/alternate-data/Main.inp");
const ALTERNATE_PART: &str = include_str!("../fixtures/abaqus/alternate-data/Parts/Beam.inp");
const ALTERNATE_NODES: &str = include_str!("../fixtures/abaqus/alternate-data/Data/Nodes.inp");
const ALTERNATE_ELEMENTS: &str = include_str!("../fixtures/abaqus/alternate-data/Data/Elements.inp");

fn alternate_files() -> BTreeMap<String, String> {
    BTreeMap::from([
        ("Parts/Beam.inp".into(), ALTERNATE_PART.into()),
        ("Data/Nodes.inp".into(), ALTERNATE_NODES.into()),
        ("Data/Elements.inp".into(), ALTERNATE_ELEMENTS.into()),
    ])
}

#[test]
fn abaqus_alternate_data_dependencies_and_inline_equivalence_preserve_source_identity() {
    let mut e = engine();
    let before = e.export_file();
    for (files, missing) in [
        (BTreeMap::new(), vec!["Parts/Beam.inp"]),
        (
            BTreeMap::from([("Parts/Beam.inp".to_string(), ALTERNATE_PART.to_string())]),
            vec!["Data/Elements.inp", "Data/Nodes.inp"],
        ),
        (alternate_files(), vec![]),
    ] {
        let query = json!({"query":"query.abaqusDependencies","text":ALTERNATE_ROOT,"sourceName":"Main.inp","sourceFiles":files});
        let found = serde_json::to_value(e.query(serde_json::from_value(query).unwrap()).unwrap()).unwrap();
        assert_eq!(found["missingFiles"], json!(missing));
    }
    let files = alternate_files();
    let query = json!({"query":"query.convertAbaqus","text":ALTERNATE_ROOT,"sourceName":"Main.inp","sourceFiles":files,
        "name":"alternate","body":"mesh","mode":"mesh","unitLength":"1 m","sha256":sha256_hex(ALTERNATE_ROOT.as_bytes())});
    let conversion: femlab_engine::query::AbaqusConversion =
        serde_json::from_value(serde_json::to_value(e.query(serde_json::from_value(query).unwrap()).unwrap()).unwrap())
            .unwrap();
    assert_eq!(e.export_file(), before);
    let inline = ALTERNATE_PART
        .replace("*NODE,NSET=ALL,INPUT=\"Data/Nodes.inp\"\n", &format!("*NODE,NSET=ALL\n{ALTERNATE_NODES}"))
        .replace(
            "*ELEMENT,TYPE=C3D4,ELSET=ALL,INPUT=Data/Elements.inp\n",
            &format!("*ELEMENT,TYPE=C3D4,ELSET=ALL\n{ALTERNATE_ELEMENTS}"),
        );
    let inline =
        abaqus::convert_mesh(&inline, "alternate", "mesh", &Q::text("1 m"), &sha256_hex(inline.as_bytes())).unwrap();
    let mut actual = serde_json::to_value(&conversion.commands[2]).unwrap();
    let mut expected = serde_json::to_value(&inline.commands[2]).unwrap();
    assert_eq!(actual["mesher"]["provenance"]["sha256"], sha256_hex(ALTERNATE_ROOT.as_bytes()));
    assert_eq!(actual["mesher"]["provenance"]["sourceName"], "Main.inp");
    assert_eq!(actual["mesher"]["provenance"]["nodeIdentities"], expected["mesher"]["provenance"]["nodeIdentities"]);
    assert_eq!(
        actual["mesher"]["provenance"]["elementIdentities"],
        expected["mesher"]["provenance"]["elementIdentities"]
    );
    for (path, text) in alternate_files() {
        assert_eq!(actual["mesher"]["provenance"]["sourceFiles"][&path], sha256_hex(text.as_bytes()));
    }
    actual["mesher"].as_object_mut().unwrap().remove("provenance");
    expected["mesher"].as_object_mut().unwrap().remove("provenance");
    assert_eq!(actual, expected);
    assert_eq!(conversion.report.source_nodes, 4);
    assert_eq!(conversion.report.source_elements, 1);
    assert_eq!(
        conversion.report.input_bytes as usize,
        ALTERNATE_ROOT.len() + alternate_files().values().map(String::len).sum::<usize>()
    );
    for command in &conversion.commands {
        run(&mut e, &serde_json::to_string(command).unwrap()).unwrap();
    }
    let mut replay = engine();
    for entry in &e.export_file().journal.entries {
        run(&mut replay, &serde_json::to_string(&entry.cmd).unwrap()).unwrap();
    }
    assert_eq!(e.model_hash(), replay.model_hash());
    assert_eq!(e.mesh().unwrap(), replay.mesh().unwrap());
    let model = serde_json::to_value(e.query(serde_json::from_value(json!({"query":"query.model"})).unwrap()).unwrap())
        .unwrap();
    let body = model["bodies"].as_array().unwrap().iter().find(|body| body["name"] == "mesh").unwrap();
    assert!((body["measure"]["value"].as_f64().unwrap() - 1.0 / 6.0).abs() < 1e-14);
}

#[test]
fn abaqus_alternate_element_data_keeps_continued_quadratic_connectivity() {
    let root = "*NODE,INPUT=Nodes.inp\n*ELEMENT,TYPE=C3D10,ELSET=ALL,INPUT=Elements.inp\n";
    let nodes = "1,0,0,0\n2,1,0,0\n3,0,1,0\n4,0,0,1\n5,.5,0,0\n6,.5,.5,0\n7,0,.5,0\n8,0,0,.5\n9,.5,0,.5\n10,0,.5,.5\n";
    let elements = "** one physical element over two data lines\n90,1,2,3,4,5,\n6,7,8,9,10\n";
    let files = BTreeMap::from([("Nodes.inp".into(), nodes.into()), ("Elements.inp".into(), elements.into())]);
    let conversion = abaqus::convert_mesh_sources(
        root,
        "quadratic",
        "mesh",
        &Q::text("1 m"),
        Some("Main.inp"),
        &files,
        &sha256_hex(root.as_bytes()),
    )
    .unwrap();
    let source = serde_json::to_value(&conversion.commands[2]).unwrap();
    assert_eq!(source["mesher"]["elements"][0]["nodes"], json!([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    assert_eq!(source["mesher"]["elementSets"]["ALL"], json!([90]));
    assert_eq!(conversion.report.source_elements, 1);
    let mut e = engine();
    for command in conversion.commands {
        run(&mut e, &serde_json::to_string(&command).unwrap()).unwrap();
    }
    assert_eq!(e.mesh().unwrap().mesh.n_nodes(), 10);
}

#[test]
fn abaqus_alternate_data_failures_keep_the_original_file_line_and_active_model() {
    let root = "*NODE,INPUT=Nodes.inp\n*ELEMENT,TYPE=C3D4,INPUT=Elements.inp\n";
    let nodes = "1,0,0,0\n2,1,0,0\n3,0,1,0\n4,0,0,1\n";
    let mut e = engine();
    run(&mut e, r#"{"cmd":"model.new","name":"Keep active"}"#).unwrap();
    let before = e.export_file();
    for (bad_nodes, bad_elements, expected, cause) in [
        ("** node data\n1,NaN,0,0\n", "90,1,2,3,4\n", "Nodes.inp: line 2 *NODE", "finite"),
        (nodes, "** connectivity\n90,1,2,3,999\n", "Elements.inp: line 2 *ELEMENT", "not defined"),
        (nodes, "** incomplete\n90,1,2,\n", "Elements.inp: line 2 *ELEMENT", "incomplete continued"),
        ("*INCLUDE,INPUT=Main.inp\n", "90,1,2,3,4\n", "Nodes.inp: line 1 *NODE INPUT", "data records only"),
        ("** comments alone\n", "90,1,2,3,4\n", "Nodes.inp: line 1 *NODE INPUT", "at least one"),
        ("1,0,0,0\n1,1,0,0\n", "90,1,2,3,4\n", "Nodes.inp: line 2 *NODE", "already defined"),
    ] {
        let files = BTreeMap::from([("Nodes.inp", bad_nodes), ("Elements.inp", bad_elements)]);
        let request = json!({"query":"query.convertAbaqus","text":root,"sourceName":"Main.inp","sourceFiles":files,
            "name":"invalid","body":"mesh","mode":"mesh","unitLength":"1 m","sha256":sha256_hex(root.as_bytes())});
        let error = e.query(serde_json::from_value(request).unwrap()).unwrap_err();
        assert!(error.where_.as_deref().unwrap().starts_with(expected), "{error:?}");
        assert_eq!(error.where_.as_deref().unwrap().matches(".inp:").count(), 1, "{error:?}");
        assert!(error.cause.contains(cause), "{error:?}");
        assert_eq!(e.export_file(), before);
    }
    for text in ["*NODE,INPUT=Main.inp\n", "*NODE,INPUT=../Nodes.inp\n", "*NODE,INPUT=Nodes.inp\n1,0,0,0\n"] {
        let request = json!({"query":"query.abaqusDependencies","text":text,"sourceName":"Main.inp"});
        assert!(e.query(serde_json::from_value(request).unwrap()).is_err(), "{text}");
    }
    assert_eq!(e.export_file(), before);
}
