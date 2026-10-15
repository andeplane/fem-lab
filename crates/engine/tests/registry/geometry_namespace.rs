//! Geometry names have one owner, independent of public Command ordering.
use super::{engine, err, ok, Engine, ErrorCode, ObjectKind, Output};
use serde_json::{json, Value};

fn implicit_meshers(name: &str) -> Vec<Value> {
    let mapped = json!({"kind":"mapped","body":name,"blocks":[{
        "corners":[["0 m","0 m"],["1 m","0 m"],["1 m","1 m"],["0 m","1 m"]],"n":[1,1]
    }]});
    vec![
        mapped.clone(),
        json!({"kind":"surface","body":name,"patches":[{
            "corners":[["0 m","0 m","0 m"],["1 m","0 m","0 m"],["1 m","1 m","0 m"],["0 m","1 m","0 m"]],"n":[1,1]
        }]}),
        json!({"kind":"sweep","base":mapped,"sweep":{"kind":"extrude","layers":1,"height":"1 m"}}),
    ]
}

fn mesh(e: &mut Engine, mesher: &Value) {
    ok(e, &json!({"cmd":"mesh.set","mesher":mesher}).to_string());
}

fn point(name: &str, mass: &str) -> Value {
    json!({"cmd":"geometry.addMass","name":name,"at":["0 m","0 m","0 m"],"mass":mass})
}

fn region(name: &str) -> Value {
    json!({"cmd":"geometry.nameRegion","name":name,"where":{
        "kind":"bbox","min":["0 m","0 m","0 m"],"max":["1 m","1 m","1 m"]
    }})
}

fn rejects_without_mutation(e: &mut Engine, command: Value, at: &str) {
    rejects_with_code_without_mutation(e, command, ErrorCode::NameTaken, at);
}

fn rejects_with_code_without_mutation(e: &mut Engine, command: Value, code: ErrorCode, at: &str) {
    let before = serde_json::to_value(e.export_file()).unwrap();
    let revision = e.revision();
    let hash = e.model_hash();
    let error = err(e, &command.to_string());
    assert_eq!(error.code, code, "{command}");
    assert_eq!(error.where_.as_deref(), Some(at));
    if code == ErrorCode::NameTaken {
        assert!(error.suggestion.is_some());
    }
    assert_eq!(e.revision(), revision);
    assert_eq!(e.model_hash(), hash);
    assert_eq!(serde_json::to_value(e.export_file()).unwrap(), before, "Model and Journal are atomic");
}

fn replay_matches(e: &Engine) {
    let mut replay = engine();
    pollster::block_on(replay.replay(&e.export_file().journal.entries, false, true)).unwrap();
    assert_eq!(replay.model_hash(), e.model_hash());
    assert_eq!(serde_json::to_value(replay.export_file()).unwrap(), serde_json::to_value(e.export_file()).unwrap());
}

#[test]
fn a_point_name_blocks_every_implicit_body_before_any_mesh_or_journal_change() {
    for mesher in implicit_meshers("part") {
        let mut e = engine();
        ok(&mut e, &point("part", "1 kg").to_string());
        rejects_without_mutation(&mut e, json!({"cmd":"mesh.set","mesher":mesher}), "mesher.body");
        assert_eq!(e.model().implicit_body(), None);
        assert_eq!(e.model().points.len(), 1);
        assert_eq!(e.model().points[0].name, "part");
        assert!(e.model().mesh.is_none());
        let before = e.model_hash();
        ok(&mut e, r#"{"cmd":"geometry.remove","name":"part"}"#);
        assert!(e.model().points.is_empty());
        ok(&mut e, r#"{"cmd":"journal.undo"}"#);
        assert_eq!(e.model_hash(), before);
        replay_matches(&e);
    }
}

#[test]
fn an_implicit_body_blocks_point_and_named_set_constructors_in_the_reverse_order() {
    for mesher in implicit_meshers("part") {
        let mut e = engine();
        mesh(&mut e, &mesher);
        rejects_without_mutation(&mut e, point("part", "1 kg"), "name");
        rejects_without_mutation(&mut e, region("part"), "name");
        rejects_without_mutation(
            &mut e,
            json!({"cmd":"geometry.nameFace","name":"part","of":"part",
            "where":{"kind":"bbox","min":["0 m","0 m","0 m"],"max":["1 m","1 m","1 m"]}}),
            "name",
        );
        assert_eq!(e.model().implicit_body(), Some("part"));
        assert!(e.model().points.is_empty());
        assert!(e.model().sets.is_empty());
        let before = e.model_hash();
        ok(&mut e, r#"{"cmd":"geometry.remove","name":"part"}"#);
        assert!(e.model().mesh.is_none());
        assert!(e.model().points.is_empty());
        ok(&mut e, r#"{"cmd":"journal.undo"}"#);
        assert_eq!(e.model_hash(), before);
        replay_matches(&e);
    }
}

#[test]
fn named_sets_reserve_their_name_for_meshers_points_bodies_and_cuts() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"other","size":["2 m","2 m","2 m"]}"#);
    ok(&mut e, &region("reserved").to_string());
    for mesher in implicit_meshers("reserved") {
        rejects_without_mutation(&mut e, json!({"cmd":"mesh.set","mesher":mesher}), "mesher.body");
    }
    for command in [
        point("reserved", "1 kg"),
        json!({"cmd":"geometry.addBox","name":"reserved","size":["1 m","1 m","1 m"]}),
        json!({"cmd":"geometry.subtractBox","name":"reserved","from":"other","size":["0.1 m","0.1 m","0.1 m"],"at":["0.5 m","0.5 m","0.5 m"]}),
    ] {
        rejects_without_mutation(&mut e, command, "name");
    }
    ok(&mut e, &region("reserved").to_string());
    assert_eq!(e.model().sets.len(), 1, "same-owner Set upsert is supported");
    ok(&mut e, r#"{"cmd":"geometry.remove","name":"reserved"}"#);
    assert!(e.model().sets.is_empty());
    assert_eq!(e.model().bodies[0].name, "other");
    replay_matches(&e);
}

#[test]
fn body_and_set_rename_or_copy_cannot_shadow_another_geometry_owner() {
    let mut e = engine();
    mesh(&mut e, &implicit_meshers("part")[0]);
    ok(&mut e, &point("point", "1 kg").to_string());
    ok(&mut e, &region("region").to_string());
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"explicit","size":["2 m","2 m","2 m"]}"#);
    for (kind, name, target) in [
        ("body", "part", "point"),
        ("body", "part", "region"),
        ("body", "explicit", "point"),
        ("set", "region", "part"),
        ("set", "region", "point"),
    ] {
        rejects_without_mutation(&mut e, json!({"cmd":"model.rename","kind":kind,"name":name,"to":target}), "to");
    }
    for (kind, name, target) in [
        ("body", "explicit", "point"),
        ("body", "explicit", "region"),
        ("set", "region", "part"),
        ("set", "region", "point"),
    ] {
        rejects_without_mutation(&mut e, json!({"cmd":"model.duplicate","kind":kind,"name":name,"as":target}), "as");
    }
    ok(&mut e, r#"{"cmd":"material.add","name":"point","E":"1 GPa","nu":0}"#);
    ok(&mut e, r#"{"cmd":"material.assign","material":"point","bodies":["part"]}"#);
    ok(&mut e, r#"{"cmd":"model.rename","kind":"body","name":"part","to":"renamed"}"#);
    assert_eq!(e.model().implicit_body(), Some("renamed"));
    assert_eq!(e.model().material_of_body("renamed"), Some("point"), "Material namespace stays independent");
    replay_matches(&e);
}

#[test]
fn same_owner_upserts_remesh_and_removal_keep_point_and_body_lifecycles_separate() {
    let mut e = engine();
    mesh(&mut e, &implicit_meshers("part")[0]);
    ok(&mut e, r#"{"cmd":"material.add","name":"part","E":"1 GPa","nu":0}"#);
    ok(&mut e, r#"{"cmd":"material.assign","material":"part","bodies":["part"]}"#);
    mesh(&mut e, &implicit_meshers("part")[0]);
    assert_eq!(e.model().material_of_body("part"), Some("part"));
    ok(&mut e, &point("point", "1 kg").to_string());
    let update = ok(&mut e, &point("point", "2 kg").to_string());
    assert_eq!(update.output, Output::Replaced { kind: ObjectKind::Set, name: "point".into() });
    assert_eq!(e.model().points.len(), 1);
    assert_eq!(e.model().points[0].mass, 2.0);
    rejects_without_mutation(
        &mut e,
        json!({"cmd":"geometry.addBox","name":"point","size":["1 m","1 m","1 m"]}),
        "name",
    );
    rejects_without_mutation(&mut e, region("point"), "name");
    let before = e.model_hash();
    ok(&mut e, r#"{"cmd":"geometry.remove","name":"point"}"#);
    assert_eq!(e.model().implicit_body(), Some("part"));
    assert_eq!(e.model().material_of_body("part"), Some("part"));
    ok(&mut e, r#"{"cmd":"journal.undo"}"#);
    assert_eq!(e.model_hash(), before);
    ok(&mut e, r#"{"cmd":"geometry.remove","name":"part"}"#);
    assert!(e.model().mesh.is_none());
    assert_eq!(e.model().points[0].mass, 2.0);
    ok(&mut e, r#"{"cmd":"journal.undo"}"#);
    assert_eq!(e.model_hash(), before);
    replay_matches(&e);
}

#[test]
fn public_replay_rejects_the_ambiguous_command_without_creating_a_second_owner() {
    let entries: Vec<femlab_engine::journal::JournalEntry> = serde_json::from_value(json!([
        {"seq":0,"cmd":point("part", "1 kg"),"hashAfter":""},
        {"seq":1,"cmd":{"cmd":"mesh.set","mesher":implicit_meshers("part")[0]},"hashAfter":""}
    ]))
    .unwrap();
    let mut replay = engine();
    let error = pollster::block_on(replay.replay(&entries, false, false)).unwrap_err();
    assert_eq!(error.code, ErrorCode::NameTaken);
    assert_eq!(error.where_.as_deref(), Some("journal entry 1"));
    assert!(replay.model().mesh.is_none());
    assert_eq!(replay.model().points.len(), 1);
    assert_eq!(replay.model().points[0].name, "part");
    assert_eq!(replay.journal().entries.len(), 1, "only the valid prefix is recorded");
    let before = replay.model_hash();
    ok(&mut replay, r#"{"cmd":"geometry.remove","name":"part"}"#);
    assert!(replay.model().points.is_empty());
    ok(&mut replay, r#"{"cmd":"journal.undo"}"#);
    assert_eq!(replay.model_hash(), before);
    replay_matches(&replay);
}

#[test]
fn point_names_still_cannot_shadow_qualified_auto_face_sets() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"part","size":["1 m","1 m","1 m"]}"#);
    rejects_with_code_without_mutation(&mut e, point("part.xmin", "1 kg"), ErrorCode::Schema, "name");
    assert!(e.model().points.is_empty());
    assert_eq!(e.model().bodies[0].name, "part");
    replay_matches(&e);
}
