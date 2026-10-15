//! Independent Abaqus mesh fixtures, checked conversion, replay and atomic read failures.
//! Part of the one registry integration binary, rather than another generic instantiation.

use super::{cantilever, engine, ok, run};
use femlab_engine::hash::sha256_hex;
use femlab_engine::query::{AbaqusConversion, Query};
use femlab_engine::{Engine, ErrorCode, NoClock};
use proptest::prelude::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;

const TET: &str = include_str!("../fixtures/abaqus/sparse-label-tet.inp");
const HEX: &str = include_str!("../fixtures/abaqus/brick-sets.inp");
const FAR: &str = include_str!("../fixtures/abaqus/far-unused-tet.inp");
const ZERO_TET: &str = include_str!("../fixtures/abaqus/signed-zero-tet.inp");
const ZERO_HEX: &str = include_str!("../fixtures/abaqus/signed-zero-hex.inp");

fn request(text: &str, scale: &str) -> Query {
    serde_json::from_value(json!({
        "query": "query.convertAbaqus", "text": text, "name": "Abaqus fixture",
        "body": "part", "mode": "mesh", "unitLength": scale, "sha256": sha256_hex(text.as_bytes()),
    }))
    .unwrap()
}

fn converted(e: &mut Engine, text: &str, scale: &str) -> AbaqusConversion {
    let result = e.query(request(text, scale)).unwrap();
    // Serializing and decoding exercises the host-visible response shape without a fallback arm.
    serde_json::from_value(serde_json::to_value(result).unwrap()).unwrap()
}

fn read(e: &mut Engine, query: Value) -> Value {
    serde_json::to_value(e.query(serde_json::from_value(query).unwrap()).unwrap()).unwrap()
}

fn install(e: &mut Engine, converted: &AbaqusConversion) {
    for command in &converted.commands {
        run(e, &serde_json::to_string(command).unwrap()).unwrap();
    }
    ok(e, r#"{"cmd":"model.setUnits","units":{"length":"m","force":"N","stress":"Pa"}}"#);
}

#[test]
fn abaqus_sparse_labels_sets_faces_and_si_replay_have_independent_oracles() {
    let mut e = engine();
    let conversion = converted(&mut e, TET, "1 m");
    assert_eq!(conversion.commands.len(), 3);
    assert_eq!(conversion.report.source_nodes, 5);
    assert_eq!(conversion.report.active_nodes, 4);
    assert_eq!(conversion.report.source_elements, 1);
    assert_eq!(conversion.report.source_labels.nodes, [10, 20, 40, 70]);
    assert_eq!(conversion.report.source_labels.elements, [900]);
    assert_eq!(conversion.report.source_labels.unused_nodes, [99]);
    assert!(!conversion.report.analysis_configured);
    assert!(!conversion.report.preprint[0]["ECHO"]);
    assert!(conversion.report.preprint[0]["MODEL"]);
    let source = serde_json::to_value(&conversion.commands[2]).unwrap();
    assert_eq!(source["order"], 1);
    assert_eq!(source["formulation"], "full");
    assert_eq!(source["mesher"]["kind"], "imported");
    assert_eq!(source["mesher"]["nodeSets"]["SAME"], json!([10, 20, 40]));
    assert_eq!(source["mesher"]["nodeSets"]["CAPTURE"], json!([10, 40]));
    assert_eq!(source["mesher"]["nodeSets"]["FROM_ELEMENTS"], json!([10, 20, 40, 70]));
    assert_eq!(source["mesher"]["elementSets"]["SAME"], json!([900]));
    assert_eq!(source["mesher"]["provenance"]["sha256"], sha256_hex(TET.as_bytes()));
    assert_eq!(source["mesher"]["provenance"]["conversionVersion"], "abaqus-mesh/2");
    install(&mut e, &conversion);
    let model = read(&mut e, json!({"query":"query.model"}));
    assert_eq!(model["bodies"][0]["name"], "part");
    assert!((model["bodies"][0]["measure"]["value"].as_f64().unwrap() - 1.0 / 6.0).abs() < 1e-14);
    let mesh = read(&mut e, json!({"query":"query.mesh"}));
    assert_eq!(mesh["nodes"], 4);
    assert_eq!(mesh["elements"], 1);
    // Vendor S tables plus a closed-form triangle centroid, independently of the reader.
    let centroids = [
        [1.0 / 3.0, 1.0 / 3.0, 0.0],
        [1.0 / 3.0, 0.0, 1.0 / 3.0],
        [1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0],
        [0.0, 1.0 / 3.0, 1.0 / 3.0],
    ];
    for (face, expected) in centroids.iter().enumerate() {
        let set = read(&mut e, json!({"query":"query.set","name":format!("part.surface_FACE{}",face+1)}));
        assert_eq!(set["count"], 1);
        for k in 0..3 {
            assert!((set["centroid"][k]["value"].as_f64().unwrap() - expected[k]).abs() < 1e-14);
        }
    }
    let file = e.export_file();
    for threads in [1, 3] {
        let mut replay = Engine::new(None, Box::new(NoClock), threads);
        let hashes = pollster::block_on(replay.replay(&file.journal.entries, true, true)).unwrap();
        assert_eq!(hashes.last(), Some(&e.model_hash()));
        assert_eq!(replay.export_file().model, file.model);
        assert_eq!(replay.mesh().unwrap().mesh, e.mesh().unwrap().mesh);
    }
}

#[test]
fn abaqus_hex_generate_continuation_crlf_and_every_s_face_are_checked() {
    let mut e = engine();
    let conversion = converted(&mut e, HEX, "1 mm");
    assert_eq!(conversion.report.source_nodes, 8);
    assert_eq!(conversion.report.active_nodes, 8);
    assert!(conversion.report.source_labels.unused_nodes.is_empty());
    assert_eq!(conversion.report.unit_length.si().unwrap(), 0.001);
    let source = serde_json::to_value(&conversion.commands[2]).unwrap();
    assert_eq!(source["mesher"]["nodeSets"]["BASE"], json!([1, 5, 9, 13]));
    assert_eq!(source["mesher"]["nodeSets"]["ONE"], json!([1]));
    assert_eq!(source["mesher"]["elementSets"]["COPY"], json!([100]));
    install(&mut e, &conversion);
    let model = read(&mut e, json!({"query":"query.model"}));
    assert!((model["bodies"][0]["measure"]["value"].as_f64().unwrap() - 6.0).abs() < 1e-13);
    for (name, expected) in [
        ("BOTTOM", [0.5, 1.0, 0.0]),
        ("TOP", [0.5, 1.0, 3.0]),
        ("FRONT", [0.5, 0.0, 1.5]),
        ("RIGHT", [1.0, 1.0, 1.5]),
        ("BACK", [0.5, 2.0, 1.5]),
        ("LEFT", [0.0, 1.0, 1.5]),
    ] {
        let set = read(&mut e, json!({"query":"query.set","name":format!("part.surface_{name}")}));
        assert_eq!(set["count"], 1);
        for k in 0..3 {
            assert!((set["centroid"][k]["value"].as_f64().unwrap() - expected[k]).abs() < 1e-13);
        }
    }
    let crlf = HEX.replace('\n', "\r\n");
    let converted_crlf = converted(&mut e, &crlf, "1 mm");
    let mut lf_commands = serde_json::to_value(conversion.commands).unwrap();
    let mut crlf_commands = serde_json::to_value(converted_crlf.commands).unwrap();
    lf_commands[2]["mesher"]["provenance"]["sha256"] = Value::Null;
    crlf_commands[2]["mesher"]["provenance"]["sha256"] = Value::Null;
    assert_eq!(lf_commands, crlf_commands);
}

#[test]
fn abaqus_far_unused_node_is_authored_but_never_inflates_physical_bounds() {
    let mut e = engine();
    let conversion = converted(&mut e, FAR, "1 m");
    assert_eq!(conversion.report.source_labels.unused_nodes, [99]);
    let bounds: Vec<_> = conversion.report.bbox.iter().map(|q| q.si().unwrap()).collect();
    assert_eq!(bounds, [0.0, 0.0, 0.0, 1.0, 1.0, 1.0]);
    install(&mut e, &conversion);
    let far = read(&mut e, json!({"query":"query.set","name":"part.nset_FAR"}));
    assert_eq!(far["count"], 1);
    for k in 0..6 {
        assert_eq!(far["bbox"][k]["value"], 1_000_000.0);
    }
    for query in ["query.model", "query.mesh"] {
        let result = read(&mut e, json!({"query":query}));
        let bbox = if query == "query.model" { &result["bodies"][0]["bbox"] } else { &result["bbox"] };
        for (k, value) in bounds.iter().enumerate() {
            assert_eq!(bbox[k]["value"], *value);
        }
    }
    assert_eq!(e.mesh().unwrap().mesh.n_nodes(), 4);
}

#[test]
fn abaqus_signed_zero_coordinates_are_portable_without_changing_the_source_digest() {
    for (text, scale, expected_volume) in [(ZERO_TET, "1 m", 1.0 / 6.0), (ZERO_HEX, "1 mm", 6.0)] {
        let mut e = engine();
        let conversion = converted(&mut e, text, scale);
        let source = serde_json::to_value(&conversion.commands[2]).unwrap();
        let mut zeros = 0;
        for node in source["mesher"]["nodes"].as_array().unwrap() {
            for coordinate in node["at"].as_array().unwrap() {
                let value = coordinate["value"].as_f64().unwrap();
                if value == 0.0 {
                    assert_eq!(value.to_bits(), 0.0f64.to_bits());
                    zeros += 1;
                }
            }
        }
        assert_eq!(zeros, 12);
        assert_eq!(source["mesher"]["provenance"]["sha256"], sha256_hex(text.as_bytes()));
        assert_eq!(conversion.report.sha256, sha256_hex(text.as_bytes()));
        install(&mut e, &conversion);
        let model = read(&mut e, json!({"query":"query.model"}));
        assert!((model["bodies"][0]["measure"]["value"].as_f64().unwrap() - expected_volume).abs() < 1e-13);
    }
}

#[test]
fn abaqus_conversion_is_a_read_even_on_an_existing_solved_model() {
    let mut e = engine();
    cantilever(&mut e);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":1,"ny":1,"nz":1}}}"#);
    ok(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
    let file = e.export_file();
    let result = read(&mut e, json!({"query":"query.result","step":"static"}));
    converted(&mut e, TET, "1 m");
    assert_eq!(e.export_file(), file);
    assert_eq!(read(&mut e, json!({"query":"query.result","step":"static"})), result);
    let rejected = e.query(request("*MATERIAL,NAME=STEEL\n", "1 m")).unwrap_err();
    assert_eq!(rejected.code, ErrorCode::Unsupported);
    assert_eq!(e.export_file(), file);
    assert_eq!(read(&mut e, json!({"query":"query.result","step":"static"})), result);
}

#[test]
fn abaqus_rejects_unsupported_intent_instead_of_silently_dropping_it() {
    let mut e = engine();
    for keyword in [
        "SYSTEM",
        "TRANSFORM,NSET=N",
        "STEP",
        "STATIC",
        "ELASTIC",
        "MATERIAL,NAME=M",
        "SOLID SECTION,ELSET=E,MATERIAL=M",
        "BOUNDARY",
        "CLOAD",
        "DLOAD",
        "OUTPUT",
        "END STEP",
        "NOD",
    ] {
        let text = format!("*{keyword}\n");
        let rejected = e.query(request(&text, "1 m")).unwrap_err();
        assert_eq!(rejected.code, ErrorCode::Unsupported, "{keyword}: {rejected:?}");
        assert!(rejected.where_.as_deref().unwrap().starts_with("line 1 *"));
        assert!(rejected.suggestion.is_some());
    }
    // Structural keywords are supported; incomplete definitions and missing bundles are malformed.
    for keyword in ["INCLUDE,INPUT=other.inp", "PART,NAME=P", "ASSEMBLY,NAME=A", "INSTANCE,NAME=I,PART=P"] {
        let text = format!("*{keyword}\n");
        assert_eq!(e.query(request(&text, "1 m")).unwrap_err().code, ErrorCode::Schema);
    }
    for keyword in [
        "NODE,SYSTEM=C",
        "NODE,INPUT=nodes.dat",
        "NODE,FILE=nodes",
        "ELEMENT,TYPE=C3D4R",
        "ELEMENT,TYPE=C3D8R",
        "ELEMENT,TYPE=C3D10",
        "NSET,NSET=N,UNSORTED",
        "ELSET,ELSET=E,UNSORTED",
        "SURFACE,NAME=S,TYPE=NODE",
        "SURFACE,NAME=S",
        "PREPRINT,ECHO=MAYBE",
    ] {
        let text = format!("*{keyword}\n");
        assert!(e.query(request(&text, "1 m")).is_err(), "{keyword}");
    }
}

#[test]
fn abaqus_keyword_and_record_guards_report_the_original_input_location() {
    let mut e = engine();
    let before = e.export_file();
    for keyword in [
        "HEADING,BOGUS",
        "PREPRINT,BOGUS=YES",
        "PREPRINT,ECHO",
        "NODE,SYSTEM",
        "NODE,NSET",
        "NODE,NSET=a.b",
        "ELEMENT,TYPE=C3D4,BOGUS",
        "ELEMENT,TYPE",
        "ELEMENT,TYPE=C3D4,ELSET",
        "ELEMENT,TYPE=C3D4,ELSET=a.b",
        "SURFACE,TYPE=ELEMENT,BOGUS",
        "SURFACE,TYPE=ELEMENT,NAME",
        "SURFACE,TYPE=ELEMENT,NAME=a.b",
        "NSET,NSET",
        "NSET,NSET=N,GENERATE=YES",
        "NSET,NSET=N,ELSET",
        "NSET,NSET=N,ELSET=a.b",
    ] {
        let text = format!("*{keyword}\n");
        let rejected = e.query(request(&text, "1 m")).unwrap_err();
        let name = keyword.split(',').next().unwrap();
        assert!(rejected.where_.as_deref().unwrap().starts_with(&format!("line 1 *{name} ")), "{rejected:?}");
    }
    for text in ["*NODE\n1\n", "*NODE,\n∞\n", "*HEADING\n∞\n", "*NODE\n*HEADING\n", "*NODE,\n"] {
        let rejected = e.query(request(text, "1 m")).unwrap_err();
        assert!(rejected.where_.as_deref().unwrap().starts_with("line "), "{rejected:?}");
    }
    for addition in [
        "*ELEMENT,TYPE=C3D4\n0,40,10,70,20\n",
        "*ELEMENT,TYPE=C3D4\n900,40,10,70,20\n",
        "*ELEMENT,TYPE=C3D4\n901,0,10,70,20\n",
        "*NSET,NSET=BAD,GENERATE\n1\n",
        "*NSET,NSET=BAD,GENERATE\n0,10\n",
        "*NSET,NSET=BAD,GENERATE\n1,0\n",
        "*NSET,NSET=BAD\n1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1\n",
        "*NSET,NSET=BAD\n0\n",
        "*NSET,NSET=BAD\nbad.name\n",
        "*SURFACE,NAME=BAD,TYPE=ELEMENT\n900\n",
        "*SURFACE,NAME=BAD,TYPE=ELEMENT\n0,S1\n",
        "*SURFACE,NAME=BAD,TYPE=ELEMENT\nbad.name,S1\n",
    ] {
        let rejected = e.query(request(&format!("{TET}{addition}"), "1 m")).unwrap_err();
        assert!(rejected.where_.as_deref().unwrap().starts_with("line "), "{rejected:?}");
    }
    assert_eq!(e.export_file(), before);
}

#[test]
fn abaqus_malformed_labels_memberships_connectivity_and_source_geometry_locate_original_records() {
    let mut e = engine();
    let cases = [
        TET.replace("40, 0\n", "40, 0\n40, 0\n"),
        TET.replace("900, 40, 10, 70, 20", "900, 40, 40, 70, 20"),
        TET.replace("900, 40, 10, 70, 20", "900, 40, 10, 70, 999"),
        TET.replace("900, 40, 10, 70, 20", "900, 40, 10, 70"),
        TET.replace("40, 0\n", "0, 0\n"),
        TET.replace("40, 0\n", "1000000000, 0\n"),
        TET.replace("10, 1D0,", "10, 1D999,"),
        TET.replace("10, 1D0,", "10,,"),
        TET.replace("NSET=SAME", "NSET=part.SAME"),
        TET.replace("SAME\n*NSET", "UNDEFINED\n*NSET"),
        TET.replace("900, S4", "900, S5"),
        TET.replace("900, S4", "999, S4"),
        TET.replace("900, S4", "900, S0"),
        TET.replace("900, S4", "900, SPOS"),
        TET.replace("*NODE, NSET=AUTHORED, SYSTEM=R", "*NODE,NSET=AUTHORED,NSET=DUPLICATE"),
    ];
    for text in &cases {
        let rejected = e.query(request(text, "1 m")).unwrap_err();
        assert!(rejected.where_.as_deref().unwrap().starts_with("line "), "{rejected:?}");
    }
    let inverted = TET.replace("900, 40, 10, 70, 20", "900, 40, 70, 10, 20");
    let rejected = e.query(request(&inverted, "1 m")).unwrap_err();
    assert!(rejected.where_.unwrap().contains("mesher.elements[900]"));
    for addition in [
        "*NSET,NSET=N,GENERATE\n1,9,0\n",
        "*NSET,NSET=N,GENERATE\n1,9,3\n",
        "*NSET,NSET=N,GENERATE\n9,1,1\n",
        "*NSET,NSET=N\nUNDEFINED\n",
        "*NSET,NSET=N,ELSET=UNDEFINED\n",
        "*ELSET,ELSET=N\nUNDEFINED\n",
        "*NSET,NSET=N,GENERATE,ELSET=SAME\n",
        "*NSET,NSET=N,ELSET=SAME\n10\n",
        "*SURFACE,NAME=FACE1,TYPE=ELEMENT\n900,S1\n",
        "*SURFACE,NAME=UNDEFINED_ELSET,TYPE=ELEMENT\nUNDEFINED,S1\n",
        "*NSET,NSET=BAD\n999\n",
        "*ELSET,ELSET=BAD\n999\n",
        "*ELSET,ELSET=BAD\n999\n*NSET,NSET=DERIVED,ELSET=BAD\n",
    ] {
        let text = format!("{TET}{addition}");
        assert!(e.query(request(&text, "1 m")).is_err(), "{addition}");
    }
}

#[test]
fn abaqus_bounds_hash_units_and_expanded_memberships_fail_before_publication() {
    let mut e = engine();
    let before = e.export_file();
    for scale in ["0 m", "-1 m", "1 N"] {
        assert!(e.query(request(TET, scale)).is_err());
    }
    for text in ["", "*HEADING\n", "*NODE\n1,0\n", "1,0\n", "*NODE\n", "*PREPRINT\nDATA\n"] {
        assert!(e.query(request(text, "1 m")).is_err(), "{text}");
    }
    let missing_lf = TET.trim_end_matches('\n');
    let rejected = e.query(request(missing_lf, "1 m")).unwrap_err();
    assert!(rejected.where_.as_deref().unwrap().ends_with(" *INPUT line ending"));
    for digest in ["0".repeat(63), "A".repeat(64)] {
        let mut invalid = serde_json::to_value(request(TET, "1 m")).unwrap();
        invalid["sha256"] = json!(digest);
        let rejected = e.query(serde_json::from_value(invalid).unwrap()).unwrap_err();
        assert_eq!(rejected.where_.as_deref(), Some("sha256"));
    }
    let mut invalid_body = serde_json::to_value(request(TET, "1 m")).unwrap();
    invalid_body["body"] = json!("part.bad");
    let rejected = e.query(serde_json::from_value(invalid_body).unwrap()).unwrap_err();
    assert_eq!(rejected.where_.as_deref(), Some("body"));
    for name in [String::from(" \t"), "é".repeat(513)] {
        let mut invalid_name = serde_json::to_value(request(TET, "1 m")).unwrap();
        invalid_name["name"] = json!(name);
        let rejected = e.query(serde_json::from_value(invalid_name).unwrap()).unwrap_err();
        assert_eq!(rejected.where_.as_deref(), Some("name"));
    }
    let mut wrong = serde_json::to_value(request(TET, "1 m")).unwrap();
    wrong["sha256"] = json!("0".repeat(64));
    let rejected = e.query(serde_json::from_value(wrong).unwrap()).unwrap_err();
    assert_eq!(rejected.where_.as_deref(), Some("sha256"));
    let oversized = "a".repeat(femlab_engine::io::abaqus::MAX_INPUT_BYTES + 1);
    let rejected = e.query(request(&oversized, "1 m")).unwrap_err();
    assert_eq!(rejected.where_.as_deref(), Some("text"));
    let memberships = format!("{TET}*NSET,NSET=TOO_MANY,GENERATE\n1,1000001,1\n");
    let rejected = e.query(request(&memberships, "1 m")).unwrap_err();
    assert!(rejected.cause.contains("1000000"));
    assert_eq!(e.export_file(), before);
}

#[test]
fn abaqus_exact_membership_budget_applies_to_each_kind_of_declaration() {
    let mut text = String::from(
        "*NODE\n1,0,0,0\n2,1,0,0\n3,0,1,0\n4,0,0,1\n5,0,0,-1\n\
         *ELEMENT,TYPE=C3D4,ELSET=ONE\n1,1,2,3,4\n*NSET,NSET=BUDGET\n",
    );
    // The implicit ONE membership plus 999999 explicit duplicates exactly fills the budget.
    // All labels and references exist; deduplication must never erase allocation accounting.
    for _ in 0..62_499 {
        text.push_str("1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1\n");
    }
    text.push_str("1,1,1,1,1,1,1,1,1,1,1,1,1,1,1\n");
    let mut e = engine();
    let before = e.export_file();
    let accepted = converted(&mut e, &text, "1 m");
    assert_eq!(accepted.report.source_nodes, 5);
    assert_eq!(accepted.report.source_labels.unused_nodes, [5]);
    let source = serde_json::to_value(&accepted.commands[2]).unwrap();
    assert_eq!(source["mesher"]["nodeSets"]["BUDGET"], json!([1]));
    for addition in [
        "*NODE,NSET=EXTRA\n6,0,0,2\n",
        "*ELEMENT,TYPE=C3D4,ELSET=EXTRA\n2,1,3,2,5\n",
        "*NSET,NSET=DERIVED,ELSET=ONE\n",
        "*NSET,NSET=EXTRA\n1\n",
        "*NSET,NSET=EXTRA\nBUDGET\n",
        "*SURFACE,NAME=EXTRA,TYPE=ELEMENT\nONE,S1\n",
        "*SURFACE,NAME=EXTRA,TYPE=ELEMENT\n1,S1\n",
    ] {
        let rejected = e.query(request(&format!("{text}{addition}"), "1 m")).unwrap_err();
        assert!(rejected.cause.contains("1000000 memberships"), "{rejected:?}");
        assert!(rejected.where_.as_deref().unwrap().ends_with(" memberships"), "{rejected:?}");
    }
    assert_eq!(e.export_file(), before);
}

#[test]
fn abaqus_entity_and_actual_serialized_response_limits_are_independent() {
    use std::fmt::Write;
    let mut e = engine();
    let before = e.export_file();
    let mut nodes = String::from("*NODE\n");
    for label in 1..=250_001 {
        writeln!(&mut nodes, "{label},0").unwrap();
    }
    let rejected = e.query(request(&nodes, "1 m")).unwrap_err();
    assert_eq!(rejected.where_.as_deref(), Some("line 250002 *NODE count"));
    let mut elements = String::from("*ELEMENT,TYPE=C3D4\n");
    for label in 1..=250_001 {
        writeln!(&mut elements, "{label},1,2,3,4").unwrap();
    }
    let rejected = e.query(request(&elements, "1 m")).unwrap_err();
    assert_eq!(rejected.where_.as_deref(), Some("line 250002 *ELEMENT count"));
    // JSON escapes every backslash. Input remains below 16 MiB, while the exact response
    // serializer exceeds its separate bound; no approximate Model-size formula is involved.
    let mut escaped = String::from("*HEADING\n");
    let line = format!("{}\n", "\\".repeat(240));
    for _ in 0..50_000 {
        escaped.push_str(&line);
    }
    escaped.push_str(TET);
    assert!(escaped.len() < femlab_engine::io::abaqus::MAX_INPUT_BYTES);
    let rejected = e.query(request(&escaped, "1 m")).unwrap_err();
    assert_eq!(rejected.where_.as_deref(), Some("text"));
    assert!(rejected.cause.starts_with("serialized Abaqus conversion response exceeds"));
    assert_eq!(e.export_file(), before);
}

#[test]
fn abaqus_uppercase_raw_mesh_writer_roundtrip_is_supplementary_to_independent_fixtures() {
    use femlab_geometry::{ElementBlock, ElementKind, Face, Mesh};
    let original = Mesh {
        dim: 3,
        coords: vec![
            0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 2.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 3.0, 1.0, 0.0, 3.0, 1.0, 2.0, 3.0,
            0.0, 2.0, 3.0,
        ],
        blocks: vec![ElementBlock { kind: ElementKind::Hex8, conn: (0..8).collect(), first_elem: 0 }],
        node_sets: BTreeMap::from([("ALL".into(), (0..8).collect()), ("BASE".into(), vec![0, 1, 2, 3])]),
        // Authored BLOCK1 makes the writer's grouping membership explicit rather than extra intent.
        elem_sets: BTreeMap::from([("ALL".into(), vec![0]), ("BLOCK1".into(), vec![0])]),
        face_sets: BTreeMap::from([("FACE1".into(), vec![Face { elem: 0, local: 0 }])]),
    };
    let text = femlab_engine::io::write_inp(&original, "Raw uppercase mesh").unwrap();
    let mut e = engine();
    let conversion = converted(&mut e, &text, "1 m");
    let definition = serde_json::to_value(&conversion.commands[2]).unwrap();
    let source = &definition["mesher"];
    for (name, members) in &original.node_sets {
        let expected: Vec<_> = members.iter().map(|member| member + 1).collect();
        assert_eq!(source["nodeSets"][name], json!(expected));
    }
    for (name, members) in &original.elem_sets {
        let expected: Vec<_> = members.iter().map(|member| member + 1).collect();
        assert_eq!(source["elementSets"][name], json!(expected));
    }
    assert_eq!(source["surfaces"]["FACE1"], json!([{"element":1,"face":1}]));
    install(&mut e, &conversion);
    assert_eq!(e.mesh().unwrap().mesh.coords, original.coords);
    assert_eq!(e.mesh().unwrap().mesh.blocks, original.blocks);
    for (name, expected) in &original.node_sets {
        assert_eq!(&e.mesh().unwrap().mesh.node_sets[&format!("part.nset_{name}")], expected);
    }
    for (name, expected) in &original.elem_sets {
        assert_eq!(&e.mesh().unwrap().mesh.elem_sets[&format!("part.elset_{name}")], expected);
    }
    assert_eq!(e.mesh().unwrap().mesh.face_sets["part.surface_FACE1"], original.face_sets["FACE1"]);
    // Quoted labels round-trip as exact source identities, including embedded periods.
    let qualified = text.replace("NSET=BASE", "NSET=\"part.nset_BASE\"");
    let quoted = converted(&mut e, &qualified, "1 m");
    let command = serde_json::to_value(&quoted.commands[2]).unwrap();
    assert_eq!(command["mesher"]["nodeSets"]["part.nset_BASE"], json!([1, 2, 3, 4]));
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]
    #[test]
    fn abaqus_arbitrary_text_never_panics_or_mutates_the_model(mut text in prop_oneof![
        any::<String>(),
        proptest::collection::vec(0u8..=127, 0..2048).prop_map(|bytes| String::from_utf8(bytes).unwrap()),
    ]) {
        let mut e = engine();
        let before = e.export_file();
        // Reach the lexer rather than mostly exercising the required-final-newline guard.
        text.push('\n');
        let _ = e.query(request(&text, "1 m"));
        prop_assert_eq!(e.export_file(), before);
    }

    #[test]
    fn abaqus_admissible_tet_coordinates_convert_with_exact_source_identity(
        x in 1.0f64..2.0, y in 1.0f64..2.0, z in 1.0f64..2.0, millimetres in any::<bool>(),
    ) {
        let text = format!(
            "*node\n40,0\n10,{x}\n70,0,{y}\n20,0,0,{z}\n*element,type=c3d4,elset=all\n900,40,10,70,20\n"
        );
        let unit = if millimetres { "1 mm" } else { "1 m" };
        let scale = if millimetres { 0.001 } else { 1.0 };
        let mut e = engine();
        let conversion = converted(&mut e, &text, unit);
        prop_assert_eq!(&conversion.report.source_labels.nodes, &[10, 20, 40, 70]);
        prop_assert_eq!(&conversion.report.source_labels.elements, &[900]);
        let bounds: Vec<_> = conversion.report.bbox.iter().map(|q| q.si().unwrap()).collect();
        prop_assert_eq!(bounds, vec![0.0, 0.0, 0.0, x * scale, y * scale, z * scale]);
        install(&mut e, &conversion);
        let model = read(&mut e, json!({"query":"query.model"}));
        let expected = x * y * z * scale * scale * scale / 6.0;
        let actual = model["bodies"][0]["measure"]["value"].as_f64().unwrap();
        prop_assert!((actual - expected).abs() < expected * 1e-12);
    }
}

#[test]
fn abaqus_c3d8_selects_explicit_mean_dilatation_but_existing_full_journals_survive() {
    let mut e = engine();
    let conversion = converted(&mut e, HEX, "1 mm");
    let wire = serde_json::to_value(&conversion.commands[2]).unwrap();
    assert_eq!(wire["formulation"], "mean-dilatation");
    install(&mut e, &conversion);
    assert_eq!(e.model().mesh.as_ref().unwrap().formulation, femlab_engine::command::Formulation::MeanDilatation);
    let new_file = e.export_file();
    let mut replay = engine();
    pollster::block_on(replay.replay(&new_file.journal.entries, true, true)).unwrap();
    assert_eq!(replay.model_hash(), e.model_hash());
    assert_eq!(replay.export_file(), new_file);
    for explicit in [false, true] {
        let mut legacy = wire.clone();
        if explicit {
            legacy["formulation"] = json!("full");
        } else {
            legacy.as_object_mut().unwrap().remove("formulation");
        }
        let mut old = engine();
        run(&mut old, &legacy.to_string()).unwrap();
        assert_eq!(old.model().mesh.as_ref().unwrap().formulation, femlab_engine::command::Formulation::Full);
        let file = old.export_file();
        let mut opened = engine();
        pollster::block_on(opened.replay(&file.journal.entries, true, true)).unwrap();
        assert_eq!(opened.export_file(), file);
        assert_eq!(opened.mesh().unwrap().mesh, e.mesh().unwrap().mesh);
    }
}
