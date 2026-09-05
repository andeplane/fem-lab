//! The registry end to end: dispatch, undo/redo, replay, Queries, errors. Every Command runs
//! through JSON, the way every host sends it.

use femlab_engine::command::{
    Axis, Dof, FacePredicate, Field, IdealisationSpec, LatticeSize, MesherSpec, ObjectKind, Procedure, RegionPredicate,
    Solver,
};
use femlab_engine::query::{Output, Query, QueryResult};
use femlab_engine::units::{Quantity, Q};
use femlab_engine::{Command, Engine, Error, ErrorCode, Host, NoClock, Progress};

struct Clock(f64);
impl Host for Clock {
    fn now_ms(&self) -> f64 {
        self.0
    }
}

fn engine() -> Engine {
    Engine::new(None, Box::new(NoClock), 2)
}

fn run(e: &mut Engine, json: &str) -> Result<femlab_engine::Ack, Error> {
    let cmd: Command = serde_json::from_str(json).map_err(Error::from)?;
    let mut nop = |_: Progress| true;
    pollster::block_on(e.dispatch(cmd, &mut nop))
}

fn ok(e: &mut Engine, json: &str) -> femlab_engine::Ack {
    run(e, json).unwrap_or_else(|err| panic!("{json}: {err:?}"))
}

fn err(e: &mut Engine, json: &str) -> Error {
    match run(e, json) {
        Ok(a) => panic!("{json} should fail, got {a:?}"),
        Err(e) => e,
    }
}

fn cantilever(e: &mut Engine) {
    ok(e, r#"{"cmd":"model.new","name":"cantilever"}"#);
    ok(e, r#"{"cmd":"model.setUnits","units":{"length":"mm","stress":"MPa","force":"kN"}}"#);
    ok(e, r#"{"cmd":"geometry.addBox","name":"beam","size":["1 m","100 mm","100 mm"]}"#);
    ok(e, r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"rho":"7850 kg/m^3","source":"EN 10025"}"#);
    ok(e, r#"{"cmd":"material.assign","material":"steel","bodies":["beam"]}"#);
    ok(e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"25 mm"},"order":1}"#);
    ok(e, r#"{"cmd":"constraint.fix","name":"root","on":"beam.xmin"}"#);
    ok(e, r#"{"cmd":"load.traction","name":"tip","on":"beam.xmax","total":["0 N","0 N","-1 kN"]}"#);
    ok(e, r#"{"cmd":"step.add","name":"static","procedure":"static","constraints":["root"],"loads":["tip"]}"#);
}

#[test]
fn builds_a_cantilever_and_reports_it() {
    let mut e = engine();
    cantilever(&mut e);
    assert_eq!(e.revision(), 9);
    let QueryResult::Model(m) = e.query(Query::Model {}).unwrap() else { panic!() };
    assert_eq!(m.name, "cantilever");
    assert_eq!(m.revision, 9);
    assert_eq!(m.bodies.len(), 1);
    assert_eq!(m.bodies[0].material.as_deref(), Some("steel"));
    assert!((m.bodies[0].measure.value - 1e7).abs() < 1e-3, "{:?}", m.bodies[0].measure);
    assert_eq!(m.bodies[0].measure.unit, "mm^3");
    assert!((m.bodies[0].mass.as_ref().unwrap().value - 78.5).abs() < 1e-9);
    assert_eq!(m.bodies[0].faces, ["beam.xmax", "beam.xmin", "beam.ymax", "beam.ymin", "beam.zmax", "beam.zmin"]);
    assert_eq!(m.bodies[0].bbox[3].value, 1000.0);
    assert_eq!(m.materials[0].e.value, 210_000.0);
    assert_eq!(m.materials[0].e.unit, "MPa");
    assert_eq!(m.materials[0].assigned_to, ["beam"]);
    assert_eq!(m.constraints[0].summary, "fix ux, uy, uz");
    assert_eq!(m.loads[0].kind, "traction");
    assert_eq!(m.loads[0].summary, "total [0, 0, -1] kN");
    assert_eq!(m.steps[0].procedure, "static");
    assert!(m.mesh_settings.is_some());
    assert!(m.warnings.is_empty(), "{:?}", m.warnings);
    assert_eq!(m.idealisation, "solid3d");
    let QueryResult::Journal(j) = e.query(Query::Journal { from_seq: Some(7) }).unwrap() else { panic!() };
    assert_eq!(j.entries.len(), 2);
    assert!(j.can_undo && !j.can_redo);
    let QueryResult::Script(s) = e.query(Query::Script {}).unwrap() else { panic!() };
    assert!(s
        .text
        .contains(r#"await fem.load.traction({ name: "tip", on: "beam.xmax", total: ["0 N", "0 N", "-1 kN"] });"#));
    let QueryResult::Objects(o) = e.query(Query::Objects { kinds: None }).unwrap() else { panic!() };
    assert!(o.objects.iter().any(|x| x.ref_ == "body:beam"));
    assert!(o.objects.iter().any(|x| x.ref_ == "journal:8"));
    let QueryResult::Objects(o) = e.query(Query::Objects { kinds: Some(vec![ObjectKind::Load]) }).unwrap() else {
        panic!()
    };
    assert_eq!(o.objects.len(), 1);
    let QueryResult::Capabilities(c) = e.query(Query::Capabilities {}).unwrap() else { panic!() };
    assert!(!c.gpu && c.threads == 2 && c.schema_version == "1");
    assert_eq!(e.threads(), 2);
    assert_eq!(e.now_ms(), 0.0);
    assert_eq!(Engine::new(None, Box::new(Clock(5.0)), 1).now_ms(), 5.0);
}

#[test]
fn transactional_dispatch_and_structured_errors() {
    let mut e = engine();
    cantilever(&mut e);
    let hash = e.model_hash();
    let er = err(&mut e, r#"{"cmd":"load.pressure","name":"p","on":"beam.xmax","value":"250 mm"}"#);
    assert_eq!(er.code, ErrorCode::UnitDimension);
    assert_eq!(er.where_.as_deref(), Some("value"));
    assert_eq!(e.model_hash(), hash, "nothing changed");
    assert_eq!(e.revision(), 9, "nothing recorded");
    let er = err(&mut e, r#"{"cmd":"constraint.fix","name":"x","on":"nope.xmin"}"#);
    assert_eq!(er.code, ErrorCode::NotFound);
    assert!(er.suggestion.as_deref().unwrap().contains("geometry.nameFace"));
    let er = err(&mut e, r#"{"cmd":"material.assign","material":"gold","bodies":["beam"]}"#);
    assert_eq!(er.code, ErrorCode::NotFound);
    assert!(er.suggestion.as_deref().unwrap().contains("steel"));
    let er = err(&mut e, r#"{"cmd":"material.assign","material":"steel","bodies":["plate"]}"#);
    assert_eq!(er.code, ErrorCode::NotFound);
    let er = err(&mut e, r#"{"cmd":"material.remove","name":"steel"}"#);
    assert_eq!(er.code, ErrorCode::InUse);
    assert!(er.cause.contains("beam"));
    let er = err(&mut e, r#"{"cmd":"constraint.remove","name":"root"}"#);
    assert_eq!(er.code, ErrorCode::InUse);
    let er = err(&mut e, r#"{"cmd":"load.remove","name":"tip"}"#);
    assert_eq!(er.code, ErrorCode::InUse);
    let er = err(&mut e, r#"{"cmd":"geometry.remove","name":"beam"}"#);
    assert_eq!(er.code, ErrorCode::InUse);
    assert!(er.cause.contains("constraint 'root'") && er.cause.contains("load 'tip'"));
    let er = err(&mut e, r#"{"cmd":"geometry.remove","name":"ghost"}"#);
    assert_eq!(er.code, ErrorCode::NotFound);
    let er = err(&mut e, r#"{"cmd":"material.remove","name":"ghost"}"#);
    assert_eq!(er.code, ErrorCode::NotFound);
    assert_eq!(err(&mut e, r#"{"cmd":"constraint.remove","name":"ghost"}"#).code, ErrorCode::NotFound);
    assert_eq!(err(&mut e, r#"{"cmd":"load.remove","name":"ghost"}"#).code, ErrorCode::NotFound);
    assert_eq!(err(&mut e, r#"{"cmd":"step.remove","name":"ghost"}"#).code, ErrorCode::NotFound);
    let er = err(&mut e, r#"{"cmd":"material.add","name":"bad","E":"-1 GPa","nu":0.3}"#);
    assert_eq!(er.where_.as_deref(), Some("E"));
    let er = err(&mut e, r#"{"cmd":"material.add","name":"bad","E":"1 GPa","nu":0.5}"#);
    assert_eq!(er.where_.as_deref(), Some("nu"));
    let er = err(&mut e, r#"{"cmd":"material.add","name":"bad","E":"1 GPa","nu":0.3,"rho":"7 m"}"#);
    assert_eq!(er.where_.as_deref(), Some("rho"));
    let er = err(&mut e, r#"{"cmd":"material.add","name":"bad","E":"1 m","nu":0.3}"#);
    assert_eq!(er.where_.as_deref(), Some("E"));
    let er = err(&mut e, r#"{"cmd":"material.add","name":"bad name","E":"1 GPa","nu":0.3}"#);
    assert_eq!(er.code, ErrorCode::Schema);
    assert_eq!(er.where_.as_deref(), Some("name"));
    assert_eq!(
        err(&mut e, r#"{"cmd":"step.add","name":"s2","procedure":"static","constraints":["nope"],"loads":[]}"#).code,
        ErrorCode::NotFound
    );
    assert_eq!(
        err(&mut e, r#"{"cmd":"step.add","name":"s2","procedure":"static","constraints":[],"loads":["nope"]}"#).code,
        ErrorCode::NotFound
    );
    assert_eq!(err(&mut e, r#"{"cmd":"step.reorder","order":["static","other"]}"#).code, ErrorCode::Schema);
    assert_eq!(
        err(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"25 mm"},"order":3}"#).where_.as_deref(),
        Some("order")
    );
    assert_eq!(
        err(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"-25 mm"}}"#).where_.as_deref(),
        Some("mesher.size")
    );
    assert_eq!(
        err(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"25 kg"}}"#).code,
        ErrorCode::UnitDimension
    );
    assert_eq!(
        err(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":0,"ny":1,"nz":1}}}"#)
            .where_
            .as_deref(),
        Some("mesher.size")
    );
    assert_eq!(
        err(&mut e, r#"{"cmd":"constraint.fix","name":"x","on":"beam.xmin","dofs":[]}"#).where_.as_deref(),
        Some("dofs")
    );
    assert_eq!(
        err(&mut e, r#"{"cmd":"constraint.prescribe","name":"x","on":"beam.xmin","dof":"ux","value":"2 kg"}"#).code,
        ErrorCode::UnitDimension
    );
    assert_eq!(
        err(&mut e, r#"{"cmd":"constraint.symmetry","name":"x","on":"nope","normal":"x"}"#).code,
        ErrorCode::NotFound
    );
    assert_eq!(
        err(&mut e, r#"{"cmd":"load.pressure","name":"p","on":"nope","value":"1 MPa"}"#).code,
        ErrorCode::NotFound
    );
    assert_eq!(
        err(&mut e, r#"{"cmd":"load.traction","name":"p","on":"nope","total":["0 N","0 N","0 N"]}"#).code,
        ErrorCode::NotFound
    );
    assert_eq!(
        err(&mut e, r#"{"cmd":"load.traction","name":"p","on":"beam.xmax","total":["0 N","0 m","0 N"]}"#)
            .where_
            .as_deref(),
        Some("total[1]")
    );
    assert_eq!(
        err(&mut e, r#"{"cmd":"load.force","name":"p","on":"nope","total":["0 N","0 N","0 N"]}"#).code,
        ErrorCode::NotFound
    );
    assert_eq!(
        err(&mut e, r#"{"cmd":"load.force","name":"p","on":"beam.xmax","total":["0 N","0 N","1 s"]}"#)
            .where_
            .as_deref(),
        Some("total[2]")
    );
    assert_eq!(
        err(&mut e, r#"{"cmd":"load.gravity","name":"g","g":["0 m/s^2","0 m/s^2","-9.81 m"]}"#).where_.as_deref(),
        Some("g[2]")
    );
    assert_eq!(
        err(&mut e, r#"{"cmd":"load.temperature","name":"t","bodies":["nope"],"value":"100 degC"}"#).code,
        ErrorCode::NotFound
    );
    assert_eq!(
        err(&mut e, r#"{"cmd":"load.temperature","name":"t","bodies":["beam"],"value":"100 m"}"#).where_.as_deref(),
        Some("value")
    );
    assert_eq!(
        err(&mut e, r#"{"cmd":"load.temperature","name":"t","bodies":["beam"],"value":"100 degC","reference":"1 m"}"#)
            .where_
            .as_deref(),
        Some("reference")
    );
    assert_eq!(err(&mut e, r#"{"cmd":"model.setUnits","units":{"stress":"mm"}}"#).code, ErrorCode::UnitDimension);
    assert_eq!(
        err(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStress","thickness":"-1 mm"}}"#)
            .where_
            .as_deref(),
        Some("idealisation.thickness")
    );
    assert_eq!(
        err(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStress","thickness":"1 kg"}}"#).code,
        ErrorCode::UnitDimension
    );
    assert_eq!(
        err(
            &mut e,
            r#"{"cmd":"geometry.nameFace","name":"top","of":"nope","where":{"kind":"normal","normal":[0,0,1]}}"#
        )
        .code,
        ErrorCode::NotFound
    );
    assert_eq!(err(&mut e, r#"{"cmd":"geometry.nameFace","name":"top","of":"beam","where":{"kind":"plane","normal":[0,0,1],"offset":"1 kg"}}"#).code, ErrorCode::UnitDimension);
    assert_eq!(
        err(&mut e, r#"{"cmd":"geometry.nameRegion","name":"r","where":{"kind":"body","name":"nope"}}"#).code,
        ErrorCode::NotFound
    );
    assert_eq!(err(&mut e, r#"{"cmd":"geometry.nameRegion","name":"r","where":{"kind":"bbox","min":["0 m","0 m","0 m"],"max":["1 kg","1 m","1 m"]}}"#).code, ErrorCode::UnitDimension);
    assert_eq!(
        err(&mut e, r#"{"cmd":"geometry.addBox","name":"bad","size":["1 m","0 m","1 m"]}"#).code,
        ErrorCode::Schema
    );
    assert_eq!(
        err(&mut e, r#"{"cmd":"geometry.addBox","name":"bad","size":["1 m","1 kg","1 m"]}"#).code,
        ErrorCode::UnitDimension
    );
    assert_eq!(err(&mut e, r#"{"cmd":"geometry.subtractBox","name":"hole","from":"nope","size":["1 m","1 m","1 m"],"at":["0 m","0 m","0 m"]}"#).code, ErrorCode::NotFound);
    let er = err(
        &mut e,
        r#"{"cmd":"geometry.subtractBox","name":"all","from":"beam","size":["2 m","2 m","2 m"],"at":["-0.5 m","-0.5 m","-0.5 m"]}"#,
    );
    assert!(er.cause.contains("empty"), "{er:?}");
    assert_eq!(err(&mut e, r#"{"cmd":"geometry.subtractBox","name":"beam","from":"beam","size":["1 m","1 m","1 m"],"at":["0 m","0 m","0 m"]}"#).code, ErrorCode::NameTaken);
    assert_eq!(
        err(
            &mut e,
            r#"{"cmd":"geometry.subtract","name":"h","from":"beam","shape":{"kind":"box","size":["0 m","1 m","1 m"]}}"#
        )
        .code,
        ErrorCode::Schema
    );
    assert_eq!(
        err(&mut e, r#"{"cmd":"geometry.add","name":"s","shape":{"kind":"sphere","radius":"1 kg"}}"#).code,
        ErrorCode::UnitDimension
    );
    assert_eq!(err(&mut e, r#"{"cmd":"solve.run","step":"static"}"#).code, ErrorCode::Unsupported);
    assert_eq!(
        err(
            &mut e,
            r#"{"cmd":"study.converge","step":"static","sizes":["50 mm"],"quantity":{"kind":"max","field":"vonMises"}}"#
        )
        .code,
        ErrorCode::Unsupported
    );
    assert_eq!(
        err(&mut e, r#"{"cmd":"plugin.load","name":"p","kind":"materialLaw","language":"ts","source":{"inline":"x"}}"#)
            .code,
        ErrorCode::Unsupported
    );
    assert_eq!(run(&mut e, r#"{"cmd":"nonsense"}"#).unwrap_err().code, ErrorCode::Schema);
    for q in [
        Query::Result { step: None },
        Query::Probe {
            step: None,
            field: Field::VonMises,
            component: None,
            at: [Q::text("0 m"), Q::text("0 m"), Q::text("0 m")],
        },
        Query::Path {
            step: None,
            field: Field::VonMises,
            component: None,
            from: [Q::text("0 m"), Q::text("0 m"), Q::text("0 m")],
            to: [Q::text("1 m"), Q::text("0 m"), Q::text("0 m")],
            n: 3,
        },
        Query::Cost { step: "static".into() },
    ] {
        assert_eq!(e.query(q).unwrap_err().code, ErrorCode::Unsupported);
    }
    assert_eq!(e.revision(), 9);
    assert_eq!(e.model_hash(), hash);
}

#[test]
fn upsert_edits_in_place_and_reports_replaced() {
    let mut e = engine();
    cantilever(&mut e);
    let a = ok(&mut e, r#"{"cmd":"load.traction","name":"tip","on":"beam.xmax","total":["0 N","0 N","-2 kN"]}"#);
    assert_eq!(a.output, Output::Replaced { kind: ObjectKind::Load, name: "tip".into() });
    assert_eq!(e.model().loads.len(), 1);
    let a = ok(&mut e, r#"{"cmd":"material.add","name":"steel","E":"200 GPa","nu":0.3}"#);
    assert_eq!(a.output, Output::Replaced { kind: ObjectKind::Material, name: "steel".into() });
    assert_eq!(e.model().materials[0].e, 200e9);
    assert!(e.model().materials[0].rho.is_none());
    let a = ok(&mut e, r#"{"cmd":"geometry.addBox","name":"beam","size":["2 m","100 mm","100 mm"]}"#);
    assert_eq!(a.output, Output::Replaced { kind: ObjectKind::Body, name: "beam".into() });
    assert_eq!(e.model().bodies[0].material.as_deref(), Some("steel"), "material survives a shape edit");
    let a = ok(&mut e, r#"{"cmd":"constraint.fix","name":"root","on":"beam.xmin","dofs":["uz","ux","ux"]}"#);
    assert_eq!(a.output, Output::Replaced { kind: ObjectKind::Constraint, name: "root".into() });
    assert!(
        matches!(&e.model().constraints[0].kind, femlab_engine::model::ConstraintKind::Fix { dofs } if dofs == &[Dof::Ux, Dof::Uz])
    );
    let a = ok(
        &mut e,
        r#"{"cmd":"step.add","name":"static","procedure":"static","constraints":["root"],"loads":[],"output":["displacement"]}"#,
    );
    assert_eq!(a.output, Output::Replaced { kind: ObjectKind::Step, name: "static".into() });
    assert_eq!(e.model().steps[0].output, [Field::Displacement]);
    ok(&mut e, r#"{"cmd":"geometry.nameFace","name":"top","of":"beam","where":{"kind":"normal","normal":[0,0,1]}}"#);
    let a = ok(
        &mut e,
        r#"{"cmd":"geometry.nameFace","name":"top","of":"beam","where":{"kind":"plane","normal":[0,0,1],"offset":"100 mm"}}"#,
    );
    assert_eq!(a.output, Output::Replaced { kind: ObjectKind::Set, name: "top".into() });
    ok(
        &mut e,
        r#"{"cmd":"geometry.nameRegion","name":"mid","where":{"kind":"bbox","min":["0.4 m","0 m","0 m"],"max":["0.6 m","1 m","1 m"]}}"#,
    );
    ok(&mut e, r#"{"cmd":"geometry.nameRegion","name":"whole","where":{"kind":"body","name":"beam"}}"#);
    ok(&mut e, r#"{"cmd":"constraint.prescribe","name":"settle","on":"top","dof":"uz","value":"-2 mm"}"#);
    ok(&mut e, r#"{"cmd":"constraint.symmetry","name":"sym","on":"mid","normal":"x"}"#);
    ok(&mut e, r#"{"cmd":"load.pressure","name":"p","on":"top","value":"2 MPa"}"#);
    ok(&mut e, r#"{"cmd":"load.force","name":"f","on":"mid","total":["0 N","0 N","-100 N"]}"#);
    ok(&mut e, r#"{"cmd":"load.gravity","name":"g","g":["0 m/s^2","0 m/s^2","-9.81 m/s^2"]}"#);
    ok(&mut e, r#"{"cmd":"load.temperature","name":"hot","bodies":["beam"],"value":"100 degC"}"#);
    ok(&mut e, r#"{"cmd":"load.temperature","name":"hot2","bodies":["beam"],"value":"100 degC","reference":"0 degC"}"#);
    let QueryResult::Model(m) = e.query(Query::Model {}).unwrap() else { panic!() };
    assert_eq!(m.sets.len(), 3);
    assert_eq!(m.constraints[1].summary, "uz = -2 mm");
    assert_eq!(m.constraints[2].summary, "symmetry, normal x");
    assert_eq!(m.loads[1].summary, "2 MPa");
    assert_eq!(m.loads[2].kind, "force");
    assert!(m.loads[3].summary.starts_with("g = [0, 0, -9.81] m/s^2"));
    assert!(m.loads[4].summary.contains("373.2 K"), "{}", m.loads[4].summary);
    assert!(m.loads[5].summary.contains("reference 273.2 K"));
    // gravity with a material lacking density is a warning, not an error
    assert!(m.warnings.iter().any(|w| w.code == "load.no-density"));
    assert_eq!(e.model().loads.iter().filter(|l| l.kind.set().is_some()).count(), 3);
}

#[test]
fn undo_redo_and_journal_boundaries() {
    let mut e = engine();
    cantilever(&mut e);
    let h9 = e.model_hash();
    let a = ok(&mut e, r#"{"cmd":"journal.undo"}"#);
    assert_eq!(a.output, Output::Undo { steps: 1 });
    assert_eq!(e.revision(), 8);
    assert!(e.model().steps.is_empty());
    assert!(e.can_redo());
    let a = ok(&mut e, r#"{"cmd":"journal.undo","steps":2}"#);
    assert_eq!(a.revision, 6);
    assert!(e.model().constraints.is_empty());
    let a = ok(&mut e, r#"{"cmd":"journal.redo","steps":3}"#);
    assert_eq!(a.output, Output::Redo { steps: 3 });
    assert_eq!(e.revision(), 9);
    assert_eq!(e.model_hash(), h9);
    assert!(!e.can_redo());
    let er = err(&mut e, r#"{"cmd":"journal.redo"}"#);
    assert_eq!(er.code, ErrorCode::NotFound);
    let er = err(&mut e, r#"{"cmd":"journal.undo","steps":100}"#);
    assert_eq!(er.code, ErrorCode::NotFound);
    assert_eq!(err(&mut e, r#"{"cmd":"journal.undo","steps":0}"#).code, ErrorCode::NotFound);
    // a new command after undo clears redo
    ok(&mut e, r#"{"cmd":"journal.undo"}"#);
    ok(&mut e, r#"{"cmd":"load.gravity","name":"g","g":["0 m/s^2","0 m/s^2","-9.81 m/s^2"]}"#);
    assert!(!e.can_redo());
    assert_eq!(e.revision(), 9);
    // undo/redo never appear in the journal
    assert!(e.journal().entries.iter().all(|en| en.cmd.is_journaled()));
    // model.new resets everything
    let a = ok(&mut e, r#"{"cmd":"model.new","name":"fresh","description":"d"}"#);
    assert_eq!(a.seq, 0);
    assert_eq!(e.revision(), 1);
    assert!(!e.can_undo());
    assert_eq!(e.model().description.as_deref(), Some("d"));
    // undo depth is bounded
    for i in 0..(femlab_engine::engine::UNDO_DEPTH + 5) {
        ok(&mut e, &format!(r#"{{"cmd":"material.add","name":"m{i}","E":"1 GPa","nu":0.3}}"#));
    }
    let mut n = 0;
    while e.can_undo() {
        ok(&mut e, r#"{"cmd":"journal.undo"}"#);
        n += 1;
    }
    assert_eq!(n, femlab_engine::engine::UNDO_DEPTH);
}

#[test]
fn redo_failure_is_reported() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"m"}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"beam","size":["1 m","1 m","1 m"]}"#);
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"root","on":"beam.xmin"}"#);
    ok(&mut e, r#"{"cmd":"journal.undo"}"#);
    // the redo stack holds constraint.fix; make it fail by removing the body first
    ok(&mut e, r#"{"cmd":"geometry.remove","name":"beam"}"#);
    assert!(!e.can_redo(), "a new command clears redo");
    // build a redo that fails: undo the remove and the fix, then remove the body via redo? Instead:
    ok(&mut e, r#"{"cmd":"journal.undo"}"#); // undo remove → beam back
    let mut e2 = engine();
    ok(&mut e2, r#"{"cmd":"model.new","name":"m"}"#);
    ok(&mut e2, r#"{"cmd":"geometry.addBox","name":"beam","size":["1 m","1 m","1 m"]}"#);
    ok(&mut e2, r#"{"cmd":"material.add","name":"s","E":"1 GPa","nu":0.3}"#);
    ok(&mut e2, r#"{"cmd":"material.assign","material":"s","bodies":["beam"]}"#);
    ok(&mut e2, r#"{"cmd":"journal.undo"}"#);
    ok(&mut e2, r#"{"cmd":"journal.undo"}"#);
    // redo both: material.add then material.assign succeed
    ok(&mut e2, r#"{"cmd":"journal.redo","steps":2}"#);
    assert_eq!(e2.model().bodies[0].material.as_deref(), Some("s"));
}

#[test]
fn rename_and_duplicate_follow_references() {
    let mut e = engine();
    cantilever(&mut e);
    ok(
        &mut e,
        r#"{"cmd":"geometry.subtractBox","name":"hole","from":"beam","size":["50 mm","200 mm","50 mm"],"at":["475 mm","-50 mm","25 mm"]}"#,
    );
    ok(&mut e, r#"{"cmd":"geometry.nameFace","name":"top","of":"beam","where":{"kind":"normal","normal":[0,0,1]}}"#);
    ok(&mut e, r#"{"cmd":"geometry.nameRegion","name":"whole","where":{"kind":"body","name":"beam"}}"#);
    ok(&mut e, r#"{"cmd":"load.pressure","name":"p","on":"hole.zmin","value":"1 MPa"}"#);
    ok(&mut e, r#"{"cmd":"load.temperature","name":"hot","bodies":["beam"],"value":"350 K"}"#);
    ok(&mut e, r#"{"cmd":"load.gravity","name":"g","g":["0 m/s^2","0 m/s^2","-9.81 m/s^2"]}"#);
    ok(&mut e, r#"{"cmd":"model.rename","kind":"body","name":"beam","to":"girder"}"#);
    let m = e.model();
    assert_eq!(m.bodies[0].name, "girder");
    assert_eq!(m.cuts[0].from, "girder");
    assert_eq!(m.constraints[0].on, "girder.xmin");
    assert_eq!(m.loads[0].kind.set(), Some("girder.xmax"));
    assert_eq!(m.loads[1].kind.set(), Some("hole.zmin"));
    assert!(
        matches!(&m.loads[2].kind, femlab_engine::model::LoadKind::Temperature { bodies, .. } if bodies == &["girder"])
    );
    assert!(matches!(&m.sets[0].source, femlab_engine::model::SetSource::Face { of, .. } if of == "girder"));
    assert!(
        matches!(&m.sets[1].source, femlab_engine::model::SetSource::Region { where_: femlab_geometry::RegionPredicate::Body { name } } if name == "girder")
    );
    let QueryResult::Model(ms) = e.query(Query::Model {}).unwrap() else { panic!() };
    assert!(
        ms.bodies[0].faces.contains(&"girder.xmin".to_string())
            && ms.bodies[0].faces.contains(&"hole.zmin".to_string())
    );
    ok(&mut e, r#"{"cmd":"model.rename","kind":"material","name":"steel","to":"s355"}"#);
    assert_eq!(e.model().bodies[0].material.as_deref(), Some("s355"));
    ok(&mut e, r#"{"cmd":"model.rename","kind":"set","name":"top","to":"lid"}"#);
    ok(&mut e, r#"{"cmd":"load.pressure","name":"lp","on":"lid","value":"1 MPa"}"#);
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"lc","on":"lid"}"#);
    ok(&mut e, r#"{"cmd":"model.rename","kind":"set","name":"lid","to":"cap"}"#);
    assert_eq!(e.model().load("lp").unwrap().kind.set(), Some("cap"));
    assert_eq!(e.model().constraint("lc").unwrap().on, "cap");
    ok(&mut e, r#"{"cmd":"model.rename","kind":"constraint","name":"root","to":"clamp"}"#);
    assert_eq!(e.model().steps[0].constraints, ["clamp"]);
    ok(&mut e, r#"{"cmd":"model.rename","kind":"load","name":"tip","to":"end"}"#);
    assert_eq!(e.model().steps[0].loads, ["end"]);
    ok(&mut e, r#"{"cmd":"model.rename","kind":"step","name":"static","to":"uls"}"#);
    assert_eq!(e.model().steps[0].name, "uls");
    assert_eq!(err(&mut e, r#"{"cmd":"model.rename","kind":"step","name":"nope","to":"x"}"#).code, ErrorCode::NotFound);
    assert_eq!(err(&mut e, r#"{"cmd":"model.rename","kind":"load","name":"end","to":"g"}"#).code, ErrorCode::NameTaken);
    assert_eq!(err(&mut e, r#"{"cmd":"model.rename","kind":"load","name":"end","to":"a.b"}"#).code, ErrorCode::Schema);
    // duplicate
    ok(&mut e, r#"{"cmd":"model.duplicate","kind":"body","name":"girder","as":"girder2"}"#);
    assert_eq!(e.model().bodies.len(), 2);
    assert_eq!(e.model().cuts.len(), 2);
    assert_eq!(e.model().cuts[1].name, "girder2.hole");
    assert_eq!(e.model().cuts[1].from, "girder2");
    ok(&mut e, r#"{"cmd":"model.duplicate","kind":"material","name":"s355","as":"s235"}"#);
    ok(&mut e, r#"{"cmd":"model.duplicate","kind":"set","name":"cap","as":"cap2"}"#);
    ok(&mut e, r#"{"cmd":"model.duplicate","kind":"constraint","name":"clamp","as":"clamp2"}"#);
    ok(&mut e, r#"{"cmd":"model.duplicate","kind":"load","name":"end","as":"end2"}"#);
    ok(&mut e, r#"{"cmd":"model.duplicate","kind":"step","name":"uls","as":"sls"}"#);
    assert_eq!(e.model().steps.len(), 2);
    assert_eq!(
        err(&mut e, r#"{"cmd":"model.duplicate","kind":"step","name":"nope","as":"x"}"#).code,
        ErrorCode::NotFound
    );
    assert_eq!(
        err(&mut e, r#"{"cmd":"model.duplicate","kind":"step","name":"uls","as":"sls"}"#).code,
        ErrorCode::NameTaken
    );
    assert_eq!(
        err(&mut e, r#"{"cmd":"model.duplicate","kind":"step","name":"uls","as":"a b"}"#).code,
        ErrorCode::Schema
    );
    ok(&mut e, r#"{"cmd":"step.reorder","order":["sls","uls"]}"#);
    assert_eq!(e.model().steps[0].name, "sls");
    ok(&mut e, r#"{"cmd":"step.remove","name":"sls"}"#);
    // removals that are allowed
    ok(&mut e, r#"{"cmd":"load.remove","name":"end2"}"#);
    ok(&mut e, r#"{"cmd":"constraint.remove","name":"clamp2"}"#);
    ok(&mut e, r#"{"cmd":"material.remove","name":"s235"}"#);
    ok(&mut e, r#"{"cmd":"geometry.remove","name":"cap2"}"#);
    // a cut in use cannot be removed; retarget then remove
    assert_eq!(err(&mut e, r#"{"cmd":"geometry.remove","name":"hole"}"#).code, ErrorCode::InUse);
    ok(&mut e, r#"{"cmd":"load.remove","name":"p"}"#);
    ok(&mut e, r#"{"cmd":"geometry.remove","name":"hole"}"#);
    assert_eq!(e.model().cuts.len(), 1);
    // a set in use cannot be removed
    assert_eq!(err(&mut e, r#"{"cmd":"geometry.remove","name":"cap"}"#).code, ErrorCode::InUse);
    // removing a body also removes its cuts
    ok(&mut e, r#"{"cmd":"geometry.remove","name":"girder2"}"#);
    assert!(e.model().cuts.is_empty());
    // a body referenced by a region set or a temperature load is in use
    assert_eq!(err(&mut e, r#"{"cmd":"geometry.remove","name":"girder"}"#).code, ErrorCode::InUse);
}

#[test]
fn geometry_add_and_subtract_shapes_and_sheets() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"g"}"#);
    ok(
        &mut e,
        r#"{"cmd":"geometry.add","name":"tube","shape":{"kind":"revolve","angle":90,"sketch":{"outer":[{"kind":"line","to":["200 mm","0 mm"],"tag":"bottom"},{"kind":"line","to":["200 mm","100 mm"],"tag":"outer"},{"kind":"line","to":["100 mm","100 mm"],"tag":"top"},{"kind":"line","to":["100 mm","0 mm"],"tag":"inner"}]}}}"#,
    );
    ok(
        &mut e,
        r#"{"cmd":"geometry.subtract","name":"bore","from":"tube","shape":{"kind":"cylinder","radius":"20 mm","height":"1 m","at":["150 mm","0 mm","-0.5 m"]}}"#,
    );
    let QueryResult::Model(m) = e.query(Query::Model {}).unwrap() else { panic!() };
    let faces = &m.bodies[0].faces;
    for f in ["tube.bottom", "tube.inner", "tube.outer", "tube.top", "tube.theta0", "tube.theta1", "bore.side"] {
        assert!(faces.contains(&f.to_string()), "{f} missing from {faces:?}");
    }
    // re-issuing a cut edits it in place
    let a = ok(
        &mut e,
        r#"{"cmd":"geometry.subtract","name":"bore","from":"tube","shape":{"kind":"cylinder","radius":"10 mm","height":"1 m","at":["150 mm","0 mm","-0.5 m"]}}"#,
    );
    assert_eq!(a.output, Output::Replaced { kind: ObjectKind::Body, name: "bore".into() });
    assert_eq!(e.model().cuts.len(), 1);
    // a body name cannot reuse a cut name
    assert_eq!(
        err(&mut e, r#"{"cmd":"geometry.addBox","name":"bore","size":["1 m","1 m","1 m"]}"#).code,
        ErrorCode::NameTaken
    );
    // 2D
    ok(&mut e, r#"{"cmd":"model.new","name":"plate"}"#);
    ok(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStress","thickness":"10 mm"}}"#);
    ok(
        &mut e,
        r#"{"cmd":"geometry.add","name":"plate","shape":{"kind":"sheet","sketch":{"outer":[{"kind":"line","to":["100 mm","0 mm"],"tag":"ymin"},{"kind":"line","to":["100 mm","50 mm"],"tag":"xmax"},{"kind":"line","to":["0 mm","50 mm"],"tag":"ymax"},{"kind":"line","to":["0 mm","0 mm"],"tag":"xmin"}],"holes":[[{"kind":"arc","center":["50 mm","25 mm"],"to":["40 mm","25 mm"],"ccw":true,"tag":"hole"},{"kind":"arc","center":["50 mm","25 mm"],"to":["60 mm","25 mm"],"ccw":true,"tag":"hole"}]]}}}"#,
    );
    let QueryResult::Model(m) = e.query(Query::Model {}).unwrap() else { panic!() };
    assert!(m.idealisation.starts_with("planeStress"));
    assert_eq!(m.bodies[0].measure.unit, "m^2");
    assert!((m.bodies[0].measure.value - (0.005 - std::f64::consts::PI * 1e-4)).abs() < 1e-12);
    assert!(m.bodies[0].mass.is_none());
    assert_eq!(m.bodies[0].faces, ["plate.hole", "plate.xmax", "plate.xmin", "plate.ymax", "plate.ymin"]);
    assert!(m.warnings.iter().all(|w| w.code != "model.ill-posed"));
    ok(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"solid3d"}}"#);
    let QueryResult::Model(m) = e.query(Query::Model {}).unwrap() else { panic!() };
    assert!(m.warnings.iter().any(|w| w.code == "model.ill-posed"));
    ok(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStrain"}}"#);
    ok(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"axisymmetric"}}"#);
    let QueryResult::Model(m) = e.query(Query::Model {}).unwrap() else { panic!() };
    assert_eq!(m.idealisation, "axisymmetric");
    let QueryResult::Model(m0) = Engine::new(None, Box::new(NoClock), 1).query(Query::Model {}).unwrap() else {
        panic!()
    };
    assert!(m0.warnings.iter().any(|w| w.code == "model.empty"));
}

#[test]
fn file_round_trip_replay_and_divergence() {
    let mut e = engine();
    cantilever(&mut e);
    let file = e.export_file();
    assert_eq!(file.format, "femlab/1");
    let json = serde_json::to_string(&file).unwrap();
    let mut e2 = engine();
    e2.import_file(serde_json::from_str(&json).unwrap()).unwrap();
    assert_eq!(e2.model_hash(), e.model_hash());
    assert_eq!(e2.revision(), 9);
    assert!(!e2.can_undo());
    let mut bad = file.clone();
    bad.format = "femlab/0".into();
    assert_eq!(e2.import_file(bad).unwrap_err().code, ErrorCode::Schema);
    // replay reproduces every hash
    let mut e3 = engine();
    let hashes = pollster::block_on(e3.replay(&file.journal.entries, false, true)).unwrap();
    assert_eq!(hashes.len(), 9);
    assert_eq!(hashes[8], e.model_hash());
    assert_eq!(e3.revision(), 9);
    assert!(e3.can_undo(), "replay rebuilds the undo stack");
    // a tampered hash is detected with its seq
    let mut tampered = file.journal.entries.clone();
    tampered[4].hash_after = "deadbeef".into();
    let er = pollster::block_on(e3.replay(&tampered, false, true)).unwrap_err();
    assert_eq!(er.code, ErrorCode::Internal);
    assert!(er.cause.contains("entry 4"));
    // unverified replay ignores hashes
    assert!(pollster::block_on(e3.replay(&tampered, false, false)).is_ok());
    // a failing command is reported with its entry
    let mut broken = file.journal.entries.clone();
    broken[2].cmd = Command::MaterialAssign { material: "gold".into(), bodies: vec![] };
    let er = pollster::block_on(e3.replay(&broken, false, false)).unwrap_err();
    assert_eq!(er.where_.as_deref(), Some("journal entry 2"));
    // solves are skipped when asked and still appended
    let mut with_solve = file.journal.entries.clone();
    with_solve.push(femlab_engine::JournalEntry {
        seq: 9,
        cmd: Command::SolveRun {
            step: "static".into(),
            solver: Some(Solver::Auto),
            tolerance: None,
            max_iterations: None,
        },
        hash_after: e.model_hash(),
    });
    let hashes = pollster::block_on(e3.replay(&with_solve, true, true)).unwrap();
    assert_eq!(hashes.len(), 10);
    assert_eq!(e3.revision(), 10);
}

#[test]
fn convert_query() {
    let mut e = engine();
    let QueryResult::Converted(c) =
        e.query(Query::Convert { quantity: Quantity::text("2 MPa"), to: "psi".into() }).unwrap()
    else {
        panic!()
    };
    assert!((c.value - 290.075).abs() < 1e-2);
    assert_eq!(c.unit, "psi");
    let QueryResult::Converted(c) = e
        .query(Query::Convert { quantity: Quantity::Parts { value: 1.0, unit: "m".into() }, to: "mm".into() })
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(c.value, 1000.0);
    let QueryResult::Converted(c) =
        e.query(Query::Convert { quantity: Quantity::text("100 degC"), to: "K".into() }).unwrap()
    else {
        panic!()
    };
    assert!((c.value - 373.15).abs() < 1e-9);
    let er = e.query(Query::Convert { quantity: Quantity::text("2 MPa"), to: "mm".into() }).unwrap_err();
    assert_eq!(er.code, ErrorCode::UnitDimension);
    let er = e.query(Query::Convert { quantity: Quantity::text("2 zork"), to: "mm".into() }).unwrap_err();
    assert_eq!(er.code, ErrorCode::UnitUnknown);
    let er = e.query(Query::Convert { quantity: Quantity::text("abc"), to: "mm".into() }).unwrap_err();
    assert_eq!(er.code, ErrorCode::Schema);
    assert_eq!(
        e.query(Query::Convert { quantity: Quantity::text("2"), to: "mm".into() }).unwrap_err().code,
        ErrorCode::UnitUnknown
    );
    assert_eq!(
        e.query(Query::Convert { quantity: Quantity::Parts { value: 1.0, unit: "zork".into() }, to: "mm".into() })
            .unwrap_err()
            .code,
        ErrorCode::UnitUnknown
    );
}

#[test]
fn enum_helpers_used_by_hosts() {
    // exercised here so the command module's helpers are part of the public contract
    assert_eq!(Axis::Z.index(), 2);
    assert_eq!(Procedure::Static, Procedure::Static);
    let spec = IdealisationSpec::PlaneStrain;
    assert_eq!(serde_json::to_string(&spec).unwrap(), r#"{"kind":"planeStrain"}"#);
    let m = MesherSpec::Lattice { size: LatticeSize::Counts { nx: 1, ny: 2, nz: 3 } };
    assert!(serde_json::to_string(&m).unwrap().contains("\"nx\":1"));
    let p = FacePredicate::Normal { normal: [0.0, 0.0, 1.0], max_angle_deg: None };
    assert!(p.to_si().is_ok());
    let r = RegionPredicate::Body { name: "b".into() };
    assert!(r.to_si().is_ok());
}

// ---- more paths: every name/unit error site, rename with several objects, imported files

fn code(e: &mut Engine, json: &str) -> ErrorCode {
    run(e, json).err().map(|e| e.code).expect("should fail")
}

fn where_(e: &mut Engine, json: &str) -> String {
    run(e, json).err().and_then(|e| e.where_).expect("should fail with a location")
}

#[test]
fn every_create_command_validates_its_name() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"n"}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"b","size":["1 m","1 m","1 m"]}"#);
    for json in [
        r#"{"cmd":"geometry.add","name":"a.b","shape":{"kind":"box","size":["1 m","1 m","1 m"]}}"#,
        r#"{"cmd":"geometry.subtract","name":"a b","from":"b","shape":{"kind":"box","size":["1 m","1 m","1 m"]}}"#,
        r#"{"cmd":"geometry.nameFace","name":"","of":"b","where":{"kind":"normal","normal":[0,0,1]}}"#,
        r#"{"cmd":"geometry.nameRegion","name":"a:b","where":{"kind":"body","name":"b"}}"#,
        r#"{"cmd":"constraint.fix","name":"a.b","on":"b.xmin"}"#,
        r#"{"cmd":"constraint.prescribe","name":"a.b","on":"b.xmin","dof":"ux","value":"1 mm"}"#,
        r#"{"cmd":"constraint.symmetry","name":"a.b","on":"b.xmin","normal":"x"}"#,
        r#"{"cmd":"load.pressure","name":"a.b","on":"b.xmin","value":"1 Pa"}"#,
        r#"{"cmd":"load.traction","name":"a.b","on":"b.xmin","total":["0 N","0 N","0 N"]}"#,
        r#"{"cmd":"load.force","name":"a.b","on":"b.xmin","total":["0 N","0 N","0 N"]}"#,
        r#"{"cmd":"load.gravity","name":"a.b","g":["0 m/s^2","0 m/s^2","0 m/s^2"]}"#,
        r#"{"cmd":"load.temperature","name":"a.b","bodies":["b"],"value":"300 K"}"#,
        r#"{"cmd":"step.add","name":"a.b","procedure":"static","constraints":[],"loads":[]}"#,
    ] {
        assert_eq!(where_(&mut e, json), "name", "{json}");
    }
    // unit errors at every optional material field
    assert_eq!(where_(&mut e, r#"{"cmd":"material.add","name":"m","E":"1 GPa","nu":0.3,"alpha":"1 m"}"#), "alpha");
    assert_eq!(where_(&mut e, r#"{"cmd":"material.add","name":"m","E":"1 GPa","nu":0.3,"k":"1 m"}"#), "k");
    assert_eq!(where_(&mut e, r#"{"cmd":"material.add","name":"m","E":"1 GPa","nu":0.3,"cp":"1 m"}"#), "cp");
    assert_eq!(where_(&mut e, r#"{"cmd":"material.add","name":"m","E":"1 GPa","nu":0.3,"yield":"1 m"}"#), "yield");
    ok(
        &mut e,
        r#"{"cmd":"material.add","name":"full","E":"1 GPa","nu":0.3,"alpha":"1e-5 1/K","k":"50 W/(m K)","cp":"460 J/(kg K)","yield":"355 MPa"}"#,
    );
    // unit errors inside shapes of subtract commands
    assert_eq!(
        code(
            &mut e,
            r#"{"cmd":"geometry.subtractBox","name":"h","from":"b","size":["1 kg","1 m","1 m"],"at":["0 m","0 m","0 m"]}"#
        ),
        ErrorCode::UnitDimension
    );
    assert_eq!(
        code(
            &mut e,
            r#"{"cmd":"geometry.subtract","name":"h","from":"b","shape":{"kind":"box","size":["1 kg","1 m","1 m"]}}"#
        ),
        ErrorCode::UnitDimension
    );
    // a shape that converts but fails geometric validation
    assert_eq!(
        code(
            &mut e,
            r#"{"cmd":"geometry.add","name":"c","shape":{"kind":"cylinder","radius":"1 m","height":"1 m","segments":2}}"#
        ),
        ErrorCode::Schema
    );
    // a valid shape whose evaluation is empty (disjoint intersection)
    let er = run(&mut e, r#"{"cmd":"geometry.add","name":"empty","shape":{"kind":"intersect","shapes":[{"kind":"box","size":["1 m","1 m","1 m"]},{"kind":"box","size":["1 m","1 m","1 m"],"at":["5 m","0 m","0 m"]}]}}"#).unwrap_err();
    assert!(er.cause.contains("empty"), "{er:?}");
    // prescribe on an unknown set
    assert_eq!(
        code(&mut e, r#"{"cmd":"constraint.prescribe","name":"p","on":"nope","dof":"ux","value":"1 mm"}"#),
        ErrorCode::NotFound
    );
    // lattice counts
    assert_eq!(
        where_(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":1,"ny":0,"nz":1}}}"#),
        "mesher.size"
    );
    assert_eq!(
        where_(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":1,"ny":1,"nz":0}}}"#),
        "mesher.size"
    );
    ok(
        &mut e,
        r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":4,"ny":2,"nz":2}},"order":2,"formulation":"full"}"#,
    );
    let ms = e.model().mesh.clone().unwrap();
    assert_eq!(ms.order, 2);
    assert_eq!(ms.formulation, femlab_engine::command::Formulation::Full);
    // a set name that exists makes the not-found suggestion list it
    ok(&mut e, r#"{"cmd":"geometry.nameFace","name":"top","of":"b","where":{"kind":"normal","normal":[0,0,1]}}"#);
    let er = run(&mut e, r#"{"cmd":"constraint.fix","name":"c","on":"nope"}"#).unwrap_err();
    assert!(er.suggestion.as_deref().unwrap().contains("geometry.nameFace"));
    // constraints on a cut's faces keep the cut in use; unknown removals list cuts
    ok(
        &mut e,
        r#"{"cmd":"geometry.subtractBox","name":"hole","from":"b","size":["0.2 m","0.2 m","2 m"],"at":["0.4 m","0.4 m","-0.5 m"]}"#,
    );
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"wall","on":"hole.xmin"}"#);
    assert_eq!(code(&mut e, r#"{"cmd":"geometry.remove","name":"hole"}"#), ErrorCode::InUse);
    let er = run(&mut e, r#"{"cmd":"geometry.remove","name":"ghost"}"#).unwrap_err();
    assert!(er.suggestion.as_deref().unwrap().contains("hole"));
    assert_eq!(e.solid("nope").unwrap_err().code, ErrorCode::NotFound);
}

#[test]
fn rename_with_several_objects_touches_only_the_named_one() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"n"}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"a","size":["1 m","1 m","1 m"]}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"b","size":["1 m","1 m","1 m"],"at":["2 m","0 m","0 m"]}"#);
    ok(
        &mut e,
        r#"{"cmd":"geometry.subtractBox","name":"ha","from":"a","size":["0.2 m","0.2 m","2 m"],"at":["0.4 m","0.4 m","-0.5 m"]}"#,
    );
    ok(
        &mut e,
        r#"{"cmd":"geometry.subtractBox","name":"hb","from":"b","size":["0.2 m","0.2 m","2 m"],"at":["2.4 m","0.4 m","-0.5 m"]}"#,
    );
    ok(&mut e, r#"{"cmd":"material.add","name":"m1","E":"1 GPa","nu":0.3}"#);
    ok(&mut e, r#"{"cmd":"material.add","name":"m2","E":"2 GPa","nu":0.3}"#);
    ok(&mut e, r#"{"cmd":"material.assign","material":"m1","bodies":["a"]}"#);
    ok(&mut e, r#"{"cmd":"material.assign","material":"m2","bodies":["b"]}"#);
    ok(&mut e, r#"{"cmd":"geometry.nameFace","name":"fa","of":"a","where":{"kind":"normal","normal":[0,0,1]}}"#);
    ok(&mut e, r#"{"cmd":"geometry.nameFace","name":"fb","of":"b","where":{"kind":"normal","normal":[0,0,1]}}"#);
    ok(&mut e, r#"{"cmd":"geometry.nameRegion","name":"ra","where":{"kind":"body","name":"a"}}"#);
    ok(&mut e, r#"{"cmd":"geometry.nameRegion","name":"rb","where":{"kind":"body","name":"b"}}"#);
    ok(
        &mut e,
        r#"{"cmd":"geometry.nameRegion","name":"box","where":{"kind":"bbox","min":["0 m","0 m","0 m"],"max":["1 m","1 m","1 m"]}}"#,
    );
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"ca","on":"a.xmin"}"#);
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"cb","on":"b.xmin"}"#);
    ok(&mut e, r#"{"cmd":"load.pressure","name":"pa","on":"a.zmax","value":"1 MPa"}"#);
    ok(&mut e, r#"{"cmd":"load.pressure","name":"pb","on":"b.zmax","value":"1 MPa"}"#);
    ok(&mut e, r#"{"cmd":"load.traction","name":"tra","on":"a.zmax","total":["0 N","0 N","1 N"]}"#);
    ok(&mut e, r#"{"cmd":"load.force","name":"fa","on":"fa","total":["0 N","0 N","1 N"]}"#);
    ok(&mut e, r#"{"cmd":"load.traction","name":"trfa","on":"fa","total":["0 N","0 N","1 N"]}"#);
    ok(&mut e, r#"{"cmd":"load.temperature","name":"ta","bodies":["a"],"value":"300 K"}"#);
    ok(&mut e, r#"{"cmd":"load.temperature","name":"tb","bodies":["b"],"value":"300 K"}"#);
    ok(&mut e, r#"{"cmd":"load.gravity","name":"g","g":["0 m/s^2","0 m/s^2","-9.81 m/s^2"]}"#);
    ok(&mut e, r#"{"cmd":"step.add","name":"s1","procedure":"static","constraints":["ca"],"loads":["pa"]}"#);
    ok(&mut e, r#"{"cmd":"step.add","name":"s2","procedure":"static","constraints":["cb"],"loads":["pb"]}"#);
    ok(&mut e, r#"{"cmd":"model.rename","kind":"body","name":"a","to":"aa"}"#);
    let m = e.model();
    assert_eq!(m.bodies[1].name, "b");
    assert_eq!(m.cuts[1].from, "b");
    assert_eq!(m.constraints[1].on, "b.xmin");
    assert_eq!(m.loads[1].kind.set(), Some("b.zmax"));
    assert_eq!(m.loads[0].kind.set(), Some("aa.zmax"));
    assert!(matches!(&m.sets[1].source, femlab_engine::model::SetSource::Face { of, .. } if of == "b"));
    ok(&mut e, r#"{"cmd":"model.rename","kind":"material","name":"m1","to":"mm1"}"#);
    let m = e.model();
    assert_eq!(m.materials[1].name, "m2");
    assert_eq!(m.bodies[1].material.as_deref(), Some("m2"));
    assert_eq!(m.bodies[0].material.as_deref(), Some("mm1"));
    ok(&mut e, r#"{"cmd":"model.rename","kind":"constraint","name":"ca","to":"caa"}"#);
    assert_eq!(e.model().steps[1].constraints, ["cb"]);
    ok(&mut e, r#"{"cmd":"model.rename","kind":"load","name":"pa","to":"paa"}"#);
    assert_eq!(e.model().steps[1].loads, ["pb"]);
    ok(&mut e, r#"{"cmd":"model.rename","kind":"step","name":"s1","to":"s11"}"#);
    assert_eq!(e.model().steps[1].name, "s2");
    ok(&mut e, r#"{"cmd":"model.rename","kind":"set","name":"fa","to":"faa"}"#);
    assert_eq!(e.model().sets[1].name, "fb");
    assert_eq!(e.model().load("fa").unwrap().kind.set(), Some("faa"));
    assert_eq!(e.model().load("trfa").unwrap().kind.set(), Some("faa"));
    assert_eq!(e.model().load("tra").unwrap().kind.set(), Some("aa.zmax"));
    let QueryResult::Objects(o) = e.query(Query::Objects { kinds: Some(vec![ObjectKind::Set]) }).unwrap() else {
        panic!()
    };
    assert!(o.objects.iter().any(|x| x.ref_ == "set:faa"));
    assert!(o.objects.iter().any(|x| x.ref_ == "set:ha.*"));
    let QueryResult::Objects(o) = e.query(Query::Objects { kinds: Some(vec![ObjectKind::Load]) }).unwrap() else {
        panic!()
    };
    assert!(o.objects.iter().any(|x| x.name == "g" && x.summary == "body load"));
}

#[test]
fn objects_and_idealisation_strings_for_2d() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"n"}"#);
    ok(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStrain"}}"#);
    ok(
        &mut e,
        r#"{"cmd":"geometry.add","name":"sheet","shape":{"kind":"sheet","sketch":{"outer":[{"kind":"line","to":["1 m","0 m"]},{"kind":"line","to":["1 m","1 m"]},{"kind":"line","to":["0 m","1 m"]},{"kind":"line","to":["0 m","0 m"]}]}}}"#,
    );
    let QueryResult::Model(m) = e.query(Query::Model {}).unwrap() else { panic!() };
    assert_eq!(m.idealisation, "planeStrain");
    let QueryResult::Objects(o) = e.query(Query::Objects { kinds: Some(vec![ObjectKind::Body]) }).unwrap() else {
        panic!()
    };
    assert!(o.objects[0].summary.starts_with("2D body"));
}

#[test]
fn imported_file_with_a_broken_shape_fails_at_query_time() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"n"}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"b","size":["1 m","1 m","1 m"]}"#);
    let mut file = e.export_file();
    file.model.bodies[0].shape = femlab_geometry::Shape::Box { size: [0.0; 3] };
    e.import_file(file).unwrap();
    let er = e.query(Query::Model {}).unwrap_err();
    assert_eq!(er.code, ErrorCode::Schema);
    assert_eq!(er.where_.as_deref(), Some("body 'b'"));
    // the Mesh and the viewer surfaces need the same Solids, so they fail the same way
    assert_eq!(e.query(Query::Mesh {}).unwrap_err().code, ErrorCode::Schema);
    assert_eq!(e.geometry_surface().unwrap_err().code, ErrorCode::Schema);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"1 m"}}"#);
    assert_eq!(e.mesh().unwrap_err().code, ErrorCode::Schema);
    assert_eq!(e.mesh_surface().unwrap_err().code, ErrorCode::Schema);
    assert_eq!(e.query(Query::Set { name: "b.xmin".into() }).unwrap_err().code, ErrorCode::Schema);
    assert_eq!(err(&mut e, r#"{"cmd":"mesh.export","format":"vtu"}"#).code, ErrorCode::Schema);
}

#[test]
fn convert_query_variants() {
    let mut e = engine();
    assert_eq!(
        e.query(Query::Convert { quantity: Quantity::text("5e mm"), to: "m".into() }).unwrap_err().code,
        ErrorCode::UnitUnknown
    );
    let QueryResult::Converted(c) = e
        .query(Query::Convert { quantity: Quantity::Parts { value: 1.0, unit: "kN".into() }, to: "N".into() })
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(c.value, 1000.0);
}

// ---- the derived Mesh: query.mesh, query.set, mesh.export ------------------------------------

fn mesh_summary(e: &mut Engine) -> femlab_engine::query::MeshSummary {
    let QueryResult::Mesh(m) = e.query(Query::Mesh {}).unwrap() else { panic!("query.mesh") };
    m
}

fn set_info(e: &mut Engine, name: &str) -> femlab_engine::query::SetInfo {
    let QueryResult::Set(s) = e.query(Query::Set { name: name.into() }).unwrap() else { panic!("query.set") };
    s
}

#[test]
fn the_cantilever_meshes_and_every_auto_face_resolves() {
    let mut e = engine();
    cantilever(&mut e);
    // 1 m x 100 mm x 100 mm at 25 mm: 40 x 4 x 4 cells, 41 x 5 x 5 nodes
    let m = mesh_summary(&mut e);
    assert_eq!(m.elements, 640);
    assert_eq!(m.nodes, 1025);
    assert_eq!(m.element_kind, "hex8");
    assert_eq!(m.dofs, 3075);
    assert_eq!(m.bbox[3].value, 1000.0);
    assert_eq!(m.bbox[3].unit, "mm");
    assert!((m.min_edge.value - 25.0).abs() < 1e-9, "{:?}", m.min_edge);
    assert!((m.max_edge.value - 25.0).abs() < 1e-9);
    let q = m.quality.as_ref().unwrap();
    assert!((q.min_det_j_ratio - 1.0).abs() < 1e-12);
    assert!((q.max_aspect - 1.0).abs() < 1e-12);
    assert!((q.min_angle_deg - 90.0).abs() < 1e-9);
    assert_eq!(q.worst.len(), 10);
    assert_eq!(q.worst[0].value, 1.0);
    // every auto face Set of the Body is there and non-empty
    let names: Vec<&str> = m.sets.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["beam.xmax", "beam.xmin", "beam.ymax", "beam.ymin", "beam.zmax", "beam.zmin"]);
    assert!(m.sets.iter().all(|s| s.kind == "face"));
    assert_eq!(m.sets[1].summary, "16 faces");

    let s = set_info(&mut e, "beam.xmin");
    assert_eq!(s.kind, "face");
    assert_eq!(s.count, 16);
    assert!((s.measure.value - 1e4).abs() < 1e-6, "{:?}", s.measure);
    assert_eq!(s.measure.unit, "mm^2");
    assert_eq!(s.centroid[0].value, 0.0);
    assert!((s.centroid[1].value - 50.0).abs() < 1e-9);
    assert_eq!(s.bbox[3].value, 0.0);
    assert_eq!(e.query(Query::Set { name: "nope".into() }).unwrap_err().code, ErrorCode::NotFound);

    // the mesh is derived: the same Model hash, a lazily rebuilt Mesh after mesh.set
    let hash = e.model_hash();
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":4,"ny":1,"nz":1}}}"#);
    assert_ne!(e.model_hash(), hash);
    assert_eq!(mesh_summary(&mut e).elements, 4);
    // and a second read uses the cache
    assert_eq!(mesh_summary(&mut e).elements, 4);
    assert_eq!(e.mesh_surface().unwrap().triangles.len(), 2 * (1 + 1 + 4 * 4));
    assert_eq!(e.geometry_surface().unwrap()[0].0, "beam");
}

#[test]
fn named_sets_resolve_and_an_empty_one_points_at_the_nearest_face() {
    let mut e = engine();
    cantilever(&mut e);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":4,"ny":1,"nz":1}}}"#);
    ok(&mut e, r#"{"cmd":"geometry.nameFace","name":"top","of":"beam","where":{"kind":"normal","normal":[0,0,1]}}"#);
    ok(
        &mut e,
        r#"{"cmd":"geometry.nameRegion","name":"tip","where":{"kind":"bbox","min":["0.7 m","0 m","0 m"],"max":["1 m","1 m","1 m"]}}"#,
    );
    ok(&mut e, r#"{"cmd":"geometry.nameRegion","name":"whole","where":{"kind":"body","name":"beam"}}"#);
    let top = set_info(&mut e, "top");
    assert_eq!(top.kind, "face");
    assert_eq!(top.count, 4);
    assert!((top.measure.value - 1e5).abs() < 1e-6, "{:?}", top.measure);
    let tip = set_info(&mut e, "tip");
    assert_eq!(tip.kind, "element");
    assert_eq!(tip.count, 1);
    assert!((tip.measure.value - 250.0 * 100.0 * 100.0).abs() < 1e-3, "{:?}", tip.measure);
    assert_eq!(tip.measure.unit, "mm^3");
    let whole = set_info(&mut e, "whole");
    assert_eq!(whole.count, 4);
    assert!((whole.measure.value - 1e7).abs() < 1e-3);
    // a region that catches no whole element is a node Set instead
    ok(
        &mut e,
        r#"{"cmd":"geometry.nameRegion","name":"end","where":{"kind":"bbox","min":["0.9 m","0 m","0 m"],"max":["1 m","1 m","1 m"]}}"#,
    );
    let end = set_info(&mut e, "end");
    assert_eq!(end.kind, "node");
    assert_eq!(end.count, 4);
    assert_eq!(end.measure.value, 0.0);
    assert!((end.centroid[0].value - 1000.0).abs() < 1e-9);
    // Sets resolve when the Mesh is built, so a predicate that matches nothing fails there,
    // naming the nearest boundary face
    ok(
        &mut e,
        r#"{"cmd":"geometry.nameFace","name":"ghost","of":"beam","where":{"kind":"plane","normal":[1,0,0],"offset":"2 m"}}"#,
    );
    let er = e.query(Query::Mesh {}).unwrap_err();
    assert_eq!(er.code, ErrorCode::SetEmpty);
    assert!(er.cause.contains("set 'ghost'"), "{}", er.cause);
    assert!(er.cause.contains("nearest boundary face is centred at [1000, 50, 50] mm"), "{}", er.cause);
    assert_eq!(er.where_.as_deref(), Some("set 'ghost'"));
    assert!(er.suggestion.as_deref().unwrap().contains("geometry.nameFace"));
    // undoing it makes the Mesh buildable again
    ok(&mut e, r#"{"cmd":"journal.undo"}"#);
    assert_eq!(mesh_summary(&mut e).elements, 4);
}

#[test]
fn a_mesh_needs_settings_bodies_and_a_matching_idealisation() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"m"}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"b","size":["1 m","1 m","1 m"]}"#);
    let er = e.query(Query::Mesh {}).unwrap_err();
    assert_eq!(er.code, ErrorCode::ModelIllPosed);
    assert_eq!(er.cause, "no mesh settings; call mesh.set");
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":2,"ny":2,"nz":2}}}"#);
    assert_eq!(mesh_summary(&mut e).elements, 8);
    // a 3D body under a 2D idealisation is ill-posed
    ok(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStrain"}}"#);
    let er = e.query(Query::Mesh {}).unwrap_err();
    assert_eq!(er.code, ErrorCode::ModelIllPosed);
    assert!(er.cause.contains("is 3D but the idealisation is 2D"), "{}", er.cause);
    // a Model with no Body has nothing to mesh
    ok(&mut e, r#"{"cmd":"model.new","name":"empty"}"#);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"1 m"}}"#);
    assert_eq!(e.query(Query::Mesh {}).unwrap_err().cause, "the Model has no Body to mesh");
}

#[test]
fn a_lattice_that_catches_nothing_is_a_mesh_failure() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"ring"}"#);
    ok(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStrain"}}"#);
    ok(
        &mut e,
        r#"{"cmd":"geometry.add","name":"ring","shape":{"kind":"sheet","sketch":{"outer":[
          {"kind":"arc","center":["0 m","0 m"],"to":["-1 m","0 m"],"ccw":true,"tag":"outer"},
          {"kind":"arc","center":["0 m","0 m"],"to":["1 m","0 m"],"ccw":true,"tag":"outer"}],
          "holes":[[{"kind":"arc","center":["0 m","0 m"],"to":["-0.4 m","0 m"],"ccw":true,"tag":"bore"},
          {"kind":"arc","center":["0 m","0 m"],"to":["0.4 m","0 m"],"ccw":true,"tag":"bore"}]]}}}"#,
    );
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":6,"ny":6,"nz":1}}}"#);
    let m = mesh_summary(&mut e);
    assert_eq!(m.element_kind, "quad4");
    assert_eq!(m.dofs, 2 * m.nodes);
    assert!(m.sets.iter().any(|s| s.name == "ring.bore"), "{:?}", m.sets);
    let bore = set_info(&mut e, "ring.bore");
    assert_eq!(bore.kind, "face");
    assert!(bore.measure.value > 0.0);
    assert_eq!(bore.measure.unit, "m");
    // a 2D element Set measures area
    ok(&mut e, r#"{"cmd":"geometry.nameRegion","name":"all","where":{"kind":"body","name":"ring"}}"#);
    let all = set_info(&mut e, "all");
    assert_eq!(all.kind, "element");
    assert_eq!(all.count, m.elements);
    assert_eq!(all.measure.unit, "m^2");
    // a stair-stepped 6 x 6 lattice over an annulus of area pi(1 - 0.16) = 2.64 m^2 overshoots
    assert!((2.0..3.5).contains(&all.measure.value), "{:?}", all.measure);
    // one cell over the whole annulus is centred in the bore, so nothing is inside
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":1,"ny":1,"nz":1}}}"#);
    let er = e.query(Query::Mesh {}).unwrap_err();
    assert_eq!(er.code, ErrorCode::MeshFailed);
    assert_eq!(er.where_.as_deref(), Some("body 'ring'"));
}

#[test]
fn two_bodies_become_two_blocks_and_export_as_vtu() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"pair"}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"a","size":["1 m","1 m","1 m"]}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"b","size":["1 m","1 m","1 m"],"at":["2 m","0 m","0 m"]}"#);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":2,"ny":1,"nz":1}},"order":2}"#);
    let m = mesh_summary(&mut e);
    assert_eq!(m.elements, 4);
    assert_eq!(m.element_kind, "hex20");
    let built = e.mesh().unwrap();
    assert_eq!(built.body_of_block, ["a", "b"]);
    assert_eq!(built.body_of_elem(0), "a");
    assert_eq!(built.body_of_elem(3), "b");
    assert_eq!(built.mesh.elem_sets["all"].len(), 4);
    // node sets of a face Set are the nodes of its faces
    assert_eq!(built.sets["a.xmin"].nodes.len(), 8);
    assert_eq!(built.sets["a.xmin"].count(), 1);

    let ack = ok(&mut e, r#"{"cmd":"mesh.export","format":"vtu"}"#);
    let Output::Export { format, filename, mime, text } = ack.output else { panic!("expected an export") };
    assert_eq!(format, femlab_engine::command::ExportFormat::Vtu);
    assert_eq!(filename, "pair.vtu");
    assert_eq!(mime, "application/xml");
    assert!(text.contains(r#"NumberOfPoints="64""#), "{}", &text[..200]);
    assert!(text.contains(r#"NumberOfCells="4""#));
    assert!(text.contains(r#"Name="ElementId""#) && text.contains(r#"Name="Body""#));
    assert_eq!(err(&mut e, r#"{"cmd":"mesh.export","format":"vtu","step":"static"}"#).code, ErrorCode::Unsupported);
}

#[test]
fn the_vtu_writer_round_trips_through_base64() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"two"}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"b","size":["2 m","1 m","1 m"]}"#);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":2,"ny":1,"nz":1}}}"#);
    let mesh = &e.mesh().unwrap().mesh;
    let temperature: Vec<f64> = (0..mesh.n_nodes()).map(|n| n as f64 * 0.5).collect();
    let text = femlab_engine::io::write_vtu(mesh, &[("T", 1, &temperature)], &[("Id", 1, &[0.0, 1.0])]);
    // ParaView needs these attributes to open the file at all
    for want in [
        r#"type="UnstructuredGrid""#,
        r#"byte_order="LittleEndian""#,
        r#"header_type="UInt64""#,
        r#"NumberOfPoints="12""#,
        r#"NumberOfCells="2""#,
        r#"<DataArray type="Float64" Name="Points" NumberOfComponents="3" format="binary">"#,
        r#"Name="connectivity""#,
        r#"Name="offsets""#,
        r#"<DataArray type="UInt8" Name="types""#,
        "</VTKFile>",
    ] {
        assert!(text.contains(want), "missing {want}");
    }
    // decode the payloads back and check the numbers
    assert_eq!(decode_f64(&text, "Points"), mesh.coords);
    assert_eq!(
        decode_i64(&text, "connectivity"),
        mesh.elem_nodes(0).iter().chain(mesh.elem_nodes(1)).map(|&n| i64::from(n)).collect::<Vec<_>>()
    );
    assert_eq!(decode_i64(&text, "offsets"), [8, 16]);
    assert_eq!(decode_u8(&text, "types"), [12, 12]);
    assert_eq!(decode_f64(&text, "T"), temperature);
    assert_eq!(decode_f64(&text, "Id"), [0.0, 1.0]);
    // base64 pads a payload of any length
    assert_eq!(femlab_engine::io::vtu::base64(b"f"), "Zg==");
    assert_eq!(femlab_engine::io::vtu::base64(b"fo"), "Zm8=");
    assert_eq!(femlab_engine::io::vtu::base64(b"foo"), "Zm9v");
    assert_eq!(femlab_engine::io::vtu::base64(&[0xff, 0xef, 0xfe]), "/+/+");

    // every element kind writes its VTK cell type; no node permutation, so the connectivity
    // comes back exactly as the Mesh stores it
    use femlab_geometry::{ElementKind, Structured};
    for (kind, want) in [
        (ElementKind::Hex8, 12u8),
        (ElementKind::Hex20, 25),
        (ElementKind::Tet4, 10),
        (ElementKind::Tet10, 24),
        (ElementKind::Quad4, 9),
        (ElementKind::Quad8, 23),
        (ElementKind::Tri3, 5),
        (ElementKind::Tri6, 22),
    ] {
        let m = Structured { kind, n: [1, 1, 1] }.box_([1.0, 1.0, 1.0]);
        let t = femlab_engine::io::write_vtu(&m, &[], &[]);
        assert_eq!(decode_u8(&t, "types"), vec![want; m.n_elems()], "{kind:?}");
        assert_eq!(decode_f64(&t, "Points"), m.coords, "{kind:?}");
        assert_eq!(decode_i64(&t, "offsets").last(), Some(&((m.n_elems() * kind.n_nodes()) as i64)), "{kind:?}");
    }
}

/// The payload of one named DataArray: the header block, then the data block, each base64.
fn decode_array(text: &str, name: &str) -> Vec<u8> {
    let at = text.find(&format!("Name=\"{name}\"")).expect("the array is in the file");
    let body = &text[at..];
    let start = body.find("binary\">").expect("binary payload") + "binary\">".len();
    let end = body.find("</DataArray>").expect("closed");
    let payload = &body[start..end];
    // a UInt64 header is 8 bytes, which base64 encodes in exactly 12 characters
    let bytes = from_base64(&payload[12..]);
    let len = u64::from_le_bytes(from_base64(&payload[..12])[..8].try_into().unwrap()) as usize;
    assert_eq!(len, bytes.len().min(len));
    bytes[..len].to_vec()
}

fn from_base64(s: &str) -> Vec<u8> {
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let digits: Vec<u32> =
        s.bytes().filter(|&c| c != b'=').map(|c| alphabet.iter().position(|&a| a == c).unwrap() as u32).collect();
    let mut out = Vec::new();
    for c in digits.chunks(4) {
        let mut n = 0u32;
        for (i, d) in c.iter().enumerate() {
            n |= d << (18 - 6 * i);
        }
        for i in 0..c.len() - 1 {
            out.push((n >> (16 - 8 * i)) as u8);
        }
    }
    out
}

fn decode_f64(text: &str, name: &str) -> Vec<f64> {
    decode_array(text, name).chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect()
}

fn decode_i64(text: &str, name: &str) -> Vec<i64> {
    decode_array(text, name).chunks_exact(8).map(|c| i64::from_le_bytes(c.try_into().unwrap())).collect()
}

fn decode_u8(text: &str, name: &str) -> Vec<u8> {
    decode_array(text, name)
}

/// C §7 C4: Cook's membrane as one mapped block, which is its own geometry.
const COOK: &str = r#"{"cmd":"mesh.set","mesher":{"kind":"mapped","blocks":[{
    "corners":[["0 m","0 m"],["48 m","44 m"],["48 m","60 m"],["0 m","44 m"]],
    "n":[4,4],"tags":["bottom","right","top","left"]}]}}"#;

#[test]
fn a_mapped_block_is_its_own_geometry_and_names_its_edges() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"cook"}"#);
    ok(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStress","thickness":"1 m"}}"#);
    ok(&mut e, COOK);
    let m = mesh_summary(&mut e);
    assert_eq!((m.nodes, m.elements, m.element_kind.as_str()), (25, 16, "quad4"));
    assert_eq!(m.dofs, 2 * m.nodes);
    assert_eq!(
        m.sets.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
        ["sheet.bottom", "sheet.left", "sheet.right", "sheet.top"]
    );
    let left = set_info(&mut e, "sheet.left");
    assert_eq!((left.kind.as_str(), left.count), ("face", 4));
    assert_eq!(left.measure.unit, "m");
    assert!((left.measure.value - 44.0).abs() < 1e-9, "{:?}", left.measure);
    assert!((set_info(&mut e, "sheet.right").measure.value - 16.0).abs() < 1e-9);
    // an implicit Body is a known Set prefix, so constraints and loads attach to it
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"root","on":"sheet.left"}"#);
    ok(&mut e, r#"{"cmd":"load.traction","name":"tip","on":"sheet.right","total":["0 N","1 N","0 N"]}"#);

    // order 2 gives quad8 with the same elements and the mid-side nodes
    ok(&mut e, &COOK.replace("}]}}", "}]},\"order\":2}"));
    let m = mesh_summary(&mut e);
    assert_eq!((m.nodes, m.elements, m.element_kind.as_str()), (65, 16, "quad8"));
    assert_eq!(set_info(&mut e, "sheet.left").count, 4);

    // the same blocks under a 3D idealisation are ill posed, and say so
    ok(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"solid3d"}}"#);
    let er = e.query(Query::Mesh {}).unwrap_err();
    assert_eq!(er.code, ErrorCode::ModelIllPosed);
    assert_eq!(er.where_.as_deref(), Some("mesher"));
    assert!(er.suggestion.as_deref().unwrap().contains("setIdealisation"));
}

#[test]
fn the_kirsch_quarter_plate_is_two_mapped_blocks_with_a_graded_hole() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"kirsch"}"#);
    ok(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStress","thickness":"1 mm"}}"#);
    ok(
        &mut e,
        r#"{"cmd":"mesh.set","mesher":{"kind":"mapped","body":"plate","blocks":[
          {"corners":[["1 m","0 m"],["10 m","0 m"],["10 m","10 m"],["0.7071067811865476 m","0.7071067811865476 m"]],
           "edges":[{"kind":"line"},{"kind":"line"},{"kind":"line"},{"kind":"arc","center":["0 m","0 m"],"ccw":false}],
           "n":[4,4],"grading":[1.15,1.0],"tags":["ymin","xmax",null,"hole"]},
          {"corners":[["0.7071067811865476 m","0.7071067811865476 m"],["10 m","10 m"],["0 m","10 m"],["0 m","1 m"]],
           "edges":[{"kind":"line"},{"kind":"line"},{"kind":"line"},{"kind":"arc","center":["0 m","0 m"],"ccw":false}],
           "n":[4,4],"grading":[1.15,1.0],"tags":[null,"ymax","xmin","hole"]}]},"order":2}"#,
    );
    let m = mesh_summary(&mut e);
    assert_eq!((m.nodes, m.elements), (2 * (81 - 16) - 9, 32));
    assert_eq!(m.element_kind, "quad8");
    assert_eq!(
        m.sets.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
        ["plate.hole", "plate.xmax", "plate.xmin", "plate.ymax", "plate.ymin"]
    );
    // the hole is a quarter circle of radius 1 m, to the chord error of eight quad8 faces
    let hole = set_info(&mut e, "plate.hole");
    assert_eq!(hole.count, 8);
    assert!((hole.measure.value - std::f64::consts::FRAC_PI_2).abs() < 3e-3, "{:?}", hole.measure);
}

#[test]
fn a_set_named_on_a_body_the_mapped_mesher_does_not_mesh_is_ill_posed() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"mix"}"#);
    ok(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStrain"}}"#);
    ok(
        &mut e,
        r#"{"cmd":"geometry.add","name":"disc","shape":{"kind":"sheet","sketch":{"outer":[
          {"kind":"arc","center":["0 m","0 m"],"to":["-1 m","0 m"],"ccw":true,"tag":"rim"},
          {"kind":"arc","center":["0 m","0 m"],"to":["1 m","0 m"],"ccw":true,"tag":"rim"}]}}}"#,
    );
    ok(&mut e, r#"{"cmd":"geometry.nameFace","name":"edge","of":"disc","where":{"kind":"normal","normal":[1,0,0]}}"#);
    ok(&mut e, COOK);
    let er = e.query(Query::Mesh {}).unwrap_err();
    assert_eq!(er.code, ErrorCode::ModelIllPosed);
    assert_eq!(er.where_.as_deref(), Some("set 'edge'"));
    assert!(er.cause.contains("body 'disc'"), "{}", er.cause);
}

#[test]
fn a_mapped_mesher_validates_every_field_it_reads() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"bad"}"#);
    ok(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStrain"}}"#);
    let one = |blocks: &str| format!(r#"{{"cmd":"mesh.set","mesher":{{"kind":"mapped","blocks":{blocks}}}}}"#);
    assert_eq!(err(&mut e, &one("[]")).where_.as_deref(), Some("mesher.blocks"));
    let corners = r#""corners":[["0 m","0 m"],["1 m","0 m"],["1 m","1 m"],["0 m","1 m"]]"#;
    assert_eq!(
        where_(&mut e, &one(r#"[{"corners":[["0 kg","0 m"],["1 m","0 m"],["1 m","1 m"],["0 m","1 m"]],"n":[1,1]}]"#)),
        "mesher.blocks[0].corners[0][0]"
    );
    assert_eq!(where_(&mut e, &one(&format!(r#"[{{{corners},"n":[0,1]}}]"#))), "mesher.blocks[0].n");
    assert_eq!(
        where_(&mut e, &one(&format!(r#"[{{{corners},"n":[1,1],"grading":[1.0,0.0]}}]"#))),
        "mesher.blocks[0].grading"
    );
    assert_eq!(
        where_(
            &mut e,
            &one(&format!(
                r#"[{{{corners},"n":[1,1],"edges":[{{"kind":"line"}},{{"kind":"line"}},{{"kind":"line"}},
                   {{"kind":"arc","center":["0 s","0 m"],"ccw":true}}]}}]"#
            ))
        ),
        "mesher.blocks[0].edges[3].center[0]"
    );
    assert_eq!(
        where_(
            &mut e,
            &one(&format!(
                r#"[{{{corners},"n":[1,1],"edges":[{{"kind":"line"}},{{"kind":"line"}},{{"kind":"line"}},
                   {{"kind":"ellipse","center":["0 m","0 m"],"semiAxes":["1 m","1 K"]}}]}}]"#
            ))
        ),
        "mesher.blocks[0].edges[3].semiAxes[1]"
    );
    assert_eq!(
        where_(
            &mut e,
            &one(&format!(
                r#"[{{{corners},"n":[1,1],"edges":[{{"kind":"line"}},{{"kind":"line"}},{{"kind":"line"}},
                   {{"kind":"ellipse","center":["0 N","0 m"],"semiAxes":["1 m","1 m"]}}]}}]"#
            ))
        ),
        "mesher.blocks[0].edges[3].center[0]"
    );
    assert_eq!(
        where_(&mut e, &one(&format!(r#"[{{{corners},"n":[1,1],"tags":["a.b",null,null,null]}}]"#))),
        "mesher.blocks[0].tags[0]"
    );
    assert_eq!(
        where_(&mut e, &one(&format!(r#"[{{{corners},"n":[1,1],"tags":["",null,null,null]}}]"#))),
        "mesher.blocks[0].tags[0]"
    );
    // geometry the mesher itself refuses is a mesh failure at build time, not a schema error
    ok(&mut e, &one(r#"[{"corners":[["0 m","0 m"],["0 m","0 m"],["1 m","1 m"],["0 m","1 m"]],"n":[1,1]}]"#));
    let er = e.query(Query::Mesh {}).unwrap_err();
    assert_eq!(er.code, ErrorCode::MeshFailed);
    assert_eq!(er.where_.as_deref(), Some("mesher.blocks"));
    assert!(er.cause.contains("four distinct corners"), "{}", er.cause);
}

/// C §7 D1: the NAFEMS LE10 plate, LE1's elliptic block extruded in an even number of layers.
fn le10(order: u8, layers: u32) -> String {
    format!(
        r#"{{"cmd":"mesh.set","mesher":{{"kind":"sweep","base":{{"kind":"mapped","body":"plate","blocks":[{{
        "corners":[["2 m","0 m"],["3.25 m","0 m"],["0 m","2.75 m"],["0 m","1 m"]],
        "edges":[{{"kind":"line"}},{{"kind":"ellipse","center":["0 m","0 m"],"semiAxes":["3.25 m","2.75 m"]}},
                 {{"kind":"line"}},{{"kind":"ellipse","center":["0 m","0 m"],"semiAxes":["2 m","1 m"]}}],
        "n":[2,3],"tags":["y0","outer","x0","inner"]}}]}},
        "sweep":{{"kind":"extrude","layers":{layers},"height":"0.6 m"}}}},"order":{order}}}"#
    )
}

#[test]
fn a_swept_mapped_base_gives_hexes_with_named_ends() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"le10"}"#);
    ok(&mut e, &le10(1, 4));
    let m = mesh_summary(&mut e);
    assert_eq!((m.elements, m.element_kind.as_str()), (2 * 3 * 4, "hex8"));
    assert_eq!((m.nodes, m.dofs), (3 * 4 * 5, 3 * m.nodes));
    assert_eq!(
        m.sets.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
        ["plate.bottom", "plate.inner", "plate.outer", "plate.top", "plate.x0", "plate.y0"]
    );
    // the ends are the plate's faces: 6 quads each, of the quarter elliptic annulus area
    let top = set_info(&mut e, "plate.top");
    assert_eq!((top.kind.as_str(), top.count), ("face", 6));
    assert_eq!(top.measure.unit, "m^2");
    let exact = std::f64::consts::PI / 4.0 * (3.25 * 2.75 - 2.0);
    assert!((top.measure.value - exact).abs() < 0.05 * exact, "{:?} vs {exact}", top.measure);
    assert_eq!(set_info(&mut e, "plate.outer").count, 3 * 4);
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"edge","on":"plate.outer"}"#);

    // order 2 gives hex20, whose whole layers carry the base's mid-nodes
    ok(&mut e, &le10(2, 2));
    let m = mesh_summary(&mut e);
    assert_eq!((m.elements, m.element_kind.as_str()), (2 * 3 * 2, "hex20"));
    let base_nodes = 5 * 7 - 2 * 3;
    assert_eq!(m.nodes, 3 * base_nodes + 2 * (3 * 4));
    let top = set_info(&mut e, "plate.top");
    assert!((top.measure.value - exact).abs() < 0.05 * exact, "{:?}", top.measure);

    // a 2D idealisation cannot hold a swept mesh
    ok(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStrain"}}"#);
    let er = e.query(Query::Mesh {}).unwrap_err();
    assert_eq!(er.code, ErrorCode::ModelIllPosed);
    assert!(er.cause.contains("the sweep mesher makes a 3D mesh"), "{}", er.cause);
}

#[test]
fn revolving_a_section_names_theta0_and_theta1() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"lame"}"#);
    // C §7 C2: the Lame cylinder strip r in [0.1, 0.2] m, z in [0, 0.1] m, revolved 90 degrees
    let strip = |sweep: &str| {
        format!(
            r#"{{"cmd":"mesh.set","mesher":{{"kind":"sweep","body":null,"base":{{"kind":"mapped","body":"tube",
            "blocks":[{{"corners":[["0.1 m","0 m"],["0.2 m","0 m"],["0.2 m","0.1 m"],["0.1 m","0.1 m"]],
            "n":[2,1],"tags":["zmin","outer","zmax","inner"]}}]}},"sweep":{sweep}}}}}"#
        )
    };
    ok(&mut e, &strip(r#"{"kind":"revolve","segments":4,"angleDeg":90}"#));
    let m = mesh_summary(&mut e);
    assert_eq!((m.elements, m.element_kind.as_str()), (8, "hex8"));
    assert_eq!(m.nodes, 5 * 3 * 2);
    assert_eq!(
        m.sets.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
        ["tube.inner", "tube.outer", "tube.theta0", "tube.theta1", "tube.zmax", "tube.zmin"]
    );
    assert_eq!(set_info(&mut e, "tube.theta0").count, 2);
    let inner = set_info(&mut e, "tube.inner");
    // a quarter of the inner wall: 2 pi r h / 4, less the chord error of four flat facets
    assert!((inner.measure.value - 0.005 * std::f64::consts::PI).abs() < 4e-4, "{:?}", inner.measure);

    // a full turn merges its seam and has no theta faces
    ok(&mut e, &strip(r#"{"kind":"revolve","segments":8,"angleDeg":360}"#));
    let m = mesh_summary(&mut e);
    assert_eq!((m.elements, m.nodes), (16, 8 * 3 * 2));
    assert!(!m.sets.iter().any(|s| s.name.starts_with("tube.theta")));

    // a section on the axis is a mesh failure that names the way out
    ok(
        &mut e,
        r#"{"cmd":"mesh.set","mesher":{"kind":"sweep","base":{"kind":"mapped","blocks":[
          {"corners":[["0 m","0 m"],["1 m","0 m"],["1 m","1 m"],["0 m","1 m"]],"n":[1,1]}]},
          "sweep":{"kind":"revolve","segments":4,"angleDeg":90}}}"#,
    );
    let er = e.query(Query::Mesh {}).unwrap_err();
    assert_eq!(er.code, ErrorCode::MeshFailed);
    assert_eq!(er.where_.as_deref(), Some("mesher.sweep"));
    assert!(er.cause.contains("butterfly"), "{}", er.cause);
}

#[test]
fn a_sweep_validates_its_own_fields_and_refuses_a_lattice_base() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"bad"}"#);
    let block = r#"{"kind":"mapped","blocks":[{"corners":[["1 m","0 m"],["2 m","0 m"],["2 m","1 m"],["1 m","1 m"]],"n":[1,1]}]}"#;
    let sweep = |s: &str| format!(r#"{{"cmd":"mesh.set","mesher":{{"kind":"sweep","base":{block},"sweep":{s}}}}}"#);
    assert_eq!(where_(&mut e, &sweep(r#"{"kind":"extrude","layers":0,"height":"1 m"}"#)), "mesher.sweep.layers");
    assert_eq!(where_(&mut e, &sweep(r#"{"kind":"extrude","layers":1,"height":"1 s"}"#)), "mesher.sweep.height");
    assert_eq!(where_(&mut e, &sweep(r#"{"kind":"extrude","layers":1,"height":"0 m"}"#)), "mesher.sweep.height");
    assert_eq!(where_(&mut e, &sweep(r#"{"kind":"revolve","segments":0,"angleDeg":90}"#)), "mesher.sweep.segments");
    assert_eq!(where_(&mut e, &sweep(r#"{"kind":"revolve","segments":4,"angleDeg":400}"#)), "mesher.sweep.angleDeg");
    // the base is validated too, with its own paths
    assert_eq!(
        where_(
            &mut e,
            r#"{"cmd":"mesh.set","mesher":{"kind":"sweep","base":{"kind":"mapped","blocks":[]},
                "sweep":{"kind":"extrude","layers":1,"height":"1 m"}}}"#
        ),
        "mesher.blocks"
    );
    // a lattice base meshes whole Bodies, not a section
    ok(
        &mut e,
        r#"{"cmd":"mesh.set","mesher":{"kind":"sweep","base":{"kind":"lattice","size":"1 m"},
            "sweep":{"kind":"extrude","layers":1,"height":"1 m"}}}"#,
    );
    let er = e.query(Query::Mesh {}).unwrap_err();
    assert_eq!(er.code, ErrorCode::MeshFailed);
    assert_eq!(er.where_.as_deref(), Some("mesher.base"));
    // and a sweep of a sweep has a 3D base, which the sweep refuses
    ok(
        &mut e,
        &format!(
            r#"{{"cmd":"mesh.set","mesher":{{"kind":"sweep","base":{{"kind":"sweep","base":{block},
               "sweep":{{"kind":"extrude","layers":1,"height":"1 m"}}}},
               "sweep":{{"kind":"extrude","layers":1,"height":"1 m"}}}}}}"#
        ),
    );
    assert!(e.query(Query::Mesh {}).unwrap_err().cause.contains("2D base mesh"));
}
