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

const SINGLE: &str = "*PART,NAME=P\n*NODE\n1,0,0,0\n2,1,0,0\n3,0,1,0\n4,0,0,1\n*ELEMENT,TYPE=C3D4,ELSET=ALL\n1,1,2,3,4\n*NSET,NSET=TIP\n4\n*END PART\n*ASSEMBLY,NAME=A\n*INSTANCE,NAME=I,PART=P\n*END INSTANCE\n*END ASSEMBLY\n";

#[test]
fn abaqus_public_reader_captures_assembly_sets_extra_nodes_and_lowercase_surface_faces() {
    let additions = "*NODE,NSET=FREE\n5,3,0,0\n*NSET,NSET=G,INSTANCE=I,GENERATE\n1,4\n*NSET,NSET=G\nFREE,\n*NSET,NSET=COPY\nA.G\n*ELSET,ELSET=CELLS,INSTANCE=I,GENERATE\n1,1,\n*NSET,NSET=FROM_CELLS,ELSET=A.CELLS\n*SURFACE,NAME=S\nA.I.ALL,s1\n";
    let text = SINGLE.replace("*END ASSEMBLY\n", &format!("{additions}*END ASSEMBLY\n"));
    let mesh = abaqus::read_mesh(&text, "mesh", &Q::text("1 m"), &sha256_hex(text.as_bytes())).unwrap();
    assert_eq!(mesh.source.node_sets["G"], [1, 2, 3, 4, 5]);
    assert_eq!(mesh.source.node_sets["COPY"], [1, 2, 3, 4, 5]);
    assert_eq!(mesh.source.node_sets["FROM_CELLS"], [1, 2, 3, 4]);
    assert_eq!(mesh.source.node_sets["FREE"], [5]);
    assert_eq!(mesh.source.element_sets["CELLS"], [1]);
    assert_eq!(mesh.source.surfaces["S"][0].face, 1);
    assert_eq!(mesh.source_labels.unused_nodes, [5]);
}

#[test]
fn abaqus_assembly_scope_and_declaration_errors_identify_the_rejected_capability() {
    for (text, cause) in [
        (format!("*PART,NAME=P\n*END PART\n{SINGLE}"), "already defined"),
        (SINGLE.replace("*ASSEMBLY,NAME=A\n", "*ASSEMBLY,NAME=A\n*ASSEMBLY,NAME=B\n"), "only one assembly"),
        (format!("*END ASSEMBLY\n{SINGLE}"), "open assembly"),
        (SINGLE.replace("*END INSTANCE\n", "*END ASSEMBLY\n*END INSTANCE\n"), "closed instances"),
        (SINGLE.replace("NAME=I,PART=P", "NAME=I,PART=MISSING"), "not defined"),
        (format!("*END INSTANCE\n{SINGLE}"), "open instance"),
        (SINGLE.split_once("*ASSEMBLY").unwrap().0.into(), "require an assembly"),
        ("*ASSEMBLY,NAME=A\n*END ASSEMBLY\n".into(), "at least one instance"),
        (SINGLE.replace("*PART,NAME=P", "*PART,NAME=P,UNKNOWN=YES"), "parameter"),
        (SINGLE.replace("*PART,NAME=P\n", "*PART,NAME=P\n1\n"), "accepts no data"),
        (SINGLE.replace("*NODE\n", "*PART,NAME=Q\n*NODE\n"), "outside and before"),
        (SINGLE.replace("*PART,NAME=P", "*PART"), "NAME is required"),
        (SINGLE.replace("*PART,NAME=P", "*PART,NAME=1BAD"), "invalid Abaqus label"),
        (SINGLE.replace("*END PART", "*END PART,UNKNOWN"), "parameter"),
        (SINGLE.replace("*END PART\n", "*END PART\n1\n"), "accepts no data"),
        (SINGLE.replace("*ASSEMBLY,NAME=A", "*ASSEMBLY,NAME=A,UNKNOWN"), "parameter"),
        (SINGLE.replace("*ASSEMBLY,NAME=A\n", "*ASSEMBLY,NAME=A\n1\n"), "accepts no data"),
        (SINGLE.replace("*ASSEMBLY,NAME=A", "*ASSEMBLY"), "NAME is required"),
        (SINGLE.replace("*ASSEMBLY,NAME=A", "*ASSEMBLY,NAME=1BAD"), "invalid Abaqus label"),
        (SINGLE.replace("*END ASSEMBLY", "*END ASSEMBLY,UNKNOWN"), "parameter"),
        (SINGLE.replace("*END ASSEMBLY\n", "*END ASSEMBLY\n1\n"), "accepts no data"),
        (SINGLE.replace("*INSTANCE,NAME=I,PART=P", "*INSTANCE,NAME=I,PART=P,UNKNOWN"), "parameter"),
        (SINGLE.replace("*INSTANCE,NAME=I,PART=P", "*INSTANCE,PART=P"), "NAME is required"),
        (SINGLE.replace("*INSTANCE,NAME=I,PART=P", "*INSTANCE,NAME=1BAD,PART=P"), "invalid Abaqus label"),
        (SINGLE.replace("*INSTANCE,NAME=I,PART=P", "*INSTANCE,NAME=ASSEMBLY,PART=P"), "reserved"),
        (SINGLE.replace("*INSTANCE,NAME=I,PART=P", "*INSTANCE,NAME=I"), "PART is required"),
        (SINGLE.replace("*INSTANCE,NAME=I,PART=P", "*INSTANCE,NAME=I,PART=1BAD"), "invalid Abaqus label"),
        (SINGLE.replace("*END INSTANCE", "*END INSTANCE,UNKNOWN"), "parameter"),
        (SINGLE.replace("*END INSTANCE\n", "*END INSTANCE\n1\n"), "accepts no data"),
        (format!("*NODE\n9,0,0,0\n{SINGLE}"), "flat model-level mesh"),
    ] {
        let error = abaqus::read_mesh(&text, "mesh", &Q::text("1 m"), &sha256_hex(text.as_bytes())).err().unwrap();
        assert!(error.cause.contains(cause), "expected {cause}: {error:?}");
        assert!(error.where_.is_some(), "{error:?}");
    }
}

#[test]
fn abaqus_assembly_set_and_surface_adverse_inputs_fail_before_publishing_a_mesh() {
    for (addition, cause) in [
        ("*NSET,NSET=\"A\"\"B\"\nI.1\n", "matching pair"),
        ("*NSET,NSET=__RESERVED__\nI.1\n", "invalid Abaqus label"),
        ("*NSET,NSET=N,UNKNOWN\nI.1\n", "parameter"),
        ("*ELSET,ELSET=E,UNKNOWN\nI.1\n", "parameter"),
        ("*NSET\nI.1\n", "NSET is required"),
        ("*NSET,NSET=1BAD\nI.1\n", "invalid Abaqus label"),
        ("*NSET,NSET=N,INSTANCE\n1\n", "requires a value"),
        ("*NSET,NSET=N,INSTANCE=1BAD\n1\n", "invalid Abaqus label"),
        ("*NSET,NSET=N,GENERATE=YES\nI.1\n", "takes no value"),
        ("*NSET,NSET=N,ELSET=I.ALL,GENERATE\n", "no data or GENERATE"),
        ("*NSET,NSET=N,ELSET=I.ALL\n1\n", "no data or GENERATE"),
        ("*NSET,NSET=N,ELSET=MISSING\n", "must already exist"),
        ("*NSET,NSET=N\n", "requires member records"),
        ("*NSET,NSET=N,GENERATE,INSTANCE=I\n1\n", "range needs"),
        ("*NSET,NSET=N,GENERATE,INSTANCE=I\n0,4\n", "integer label"),
        ("*NSET,NSET=N,GENERATE,INSTANCE=I\n1,0\n", "integer label"),
        ("*NSET,NSET=N,GENERATE,INSTANCE=I\n1,4,0\n", "integer label"),
        ("*NSET,NSET=N,GENERATE,INSTANCE=I\n4,1\n", "range must increase"),
        ("*NSET,NSET=N,GENERATE,INSTANCE=I\n1,4,2\n", "range must increase"),
        ("*NSET,NSET=N,GENERATE,INSTANCE=I\n1,1000001\n", "exceeds 1000000"),
        ("*NSET,NSET=N\nI.999\n", "does not exist"),
        ("*NSET,NSET=N\nMISSING\n", "must already exist"),
        ("*NSET,NSET=N\nA.I.EXTRA.TIP\n", "invalid assembly-qualified"),
        ("*SURFACE,NAME=S,UNKNOWN\nI.1,S1\n", "parameter"),
        ("*SURFACE,NAME=S,TYPE=NODE\nI.1,S1\n", "only element surfaces"),
        ("*SURFACE\nI.1,S1\n", "NAME is required"),
        ("*SURFACE,NAME=1BAD\nI.1,S1\n", "invalid Abaqus label"),
        ("*SURFACE,NAME=S\nI.1,S1\n*SURFACE,NAME=S\nI.1,S1\n", "already defined"),
        ("*SURFACE,NAME=S\nI.1\n", "requires element target"),
        ("*SURFACE,NAME=S\nI.1,Q1\n", "face must be"),
        ("*SURFACE,NAME=S\nI.999,S1\n", "element does not exist"),
        ("*SURFACE,NAME=S\nMISSING,S1\n", "element set does not exist"),
        ("*SURFACE,NAME=S\n", "requires at least one face"),
        ("*ELEMENT,TYPE=C3D4\n2,1,2,3,4\n", "not valid at assembly level"),
    ] {
        let text = SINGLE.replace("*END ASSEMBLY\n", &format!("{addition}*END ASSEMBLY\n"));
        let error = abaqus::read_mesh(&text, "mesh", &Q::text("1 m"), &sha256_hex(text.as_bytes())).err().unwrap();
        assert!(error.cause.contains(cause), "expected {cause}: {error:?}");
        assert!(error.where_.is_some(), "{error:?}");
    }
}

#[test]
fn abaqus_quadratic_continuations_preserve_all_authored_nodes_and_first_record_origins() {
    for (kind, corners, edges) in [
        (
            "C3D10",
            vec![[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]],
            vec![[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]],
        ),
        (
            "C3D20",
            vec![
                [0., 0., 0.],
                [1., 0., 0.],
                [1., 1., 0.],
                [0., 1., 0.],
                [0., 0., 1.],
                [1., 0., 1.],
                [1., 1., 1.],
                [0., 1., 1.],
            ],
            vec![[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]],
        ),
    ] {
        let mut points = corners.clone();
        for [a, b] in edges {
            points.push(std::array::from_fn(|k| (corners[a][k] + corners[b][k]) / 2.));
        }
        let mut text = String::from("*NODE\n");
        for (i, p) in points.iter().enumerate() {
            text.push_str(&format!("{},{},{},{}\n", i + 1, p[0], p[1], p[2]));
        }
        text.push_str(&format!("*ELEMENT,TYPE={kind},ELSET=E\n90,"));
        for (i, chunk) in (1..=points.len()).collect::<Vec<_>>().chunks(4).enumerate() {
            if i > 0 {
                text.push('\n');
            }
            text.push_str(&chunk.iter().map(usize::to_string).collect::<Vec<_>>().join(","));
            if (i + 1) * 4 < points.len() {
                text.push(',');
            }
        }
        text.push_str("\n*NSET,NSET=TRAILING\n1,2,\n");
        let root = "*INCLUDE,INPUT=Quadratic.inp\n";
        let files = BTreeMap::from([("Quadratic.inp".into(), text)]);
        let converted = abaqus::convert_mesh_sources(
            root,
            "quadratic",
            "mesh",
            &Q::text("1 m"),
            Some("Root.inp"),
            &files,
            &sha256_hex(root.as_bytes()),
        )
        .unwrap();
        assert_eq!(converted.report.active_nodes as usize, points.len());
        let source = serde_json::to_value(&converted.commands[2]).unwrap();
        assert_eq!(source["mesher"]["elements"][0]["nodes"], json!((1..=points.len()).collect::<Vec<_>>()));
        assert_eq!(source["mesher"]["nodeSets"]["TRAILING"], json!([1, 2]));
    }
    let incomplete = "*NODE\n1,0,0,0\n*ELEMENT,TYPE=C3D10\n90,1,1,1,\n*HEADING\nunfinished\n";
    let error =
        abaqus::read_mesh(incomplete, "mesh", &Q::text("1 m"), &sha256_hex(incomplete.as_bytes())).err().unwrap();
    assert!(error.cause.contains("connectivity"), "{error:?}");
}

#[test]
fn abaqus_conversion_source_graph_rejects_live_quote_cycle_depth_and_bundle_errors() {
    let mut cases = vec![
        ("*INCLUDE,INPUT=\"a\"suffix\n".to_string(), BTreeMap::new(), "matching quotes"),
        ("*INCLUDE,INPUT=a.inp,PASSWORD=x\n".into(), BTreeMap::new(), "parameter"),
        (
            "*INCLUDE,INPUT=a.inp\n".into(),
            BTreeMap::from([("a.inp".into(), "*INCLUDE,INPUT=Main.inp\n".into())]),
            "cycle",
        ),
        (SINGLE.into(), BTreeMap::from([("unused.inp".into(), "*NODE".into())]), "end in LF"),
        (SINGLE.into(), BTreeMap::from([("../unused.inp".into(), String::new())]), "relative submission"),
        (SINGLE.into(), (0..129).map(|i| (format!("f{i}.inp"), String::new())).collect(), "128"),
        (
            "*NODE,INPUT=Nodes.inp\n".into(),
            BTreeMap::from([("Nodes.inp".into(), "1,0,0,0\n2,∞,0,0\n".into())]),
            "ASCII",
        ),
    ];
    let chain = (0..17).map(|i| (format!("f{i}.inp"), format!("*INCLUDE,INPUT=f{}.inp\n", i + 1))).collect();
    cases.push(("*INCLUDE,INPUT=f0.inp\n".into(), chain, "nesting"));
    let comment = format!("**{}\n", "x".repeat(1024 * 1024 - 3));
    cases.push(("*INCLUDE,INPUT=a.inp\n".repeat(17), BTreeMap::from([("a.inp".into(), comment.clone())]), "expanded"));
    cases.push((
        "*NODE,INPUT=Nodes.inp\n".repeat(17),
        BTreeMap::from([("Nodes.inp".into(), format!("{comment}1,0,0,0\n"))]),
        "expanded",
    ));
    for (text, files, cause) in cases {
        let error = abaqus::convert_mesh_sources(
            &text,
            "adverse",
            "mesh",
            &Q::text("1 m"),
            Some("Main.inp"),
            &files,
            &sha256_hex(text.as_bytes()),
        )
        .err()
        .unwrap();
        assert!(error.cause.contains(cause), "expected {cause}: {error:?}");
        assert!(error.where_.is_some(), "{error:?}");
    }
}

#[test]
fn abaqus_common_admission_rejects_cross_block_duplicates_and_local_record_contracts() {
    let mesh = include_str!("../fixtures/abaqus/sparse-label-tet.inp");
    for text in [
        format!("{mesh}*NODE\n10,0,0,0\n"),
        format!("{mesh}*SURFACE,NAME=BAD,TYPE\n900,S1\n"),
        format!("{mesh}*NSET,NSET=BAD,UNKNOWN\n10\n"),
        format!("{mesh}*ELSET,ELSET=BAD,UNKNOWN\n900\n"),
        format!("{mesh}*NSET,NSET=BAD\n{}\n", vec!["10"; 18].join(",")),
        "*ELEMENT,TYPE=C3D8R\n1,1,2,3,4,5,6,7,8\n".into(),
    ] {
        let error = abaqus::read_mesh(&text, "mesh", &Q::text("1 m"), &sha256_hex(text.as_bytes())).err().unwrap();
        assert!(error.where_.is_some(), "{error:?}");
    }
    let text = format!("{mesh}*SURFACE,NAME=MISSING\n999,S1\n");
    let files = BTreeMap::from([("Mesh.inp".into(), text)]);
    let root = "*INCLUDE,INPUT=Mesh.inp\n";
    let error = abaqus::convert_mesh_sources(
        root,
        "mesh",
        "body",
        &Q::text("1 m"),
        Some("Root.inp"),
        &files,
        &sha256_hex(root.as_bytes()),
    )
    .unwrap_err();
    assert!(error.where_.as_deref().unwrap().starts_with("Mesh.inp: line "), "{error:?}");
    assert!(error.cause.contains("surface element is not defined"), "{error:?}");
}

#[test]
fn abaqus_scoped_history_and_reference_errors_retain_their_source_intent() {
    let bar = include_str!("../fixtures/abaqus-static/bar-hex-mm-n.inp");
    for (text, cause) in [
        (SINGLE.replace("*END PART\n", "*STEP,NAME=S\n*END PART\n"), "STEP must be outside"),
        (SINGLE.replace("*END PART\n", "*MATERIAL,NAME=M\n*END PART\n"), "part-level capability"),
        (format!("{SINGLE}*STEP,NAME=S\n*NODE\n9,0,0,0\n"), "precede all Steps"),
        (bar.replace("ROOT,1,3", "A..ROOT,1,3"), "invalid Abaqus label"),
        (bar.replace("*CLOAD\nTIP,1,250", "*DSLOAD\nA..SURFACE,P,1"), "invalid Abaqus label"),
    ] {
        let mut e = engine();
        let query=serde_json::from_value(json!({"query":"query.convertAbaqus","text":text,"name":"adverse","body":"body","mode":"static","unitLength":"1 mm","unitForce":"1 N","sha256":sha256_hex(text.as_bytes())})).unwrap();
        let before = e.export_file();
        let error = e.query(query).unwrap_err();
        assert!(error.cause.contains(cause), "expected {cause}: {error:?}");
        assert_eq!(e.export_file(), before);
    }
}

#[test]
fn abaqus_empty_parts_allow_instance_authored_mesh_and_assembly_node_duplicates_are_rejected() {
    let text = SINGLE
        .replace("*PART,NAME=P\n*NODE", "*PART,NAME=P\n*END PART\n*ASSEMBLY,NAME=A\n*INSTANCE,NAME=I,PART=P\n*NODE");
    let text = text.replace("*END PART\n*ASSEMBLY,NAME=A\n*INSTANCE,NAME=I,PART=P\n*END INSTANCE", "*END INSTANCE");
    let parsed = abaqus::read_mesh(&text, "mesh", &Q::text("1 m"), &sha256_hex(text.as_bytes())).unwrap();
    assert_eq!(parsed.source.nodes.len(), 4);
    assert_eq!(parsed.source.elements.len(), 1);
    let extra = "*NODE\n5,2,0,0\n*NODE\n5,3,0,0\n";
    let bad = SINGLE.replace("*END ASSEMBLY\n", &format!("{extra}*END ASSEMBLY\n"));
    let error = abaqus::read_mesh(&bad, "mesh", &Q::text("1 m"), &sha256_hex(bad.as_bytes())).err().unwrap();
    assert!(error.cause.contains("assembly node label is already defined"), "{error:?}");
}

fn membership_expansion(base_aliases: usize, instance_aliases: usize, poison_second: bool) -> String {
    let mut text = String::from("*PART,NAME=P\n*NODE,NSET=ALL\n1,0,0,0\n2,1,0,0\n3,0,1,0\n4,0,0,1\n");
    for id in 5..=400 {
        text.push_str(&format!("{id},{id},0,0\n"));
    }
    text.push_str("*ELEMENT,TYPE=C3D4,ELSET=E\n1,1,2,3,4\n");
    for i in 0..base_aliases {
        text.push_str(&format!("*NSET,NSET=B{i}\nALL\n"));
    }
    text.push_str("*END PART\n*ASSEMBLY,NAME=A\n");
    for instance in ["FIRST", "SECOND"] {
        text.push_str(&format!("*INSTANCE,NAME={instance},PART=P\n"));
        for i in 0..instance_aliases {
            text.push_str(&format!("*NSET,NSET=X{i}\nALL\n"));
        }
        if poison_second && instance == "SECOND" {
            text.push_str("*NSET,NSET=POISON\nUNDEFINED\n");
        }
        text.push_str("*END INSTANCE\n");
    }
    text.push_str("*END ASSEMBLY\n");
    text
}

#[test]
fn abaqus_real_instance_membership_bounds_are_checked_before_copy_and_after_instance_additions() {
    for text in [membership_expansion(1500, 0, true), membership_expansion(500, 1000, false)] {
        let error = abaqus::convert_mesh_sources(
            &text,
            "budget",
            "mesh",
            &Q::text("1 m"),
            Some("Budget.inp"),
            &BTreeMap::new(),
            &sha256_hex(text.as_bytes()),
        )
        .unwrap_err();
        assert_eq!(error.cause, "expanded assembly exceeds 1000000 memberships");
        assert!(error.where_.as_deref().unwrap().starts_with("Budget.inp: line "), "{error:?}");
        assert!(error.where_.as_deref().unwrap().ends_with("*INSTANCE memberships"), "{error:?}");
    }
}

#[test]
fn abaqus_repeated_part_presentation_obeys_the_public_retained_utf8_bound() {
    let mut text = String::from("*PART,NAME=P\n*HEADING\n");
    for _ in 0..8192 {
        text.push_str(&"h".repeat(256));
        text.push('\n');
    }
    text.push_str(
        "*NODE\n1,0,0,0\n2,1,0,0\n3,0,1,0\n4,0,0,1\n*ELEMENT,TYPE=C3D4\n1,1,2,3,4\n*END PART\n*ASSEMBLY,NAME=A\n",
    );
    for i in 0..33 {
        text.push_str(&format!("*INSTANCE,NAME=I{i},PART=P\n*END INSTANCE\n"));
    }
    text.push_str("*END ASSEMBLY\n");
    let error = abaqus::convert_mesh_sources(
        &text,
        "metadata",
        "mesh",
        &Q::text("1 m"),
        Some("Metadata.inp"),
        &BTreeMap::new(),
        &sha256_hex(text.as_bytes()),
    )
    .unwrap_err();
    assert_eq!(error.cause, "expanded presentation exceeds 67108864 UTF-8 bytes");
    assert!(error.where_.as_deref().unwrap().starts_with("Metadata.inp: line "), "{error:?}");
}

#[test]
fn abaqus_outer_collection_part_and_instance_errors_are_reached_by_public_reads() {
    let mesh = include_str!("../fixtures/abaqus/sparse-label-tet.inp");
    let surface_override = SINGLE
        .replace("*END PART\n", "*SURFACE,NAME=FACE\nALL,S1\n*END PART\n")
        .replace("*INSTANCE,NAME=I,PART=P\n", "*INSTANCE,NAME=I,PART=P\n*SURFACE,NAME=FACE\nALL,S1\n");
    let transform_overflow = SINGLE
        .replace("*ELEMENT,TYPE", "5,1e308,0,0\n*ELEMENT,TYPE")
        .replace("*INSTANCE,NAME=I,PART=P\n", "*INSTANCE,NAME=I,PART=P\n1e308,0,0\n");
    for (text, cause) in [
        ("1,0\n".into(), "data must follow"),
        ("*NSET,NSET=N\n\"unterminated\n".into(), "unterminated"),
        (ASSEMBLY.replace("0,0,0,0,0,1,90", "0,0,0,0,0,1,NaN"), "finite numeric"),
        (SINGLE.replace("2,1,0,0", "2,NaN,0,0"), "finite numeric"),
        (format!("*PREPRINT,ECHO=BAD\n{SINGLE}"), "PREPRINT values"),
        (surface_override, "cannot override inherited"),
        (transform_overflow, "transform overflows"),
        (format!("{mesh}*SURFACE,NAME=BAD,TYPE=NODE\n900,S1\n"), "TYPE=ELEMENT"),
        (SINGLE.replace("*END ASSEMBLY\n", "*NODE\n5,NaN,0,0\n*END ASSEMBLY\n"), "finite numeric"),
        (SINGLE.replace("*END ASSEMBLY\n", "*NSET,NSET=N,ELSET\n*END ASSEMBLY\n"), "requires a value"),
        (SINGLE.replace("*END ASSEMBLY\n", "*NSET,NSET=N,ELSET=A..E\n*END ASSEMBLY\n"), "invalid Abaqus label"),
        (SINGLE.replace("*END ASSEMBLY\n", "*NSET,NSET=N\nI.0\n*END ASSEMBLY\n"), "integer label"),
        (SINGLE.replace("*END ASSEMBLY\n", "*SURFACE,NAME=S,TYPE\nI.1,S1\n*END ASSEMBLY\n"), "requires a value"),
        (SINGLE.replace("*END ASSEMBLY\n", "*SURFACE,NAME=S\nA..E,S1\n*END ASSEMBLY\n"), "invalid Abaqus label"),
    ] {
        let error = abaqus::read_mesh(&text, "mesh", &Q::text("1 m"), &sha256_hex(text.as_bytes())).err().unwrap();
        assert!(error.cause.contains(cause), "expected {cause}: {error:?}");
    }
    let mut text = String::from("*HEADING\n");
    text.push_str(&"x\n".repeat(1_000_001));
    let error = abaqus::read_mesh(&text, "mesh", &Q::text("1 m"), &sha256_hex(text.as_bytes())).err().unwrap();
    assert_eq!(error.cause, "source exceeds 1000000 data records");
    let with_source = SINGLE.replace("*END ASSEMBLY\n", "*NODE,NSET=FREE\n5,2,0,0\n*END ASSEMBLY\n");
    let converted = abaqus::convert_mesh_sources(
        &with_source,
        "nodes",
        "mesh",
        &Q::text("1 m"),
        Some("Assembly.inp"),
        &BTreeMap::new(),
        &sha256_hex(with_source.as_bytes()),
    )
    .unwrap();
    assert_eq!(converted.report.source_nodes, 5);
}

#[test]
fn abaqus_assembly_operations_preserve_the_cumulative_membership_admission() {
    let base = membership_expansion(2498, 0, false);
    let part = base.split_once("*END PART").unwrap().0;
    // 400*(ALL +2498 aliases) +one ELSET member +399 generated members =1,000,000.
    let root = format!(
        "{part}*NSET,NSET=PAD,GENERATE\n1,399\n*END PART\n*ASSEMBLY,NAME=A\n*INSTANCE,NAME=I,PART=P\n*END INSTANCE\n"
    );
    for addition in [
        "*NODE,NSET=EXTRA\n1,2,0,0\n",
        "*NSET,NSET=EXTRA,ELSET=I.E\n",
        "*NSET,NSET=EXTRA\nI.1\n",
        "*NSET,NSET=EXTRA\nI.ALL\n",
        "*SURFACE,NAME=EXTRA\nI.1,S1\n",
    ] {
        let text = format!("{root}{addition}*END ASSEMBLY\n");
        let error = abaqus::convert_mesh_sources(
            &text,
            "quota",
            "mesh",
            &Q::text("1 m"),
            Some("AtCap.inp"),
            &BTreeMap::new(),
            &sha256_hex(text.as_bytes()),
        )
        .unwrap_err();
        assert_eq!(error.cause, "expanded Set declarations exceed 1000000 memberships");
        assert!(error.where_.as_deref().unwrap().starts_with("AtCap.inp: line "), "{error:?}");
    }
}

#[test]
fn abaqus_assembly_nodes_cannot_exceed_the_expanded_entity_limit() {
    let mut text = String::from("*PART,NAME=P\n*NODE\n1,0,0,0\n2,1,0,0\n3,0,1,0\n4,0,0,1\n");
    for id in 5..=2500 {
        text.push_str(&format!("{id},{id},0,0\n"));
    }
    text.push_str("*ELEMENT,TYPE=C3D4\n1,1,2,3,4\n*END PART\n*ASSEMBLY,NAME=A\n");
    for i in 0..100 {
        text.push_str(&format!("*INSTANCE,NAME=I{i},PART=P\n*END INSTANCE\n"));
    }
    text.push_str("*NODE\n1,2,0,0\n*END ASSEMBLY\n");
    let error = abaqus::read_mesh(&text, "mesh", &Q::text("1 m"), &sha256_hex(text.as_bytes())).err().unwrap();
    assert_eq!(error.cause, "expanded assembly exceeds 250000 nodes");
}

#[test]
fn abaqus_analysis_inheritance_and_all_later_scopes_share_one_keyword_budget() {
    for where_extra in ["inherited", "instance", "assembly", "history"] {
        let mut text = String::from(
            "*PART,NAME=P\n*NODE\n1,0,0,0\n2,1,0,0\n3,0,1,0\n4,0,0,1\n*ELEMENT,TYPE=C3D4,ELSET=E\n1,1,2,3,4\n",
        );
        let sections = if where_extra == "inherited" { 125001 } else { 125000 };
        text.push_str(&"*SOLID SECTION,ELSET=E,MATERIAL=M\n".repeat(sections));
        text.push_str(
            "*END PART\n*ASSEMBLY,NAME=A\n*INSTANCE,NAME=FIRST,PART=P\n*END INSTANCE\n*INSTANCE,NAME=SECOND,PART=P\n2,0,0\n",
        );
        if where_extra == "instance" {
            text.push_str("*BOUNDARY\n1,1,0\n");
        }
        text.push_str("*END INSTANCE\n");
        if where_extra == "assembly" {
            text.push_str("*BOUNDARY\nFIRST.1,1,0\n");
        }
        text.push_str("*END ASSEMBLY\n");
        if where_extra == "history" {
            text.push_str("*STEP,NAME=S\n*STATIC\n*END STEP\n");
        }
        let mut e = engine();
        let before = e.export_file();
        let query=serde_json::from_value(json!({"query":"query.convertAbaqus","text":text,"name":"quota","body":"body","mode":"static","unitLength":"1 m","unitForce":"1 N","sha256":sha256_hex(text.as_bytes()),"sourceName":"Analysis.inp"})).unwrap();
        let error = e.query(query).unwrap_err();
        assert_eq!(error.cause, "source exceeds 250000 keyword records", "{where_extra}: {error:?}");
        assert!(error.where_.as_deref().unwrap().starts_with("Analysis.inp: line "), "{error:?}");
        assert_eq!(e.export_file(), before);
    }
}
