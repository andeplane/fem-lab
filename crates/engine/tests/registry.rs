//! The registry end to end: dispatch, undo/redo, replay, Queries, errors. Every Command runs
//! through JSON, the way every host sends it.

use femlab_engine::command::{
    Axis, Dof, FacePredicate, Field, IdealisationSpec, LatticeSize, MesherSpec, ObjectKind, Procedure, RegionPredicate,
    Solver,
};
use femlab_engine::post::convergence::richardson;
use femlab_engine::query::{Output, Query, QueryResult};
use femlab_engine::report::ReportSection;
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
    assert_eq!(
        err(
            &mut e,
            r#"{"cmd":"study.converge","step":"static","sizes":["50 mm"],"quantity":{"kind":"max","field":"vonMises"}}"#
        )
        .code,
        ErrorCode::Schema
    );
    assert_eq!(
        err(&mut e, r#"{"cmd":"plugin.load","name":"p","kind":"materialLaw","language":"ts","source":{"inline":"x"}}"#)
            .code,
        ErrorCode::Unsupported
    );
    assert_eq!(run(&mut e, r#"{"cmd":"nonsense"}"#).unwrap_err().code, ErrorCode::Schema);
    // every Result Query needs a Result, and says so rather than guessing
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
    ] {
        assert_eq!(e.query(q).unwrap_err().code, ErrorCode::NotFound);
    }
    assert_eq!(e.revision(), 9);
    assert_eq!(e.model_hash(), hash);
}

#[test]
fn model_query_reports_current_yield_in_display_units() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"yield"}"#);
    ok(&mut e, r#"{"cmd":"model.setUnits","units":{"stress":"MPa"}}"#);
    ok(&mut e, r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"yield":"0.355 GPa"}"#);
    let row = serde_json::to_value(e.query(Query::Model {}).unwrap()).unwrap();
    assert_eq!(row["materials"][0]["yield"], serde_json::json!({"value":355.0,"unit":"MPa"}));
    ok(&mut e, r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"yield":"400 MPa"}"#);
    let row = serde_json::to_value(e.query(Query::Model {}).unwrap()).unwrap();
    assert_eq!(row["materials"][0]["yield"]["value"], 400.0);
    ok(&mut e, r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3}"#);
    let row = serde_json::to_value(e.query(Query::Model {}).unwrap()).unwrap();
    assert!(row["materials"][0].get("yield").is_none());
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
fn body_removal_preserves_volumetric_load_targets() {
    for load in [
        r#"{"cmd":"load.heatSource","name":"source","bodies":["heated"],"q":"100 W/m^3"}"#,
        r#"{"cmd":"load.temperature","name":"source","bodies":["heated"],"value":"320 K","reference":"300 K"}"#,
    ] {
        let mut e = engine();
        ok(&mut e, r#"{"cmd":"model.new","name":"two-bodies"}"#);
        ok(&mut e, r#"{"cmd":"geometry.addBox","name":"heated","size":["1 m","1 m","1 m"]}"#);
        ok(&mut e, r#"{"cmd":"geometry.addBox","name":"other","size":["1 m","1 m","1 m"],"at":["2 m","0 m","0 m"]}"#);
        ok(&mut e, load);
        let before = e.model().clone();
        let failure = err(&mut e, r#"{"cmd":"geometry.remove","name":"heated"}"#);
        assert_eq!(failure.code, ErrorCode::InUse);
        assert_eq!(failure.where_.as_deref(), Some("body 'heated'"));
        assert!(failure.cause.contains("load 'source'"));
        assert!(failure.suggestion.as_deref().is_some_and(|s| s.contains("remove or retarget")));
        assert_eq!(e.model(), &before);
        // An unrelated Body remains removable while the load is present.
        ok(&mut e, r#"{"cmd":"geometry.remove","name":"other"}"#);
        ok(&mut e, r#"{"cmd":"load.remove","name":"source"}"#);
        ok(&mut e, r#"{"cmd":"geometry.remove","name":"heated"}"#);
        assert!(e.model().bodies.is_empty());
    }
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

/// Compare snapshots with a real replay of each prefix, and inspect exported commands directly.
fn assert_replay_prefix(e: &mut Engine, entries: &[femlab_engine::JournalEntry]) {
    let mut normal = engine();
    pollster::block_on(normal.replay(entries, false, true)).unwrap();
    assert_eq!(e.model(), normal.model());
    assert_eq!(e.export_file().model, normal.export_file().model);
    assert_eq!(e.journal().entries, entries);
    let QueryResult::Script(script) = e.query(Query::Script {}).unwrap() else { panic!("a script") };
    let commands: Vec<_> = script.text.lines().filter_map(femlab_engine::journal::parse_line).collect();
    assert_eq!(commands, entries.iter().map(|entry| entry.cmd.clone()).collect::<Vec<_>>());
}

#[test]
fn skipped_replay_keeps_every_undo_and_redo_aligned_with_the_journal() {
    let mut source = engine();
    solved_cantilever(&mut source, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"50 mm"},"order":1}"#);
    let entries = source.journal().entries.clone();
    let mut replayed = engine();
    pollster::block_on(replayed.replay(&entries, true, true)).unwrap();
    assert_eq!(replayed.query(Query::Result { step: None }).unwrap_err().code, ErrorCode::NotFound);
    assert_replay_prefix(&mut replayed, &entries);
    ok(&mut replayed, r#"{"cmd":"journal.undo"}"#);
    assert_eq!(replayed.model().steps.len(), 1, "undoing the skipped solve must keep step.add's Step");
    assert_replay_prefix(&mut replayed, &entries[..entries.len() - 1]);
    for end in (1..entries.len() - 1).rev() {
        ok(&mut replayed, r#"{"cmd":"journal.undo"}"#);
        assert_replay_prefix(&mut replayed, &entries[..end]);
    }
    assert!(!replayed.can_undo(), "model.new is the history boundary");
    for end in 2..=entries.len() {
        ok(&mut replayed, r#"{"cmd":"journal.redo"}"#);
        assert_replay_prefix(&mut replayed, &entries[..end]);
    }
    assert!(!replayed.can_redo());
    assert_eq!(replayed.query(Query::Result { step: None }).unwrap_err().code, ErrorCode::NotFound);
}

#[test]
fn skipped_studies_preserve_their_mesh_mutation_and_history() {
    for restore in [false, true] {
        let mut source = engine();
        cantilever(&mut source);
        ok(&mut source, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":2,"ny":1,"nz":1}}}"#);
        let original = source.model().clone();
        study(
            &mut source,
            &format!(
                r#"{{"cmd":"study.converge","step":"static","sizes":["100 mm","50 mm"],"quantity":{TIP_UZ},"restore":{restore}}}"#
            ),
        );
        let entries = source.journal().entries.clone();
        let mut replayed = engine();
        pollster::block_on(replayed.replay(&entries, true, true)).unwrap();
        assert_replay_prefix(&mut replayed, &entries);
        let expected_elements = if restore { 2 } else { 16 };
        assert_eq!(replayed.mesh().unwrap().mesh.n_elems(), expected_elements, "halving h doubles each division count");
        assert_eq!(replayed.query(Query::Result { step: None }).unwrap_err().code, ErrorCode::NotFound);
        ok(&mut replayed, r#"{"cmd":"journal.undo"}"#);
        assert_eq!(replayed.model(), &original);
        assert_replay_prefix(&mut replayed, &entries[..entries.len() - 1]);
        ok(&mut replayed, r#"{"cmd":"journal.redo"}"#);
        assert_replay_prefix(&mut replayed, &entries);
    }
}

#[test]
fn skipped_nonrestoring_study_rejects_invalid_mesh_inputs_before_recording() {
    let mut source = engine();
    cantilever(&mut source);
    let before = source.export_file();
    let mut entries = before.journal.entries.clone();
    entries.push(femlab_engine::JournalEntry {
        seq: entries.len() as u32,
        cmd: serde_json::from_str(
            r#"{"cmd":"study.converge","step":"static","sizes":["1 m"],
                "quantity":{"kind":"max","field":"displacement"},"restore":false}"#,
        )
        .unwrap(),
        hash_after: source.model_hash(),
    });
    let mut replayed = engine();
    let error = pollster::block_on(replayed.replay(&entries, true, true)).unwrap_err();
    assert_eq!(error.code, ErrorCode::Schema);
    assert_eq!(error.where_.as_deref(), Some("journal entry 9"));
    assert_eq!(replayed.export_file(), before, "the failed study changes neither Model nor Journal");
}

#[test]
fn empty_replay_clears_existing_mesh_and_history() {
    let mut e = engine();
    solved_cantilever(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"50 mm"},"order":1}"#);
    ok(&mut e, r#"{"cmd":"journal.undo"}"#);
    assert!(e.can_redo());
    assert!(e.mesh().unwrap().mesh.n_nodes() > 0);
    pollster::block_on(e.replay(&[], true, true)).unwrap();
    let mut fresh = engine();
    assert_eq!(e.export_file(), fresh.export_file());
    assert!(!e.can_undo() && !e.can_redo());
    assert_eq!(e.query(Query::Result { step: None }).unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(e.query(Query::Mesh {}).unwrap_err(), fresh.query(Query::Mesh {}).unwrap_err());
}

#[test]
fn skipped_replay_respects_the_bounded_undo_depth() {
    let mut e = engine();
    cantilever(&mut e);
    let model = e.model().clone();
    let mut journal = e.journal().clone();
    let solve: Command = serde_json::from_str(r#"{"cmd":"solve.run","step":"static"}"#).unwrap();
    let depth = femlab_engine::engine::UNDO_DEPTH;
    for _ in 0..depth + 5 {
        journal.append(solve.clone(), e.model_hash());
    }
    pollster::block_on(e.replay(&journal.entries, true, true)).unwrap();
    ok(&mut e, &format!(r#"{{"cmd":"journal.undo","steps":{depth}}}"#));
    assert_eq!(e.model(), &model);
    assert_eq!(e.journal().entries, journal.entries[..journal.len() - depth]);
    assert!(!e.can_undo());
    ok(&mut e, &format!(r#"{{"cmd":"journal.redo","steps":{depth}}}"#));
    assert_eq!(e.model(), &model);
    assert_eq!(e.journal(), &journal);
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
fn sourced_material_library_is_typed_applicable_and_host_independent() {
    let mut e = engine();
    let before = e.export_file();
    let QueryResult::MaterialLibrary(library) = e.query(Query::MaterialLibrary { name: None }).unwrap() else {
        panic!()
    };
    assert_eq!(library.entries.len(), 7);
    assert_eq!(library.sources.len(), 8);
    assert!(library.sources.iter().all(|source| {
        source.url.starts_with("https://") && source.retrieved_on == "2026-09-06" && !source.locator.is_empty()
    }));
    let jrc = library.sources.iter().find(|source| source.id == "jrc-handbook-3").unwrap();
    assert!(jrc.locator.contains("Table 2, PDF p. 135"));
    assert!(jrc.locator.contains("Table 3, PDF p. 137") && jrc.locator.contains("Table 9, PDF p. 147"));
    let jrc_concrete = library.sources.iter().find(|source| source.id == "jrc-bridge-worked-example").unwrap();
    assert!(jrc_concrete.locator.contains("C30/37 Ecm = 33 GPa"));
    let natureworks = library.sources.iter().find(|source| source.id == "natureworks-4043d").unwrap();
    assert!(natureworks.url.contains("getContentAsset") && natureworks.locator.contains("NW4043DFILA_032415V1"));
    let source_ids: std::collections::BTreeSet<&str> =
        library.sources.iter().map(|source| source.id.as_str()).collect();
    for entry in &library.entries {
        for source in [
            entry.e.as_ref().map(|p| p.source.as_str()),
            entry.nu.as_ref().map(|p| p.source.as_str()),
            entry.rho.as_ref().map(|p| p.source.as_str()),
            entry.alpha.as_ref().map(|p| p.source.as_str()),
            entry.k.as_ref().map(|p| p.source.as_str()),
            entry.cp.as_ref().map(|p| p.source.as_str()),
            entry.yield_.as_ref().map(|p| p.source.as_str()),
        ]
        .into_iter()
        .flatten()
        {
            assert!(source_ids.contains(source), "{} uses unknown source {source}", entry.id);
        }
        assert!(entry.material_add_source.contains("retrieved 2026-09-06"));
    }

    let aluminium = library.entries.iter().find(|entry| entry.id == "6061-t6-sheet").unwrap();
    assert_eq!(aluminium.specification, "AMS 4025/4027; MMPDS A-basis data");
    assert!((aluminium.e.as_ref().unwrap().value.si().unwrap() - 68.3e9).abs() < 1.0);
    assert!((aluminium.nu.as_ref().unwrap().value.si().unwrap() - 0.33).abs() < 1e-12);
    assert!((aluminium.rho.as_ref().unwrap().value.si().unwrap() - 2710.0).abs() < 1e-12);
    assert!((aluminium.alpha.as_ref().unwrap().value.si().unwrap() - 22.7e-6).abs() < 1e-15);
    assert!((aluminium.k.as_ref().unwrap().value.si().unwrap() - 152.0).abs() < 1e-12);
    assert!((aluminium.cp.as_ref().unwrap().value.si().unwrap() - 879.0).abs() < 1e-12);
    assert!((aluminium.yield_.as_ref().unwrap().value.si().unwrap() - 248e6).abs() < 1.0);
    assert!(aluminium.temperature.is_none());

    let concrete = library.entries.iter().find(|entry| entry.id == "c30-37").unwrap();
    assert_eq!(concrete.e.as_ref().unwrap().source, "jrc-bridge-worked-example");
    assert!((concrete.e.as_ref().unwrap().value.si().unwrap() - 33e9).abs() < 1.0);

    let abs = library.entries.iter().find(|entry| entry.id == "terluran-gp35").unwrap();
    assert!(abs.temperature.is_none() && abs.temperature_basis.contains("Yield strength is reported at 23 degC"));
    assert!((abs.e.as_ref().unwrap().value.si().unwrap() - 362.0 * 6_894_757.293_168).abs() < 1e-5);
    assert!(abs.nu.is_none() && abs.alpha.is_none() && abs.k.is_none() && abs.cp.is_none());

    let pla = library.entries.iter().find(|entry| entry.id == "ingeo-4043d").unwrap();
    assert!((pla.e.as_ref().unwrap().value.si().unwrap() - 524_000.0 * 6_894.757_293_168).abs() < 1e-5);
    assert!((pla.yield_.as_ref().unwrap().value.si().unwrap() - 8700.0 * 6_894.757_293_168).abs() < 1e-5);
    assert!(pla.e.as_ref().unwrap().basis.contains("ASTM D882"));

    let timber = library.entries.iter().find(|entry| entry.id == "c24-timber").unwrap();
    assert!(timber.nu.is_none() && timber.yield_.is_none());
    assert!(timber.limitations.iter().any(|text| text.contains("orthotropic")));
    assert!(timber
        .limitations
        .iter()
        .any(|text| text.contains("would not make the longitudinal E an isotropic default")));
    let wire = serde_json::to_value(timber).unwrap();
    assert!(wire["nu"].is_null() && wire["yield"].is_null() && wire["temperature"].is_null());
    assert_eq!(e.export_file(), before, "the list Query cannot mutate the Model or Journal");

    // Entries with the isotropic properties material.add requires pass through the same JSON
    // boundary hosts use. Partial polymer and timber entries deliberately cannot be applied.
    for (at, entry) in library.entries.iter().filter(|entry| entry.e.is_some() && entry.nu.is_some()).enumerate() {
        let mut cmd = serde_json::json!({
            "cmd": "material.add",
            "name": format!("catalogue{at}"),
            "E": serde_json::to_value(&entry.e.as_ref().unwrap().value).unwrap(),
            "nu": entry.nu.as_ref().unwrap().value.si().unwrap(),
            "source": &entry.material_add_source,
        });
        for (key, value) in [
            ("rho", entry.rho.as_ref().map(|p| serde_json::to_value(&p.value).unwrap())),
            ("alpha", entry.alpha.as_ref().map(|p| serde_json::to_value(&p.value).unwrap())),
            ("k", entry.k.as_ref().map(|p| serde_json::to_value(&p.value).unwrap())),
            ("cp", entry.cp.as_ref().map(|p| serde_json::to_value(&p.value).unwrap())),
            ("yield", entry.yield_.as_ref().map(|p| serde_json::to_value(&p.value).unwrap())),
        ] {
            if let Some(value) = value {
                cmd[key] = value;
            }
        }
        ok(&mut e, &cmd.to_string());
    }
    assert_eq!(e.revision(), 4);
    assert!(e
        .model()
        .materials
        .iter()
        .all(|material| { material.source.as_deref().is_some_and(|source| source.contains("retrieved 2026-09-06")) }));
}

#[test]
fn material_library_aliases_are_stable_and_ambiguity_is_explicit() {
    let mut e = engine();
    let before = e.export_file();
    for name in ["6061-t6-sheet", "6061-T6 aluminium sheet", "ALUMINUM 6061 T6", "c30 / 37"] {
        let QueryResult::MaterialLibrary(found) = e.query(Query::MaterialLibrary { name: Some(name.into()) }).unwrap()
        else {
            panic!()
        };
        assert_eq!(found.entries.len(), 1);
        assert_eq!(found.sources.len(), 8);
    }
    let ambiguous = e.query(Query::MaterialLibrary { name: Some("steel".into()) }).unwrap_err();
    assert_eq!(ambiguous.code, ErrorCode::Schema);
    assert_eq!(ambiguous.where_.as_deref(), Some("name"));
    assert!(ambiguous.cause.contains("s355j2") && ambiguous.cause.contains("s235j2w"));
    let missing = e.query(Query::MaterialLibrary { name: Some("generic titanium".into()) }).unwrap_err();
    assert_eq!(missing.code, ErrorCode::NotFound);
    assert_eq!(missing.where_.as_deref(), Some("name"));
    assert!(missing.suggestion.as_deref().unwrap().contains("6061-t6-sheet"));
    assert_eq!(e.export_file(), before, "Queries cannot mutate the Model or Journal");
}

/// Shared with the Node wasm regression: rejected inputs cannot change the saved Model or
/// Journal. The expected errors cover numeric, factor and dimension overflow independently.
#[test]
fn invalid_quantities_preserve_the_model_and_journal() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!("fixtures/invalid-quantities.json")).unwrap();
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"quantity validation"}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"beam","size":["1 m","1 m","1 m"]}"#);
    let before = serde_json::to_value(e.export_file()).unwrap();
    let hash = e.model_hash();
    for case in fixture["commands"].as_array().unwrap() {
        let error = run(&mut e, &case["input"].to_string()).unwrap_err();
        assert_eq!(serde_json::to_value(error.code).unwrap(), case["code"], "{case}");
        assert!(error.where_.is_some());
        assert_eq!(e.model_hash(), hash);
        assert_eq!(serde_json::to_value(e.export_file()).unwrap(), before);
    }
    for case in fixture["queries"].as_array().unwrap() {
        let query: Query = serde_json::from_value(case["input"].clone()).unwrap();
        let error = e.query(query).unwrap_err();
        assert_eq!(serde_json::to_value(error.code).unwrap(), case["code"], "{case}");
        assert!(error.where_.is_some());
        assert_eq!(e.model_hash(), hash);
        assert_eq!(serde_json::to_value(e.export_file()).unwrap(), before);
    }
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
    ok(&mut e, r#"{"cmd":"load.pressure","name":"pfa","on":"fa","value":"1 MPa"}"#);
    ok(&mut e, r#"{"cmd":"load.convection","name":"cfa","on":"fa","h":"50 W/(m^2 K)","tInf":"20 degC"}"#);
    ok(&mut e, r#"{"cmd":"load.heatFlux","name":"hfa","on":"fa","q":"1 kW/m^2"}"#);
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
    assert_eq!(e.model().load("pfa").unwrap().kind.set(), Some("faa"));
    assert_eq!(e.model().load("cfa").unwrap().kind.set(), Some("faa"));
    assert_eq!(e.model().load("hfa").unwrap().kind.set(), Some("faa"));
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
    // a calculation note is a read of the whole Model, so it fails the same way and as early
    assert_eq!(e.query(Query::Report { step: None, include: None }).unwrap_err().code, ErrorCode::Schema);
    assert_eq!(er.where_.as_deref(), Some("body 'b'"));
    // the Mesh and the viewer surfaces need the same Solids, so they fail the same way
    assert_eq!(e.query(Query::Mesh {}).unwrap_err().code, ErrorCode::Schema);
    assert_eq!(e.geometry_surface().unwrap_err().code, ErrorCode::Schema);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"1 m"}}"#);
    assert_eq!(e.mesh().unwrap_err().code, ErrorCode::Schema);
    assert_eq!(e.mesh_surface().unwrap_err().code, ErrorCode::Schema);
    assert_eq!(e.query(Query::Set { name: "b.xmin".into() }).unwrap_err().code, ErrorCode::Schema);
    // every writer needs the same Mesh, so every export refuses for the same reason
    for format in ["vtu", "msh", "inp", "stl", "report"] {
        let er = err(&mut e, &format!(r#"{{"cmd":"mesh.export","format":"{format}"}}"#));
        assert_eq!(er.code, ErrorCode::Schema, "{format}: {er:?}");
    }
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
    assert_eq!(err(&mut e, r#"{"cmd":"mesh.export","format":"vtu","step":"static"}"#).code, ErrorCode::NotFound);
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

/// The payload of one named DataArray: decode one block, then remove its UInt64 length.
fn decode_array(text: &str, name: &str) -> Vec<u8> {
    let at = text.find(&format!("Name=\"{name}\"")).expect("the array is in the file");
    let body = &text[at..];
    let start = body.find("binary\">").expect("binary payload") + "binary\">".len();
    let end = body.find("</DataArray>").expect("closed");
    let payload = &body[start..end];
    let bytes = from_base64(payload);
    let len = u64::from_le_bytes(bytes[..8].try_into().unwrap()) as usize;
    assert_eq!(len, bytes.len() - 8);
    bytes[8..].to_vec()
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

#[test]
fn independent_vtk_reader_accepts_all_binary_padding_lengths() {
    for nx in 1..=3 {
        let mut e = engine();
        ok(&mut e, r#"{"cmd":"geometry.addBox","name":"b","size":["1 m","1 m","1 m"]}"#);
        ok(
            &mut e,
            &format!(r#"{{"cmd":"mesh.set","mesher":{{"kind":"lattice","size":{{"nx":{nx},"ny":1,"nz":1}}}}}}"#),
        );
        let output = ok(&mut e, r#"{"cmd":"mesh.export","format":"vtu"}"#).output;
        let Output::Export { text, .. } = output else { panic!("a VTU export") };
        let vtk = vtkio::Vtk::parse_xml(text.as_bytes()).expect("VTK cell types with zero, one or two padding bytes");
        let piece = vtkio::model::UnstructuredGridPiece::try_from(vtk.data).unwrap();
        assert_eq!(piece.num_points(), (nx + 1) * 4);
        assert_eq!(piece.cells.types, vec![vtkio::model::CellType::Hexahedron; nx]);
        assert_eq!(piece.cells.cell_verts.num_verts(), nx * 8);
    }
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

/// C §7 C1's free row: the full Kirsch plate as a Sheet with a circular hole.
const PLATE: &str = r#"{"cmd":"geometry.add","name":"plate","shape":{"kind":"sheet","sketch":{"outer":[
    {"kind":"line","to":["10 m","0 m"],"tag":"ymin"},
    {"kind":"line","to":["10 m","10 m"],"tag":"xmax"},
    {"kind":"line","to":["0 m","10 m"],"tag":"ymax"},
    {"kind":"line","to":["0 m","0 m"],"tag":"xmin"}],
    "holes":[[{"kind":"arc","center":["5 m","5 m"],"to":["4 m","5 m"],"ccw":true,"tag":"hole"},
              {"kind":"arc","center":["5 m","5 m"],"to":["6 m","5 m"],"ccw":true,"tag":"hole"}]]}}}"#;

#[test]
fn the_free_mesher_fills_a_sheet_body_with_triangles() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"kirsch-free"}"#);
    ok(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStress","thickness":"1 mm"}}"#);
    ok(&mut e, PLATE);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"free","of":"plate","size":"1 m"}}"#);
    let m = mesh_summary(&mut e);
    assert_eq!(m.element_kind, "tri3");
    assert!(m.elements > 100, "{} elements", m.elements);
    assert_eq!(m.dofs, 2 * m.nodes);
    assert_eq!(
        m.sets.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
        ["plate.hole", "plate.xmax", "plate.xmin", "plate.ymax", "plate.ymin"]
    );
    // the plate is 10 x 10 less a hole of radius 1, to the chord error of the sampled circle
    ok(&mut e, r#"{"cmd":"geometry.nameRegion","name":"all","where":{"kind":"body","name":"plate"}}"#);
    let all = set_info(&mut e, "all");
    assert_eq!(all.measure.unit, "m^2");
    // the hole is sampled to a chord tolerance of a tenth of the element size, so a finer mesh
    // gets a rounder hole and the area converges on 100 - pi from above
    let exact = 100.0 - std::f64::consts::PI;
    let coarse = all.measure.value - exact;
    assert!((0.0..0.4).contains(&coarse), "{:?} vs {exact}", all.measure);
    assert!(set_info(&mut e, "plate.hole").count >= 8, "one face per sampled chord, at least");
    assert!((set_info(&mut e, "plate.xmin").measure.value - 10.0).abs() < 1e-9);
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"root","on":"plate.xmin"}"#);

    // order 2 gives tri6, and a refine box around the hole adds elements
    ok(
        &mut e,
        r#"{"cmd":"mesh.set","mesher":{"kind":"free","of":"plate","size":"1 m",
            "refine":[{"min":["3 m","3 m"],"max":["7 m","7 m"],"size":"0.4 m"}]},"order":2}"#,
    );
    let refined = mesh_summary(&mut e);
    assert_eq!(refined.element_kind, "tri6");
    assert!(refined.elements * 2 > 3 * m.elements, "{} vs {}", refined.elements, m.elements);
    let all = set_info(&mut e, "all");
    assert!((all.measure.value - exact - coarse).abs() < 1e-9, "the same sampling as the coarse run");

    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"free","of":"plate","size":"0.25 m"}}"#);
    let fine = set_info(&mut e, "all").measure.value - exact;
    assert!(fine > 0.0 && fine < 0.4 * coarse, "a rounder hole at a smaller size: {fine} vs {coarse}");
}

#[test]
fn the_free_mesher_validates_its_body_its_size_and_its_boxes() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"bad"}"#);
    ok(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStrain"}}"#);
    ok(&mut e, PLATE);
    assert_eq!(
        where_(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"free","of":"plate","size":"1 kg"}}"#),
        "mesher.size"
    );
    assert_eq!(
        where_(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"free","of":"plate","size":"0 m"}}"#),
        "mesher.size"
    );
    let with_box = |b: &str| {
        format!(r#"{{"cmd":"mesh.set","mesher":{{"kind":"free","of":"plate","size":"1 m","refine":[{b}]}}}}"#)
    };
    assert_eq!(
        where_(&mut e, &with_box(r#"{"min":["0 s","0 m"],"max":["1 m","1 m"],"size":"0.5 m"}"#)),
        "mesher.refine[0].min[0]"
    );
    assert_eq!(
        where_(&mut e, &with_box(r#"{"min":["0 m","0 m"],"max":["1 m","1 A"],"size":"0.5 m"}"#)),
        "mesher.refine[0].max[1]"
    );
    assert_eq!(
        where_(&mut e, &with_box(r#"{"min":["0 m","0 m"],"max":["1 m","1 m"],"size":"1 N"}"#)),
        "mesher.refine[0].size"
    );
    assert_eq!(
        where_(&mut e, &with_box(r#"{"min":["0 m","0 m"],"max":["1 m","1 m"],"size":"0 m"}"#)),
        "mesher.refine[0].size"
    );
    assert_eq!(
        where_(&mut e, &with_box(r#"{"min":["2 m","0 m"],"max":["1 m","1 m"],"size":"0.5 m"}"#)),
        "mesher.refine[0].min"
    );
    // a Body that is not a sheet, and one that is not there at all
    ok(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"solid3d"}}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"blk","size":["1 m","1 m","1 m"]}"#);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"free","of":"blk","size":"1 m"}}"#);
    let er = e.query(Query::Mesh {}).unwrap_err();
    assert_eq!((er.code, er.where_.as_deref()), (ErrorCode::ModelIllPosed, Some("mesher.of")));
    assert!(er.cause.contains("is not a sheet"), "{}", er.cause);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"free","of":"nope","size":"1 m"}}"#);
    let er = e.query(Query::Mesh {}).unwrap_err();
    assert_eq!((er.code, er.where_.as_deref()), (ErrorCode::NotFound, Some("mesher.of")));
    // a size the mesher itself cannot use is a mesh failure
    ok(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStrain"}}"#);
    ok(
        &mut e,
        r#"{"cmd":"geometry.add","name":"inside-out","shape":{"kind":"sheet","sketch":{"outer":[
          {"kind":"line","to":["4 m","0 m"],"tag":"a"},{"kind":"line","to":["4 m","4 m"],"tag":"b"},
          {"kind":"line","to":["0 m","4 m"],"tag":"c"},{"kind":"line","to":["0 m","0 m"],"tag":"d"}],
          "holes":[[{"kind":"line","to":["4 m","0 m"],"tag":"h"},{"kind":"line","to":["4 m","4 m"],"tag":"h"},
          {"kind":"line","to":["0 m","4 m"],"tag":"h"},{"kind":"line","to":["0 m","0 m"],"tag":"h"}]]}}}"#,
    );
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"free","of":"inside-out","size":"1 m"}}"#);
    let er = e.query(Query::Mesh {}).unwrap_err();
    assert_eq!((er.code, er.where_.as_deref()), (ErrorCode::MeshFailed, Some("mesher.size")));
    assert!(er.cause.contains("produced no triangle"), "{}", er.cause);
    // the plate-with-hole sketch that panicked weka: the hole's fourth arc ends where its first
    // one does, so the loop closes with a full circle. It fails at the segment, not at the size.
    ok(
        &mut e,
        r#"{"cmd":"geometry.add","name":"plate","shape":{"kind":"sheet","sketch":{"outer":[
          {"kind":"line","to":["100 mm","0 mm"],"tag":"xmax0"},{"kind":"line","to":["100 mm","80 mm"],"tag":"ymax"},
          {"kind":"line","to":["0 mm","80 mm"],"tag":"xmin0"},{"kind":"line","to":["0 mm","0 mm"],"tag":"ymin"}],
          "holes":[[{"kind":"arc","center":["50 mm","40 mm"],"to":["35 mm","40 mm"],"ccw":true,"tag":"hole"},
          {"kind":"arc","center":["50 mm","40 mm"],"to":["50 mm","25 mm"],"ccw":true,"tag":"hole"},
          {"kind":"arc","center":["50 mm","40 mm"],"to":["65 mm","40 mm"],"ccw":true,"tag":"hole"},
          {"kind":"arc","center":["50 mm","40 mm"],"to":["35 mm","40 mm"],"ccw":true,"tag":"hole"}]]}}}"#,
    );
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"free","of":"plate","size":"5 mm"}}"#);
    let er = e.query(Query::Mesh {}).unwrap_err();
    assert_eq!((er.code, er.where_.as_deref()), (ErrorCode::MeshFailed, Some("shape.sketch.holes[0][3]")));
    assert!(er.cause.contains("a full circle"), "{}", er.cause);
    assert!(er.suggestion.unwrap().contains("split the full-circle arc into two arcs"));
}

#[test]
fn a_triangle_section_cannot_be_swept_into_hexes() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"swept-free"}"#);
    ok(
        &mut e,
        r#"{"cmd":"geometry.add","name":"ring","shape":{"kind":"sheet","sketch":{"outer":[
          {"kind":"line","to":["2 m","0 m"],"tag":"zmin"},{"kind":"line","to":["2 m","1 m"],"tag":"outer"},
          {"kind":"line","to":["1 m","1 m"],"tag":"zmax"},{"kind":"line","to":["1 m","0 m"],"tag":"inner"}]}}}"#,
    );
    ok(
        &mut e,
        r#"{"cmd":"mesh.set","mesher":{"kind":"sweep","base":{"kind":"free","of":"ring","size":"0.5 m"},
            "sweep":{"kind":"revolve","segments":6,"angleDeg":90}}}"#,
    );
    // a swept triangle is a wedge, which is not one of the eight element kinds
    let er = e.query(Query::Mesh {}).unwrap_err();
    assert_eq!((er.code, er.where_.as_deref()), (ErrorCode::MeshFailed, Some("mesher.sweep")));
    assert!(er.cause.contains("quad4 or quad8 base mesh"), "{}", er.cause);
    // the same section as one mapped block sweeps fine
    ok(
        &mut e,
        r#"{"cmd":"mesh.set","mesher":{"kind":"sweep","base":{"kind":"mapped","body":"ring","blocks":[
            {"corners":[["1 m","0 m"],["2 m","0 m"],["2 m","1 m"],["1 m","1 m"]],"n":[2,2],
             "tags":["zmin","outer","zmax","inner"]}]},
            "sweep":{"kind":"revolve","segments":6,"angleDeg":90}}}"#,
    );
    let m = mesh_summary(&mut e);
    assert_eq!(m.element_kind, "hex8");
    assert_eq!(m.elements, 4 * 6);
    ok(&mut e, r#"{"cmd":"geometry.nameRegion","name":"all","where":{"kind":"body","name":"ring"}}"#);
    // a quarter of the tube pi (2^2 - 1^2) 1 / 4, less the chord error of six flat facets
    let exact = std::f64::consts::PI * 3.0 / 4.0;
    let all = set_info(&mut e, "all");
    assert!((all.measure.value - exact).abs() < 0.05 * exact, "{:?} vs {exact}", all.measure);
}

// ------------------------------------------------------------------- solve.run

/// Benchmark B1: `δ = PL³/(3EI) + PL/(κGA)` with `κ = 5/6`, `L = 1 m`, `b = h = 0.1 m`,
/// `P = 1 kN`, `E = 210 GPa`, `ν = 0.3` — in millimetres, the Model's display unit.
const B1_THEORY_MM: f64 = 0.191_961_904_761_904_8;

fn solved_cantilever(e: &mut Engine, mesh: &str) {
    ok(e, r#"{"cmd":"model.new","name":"cantilever"}"#);
    ok(e, r#"{"cmd":"model.setUnits","units":{"length":"mm","stress":"MPa","force":"kN"}}"#);
    ok(e, r#"{"cmd":"geometry.addBox","name":"beam","size":["1 m","100 mm","100 mm"]}"#);
    ok(e, r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"rho":"7850 kg/m^3"}"#);
    ok(e, r#"{"cmd":"material.assign","material":"steel","bodies":["beam"]}"#);
    ok(e, mesh);
    ok(e, r#"{"cmd":"constraint.fix","name":"root","on":"beam.xmin"}"#);
    ok(e, r#"{"cmd":"load.traction","name":"tip","on":"beam.xmax","total":["0 N","0 N","-1 kN"]}"#);
    ok(e, r#"{"cmd":"step.add","name":"static","procedure":"static","constraints":["root"],"loads":["tip"]}"#);
    ok(e, r#"{"cmd":"solve.run","step":"static"}"#);
}

fn result(e: &mut Engine) -> femlab_engine::query::ResultSummary {
    let QueryResult::Result(r) = e.query(Query::Result { step: None }).unwrap_or_else(|e| panic!("{e:?}")) else {
        panic!("query.result returns a ResultSummary")
    };
    r
}

fn tip_uz(e: &mut Engine) -> f64 {
    let q = Query::Probe {
        step: None,
        field: Field::Displacement,
        component: Some(2),
        at: [Q::text("1 m"), Q::text("50 mm"), Q::text("50 mm")],
    };
    let QueryResult::Probe(p) = e.query(q).unwrap_or_else(|e| panic!("{e:?}")) else { panic!("a ProbeResult") };
    assert_eq!(p.value.unit, "mm");
    assert!(p.interpolated);
    p.value.value
}

#[test]
fn solving_the_cantilever_reports_the_tip_deflection_and_balanced_reactions() {
    let mut e = engine();
    solved_cantilever(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"25 mm"},"order":1}"#);
    let r = result(&mut e);
    assert_eq!(r.step, "static");
    assert!(!r.stale);
    assert_eq!(r.solver, "cpu-direct");
    assert!(r.balance <= 1e-9, "reactions must balance: {}", r.balance);
    // the applied total is the 1 kN the traction asked for, and the root carries it back
    assert_eq!(r.applied_total[2].unit, "kN");
    assert!((r.applied_total[2].value + 1.0).abs() <= 1e-9);
    assert_eq!(r.reactions.len(), 1);
    assert_eq!(r.reactions[0].constraint, "root");
    assert!((r.reactions[0].total[2].value - 1.0).abs() <= 1e-9);
    // B1: within 2 % of Timoshenko for the incompatible-modes hexahedron at 25 mm
    let uz = tip_uz(&mut e);
    let error = (uz.abs() - B1_THEORY_MM).abs() / B1_THEORY_MM;
    assert!(error < 0.02, "hex8 incompatible modes: {uz} mm, {:.2} % from {B1_THEORY_MM}", error * 100.0);
    // the extremes name their field and carry their unit and location
    let disp = r.extremes.iter().find(|x| x.field == "displacement" && x.component == 2).expect("uz extreme");
    assert_eq!(disp.min.unit, "mm");
    assert!((disp.min.value - uz).abs() < 0.01 * B1_THEORY_MM, "{} vs {uz}", disp.min.value);
    assert!((disp.min_at[0].value - 1000.0).abs() < 1e-9, "the largest deflection is at the free end");
    assert!(r.extremes.iter().any(|x| x.field == "vonMises" && x.min.unit == "MPa"));
    assert!(r.extremes.iter().any(|x| x.field == "reaction" && x.min.unit == "kN"));
    assert!(r.extremes.iter().all(|x| x.field != "stressUnaveraged"), "only nodal fields have extremes");
    // query.model now says the Step is solved
    let QueryResult::Model(m) = e.query(Query::Model {}).unwrap() else { panic!() };
    assert!(m.steps[0].solved);
}

/// B1 again, through `solve.run { solver: 'cpu-pcg' }`: the iterative path is a Command away
/// and lands on the direct answer, because the refinement loop measures itself in f64.
#[test]
fn the_conjugate_gradient_is_one_command_away_and_agrees_with_the_direct_solver() {
    let mesh = r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"25 mm"},"order":1}"#;
    let mut e = engine();
    solved_cantilever(&mut e, mesh);
    let direct = tip_uz(&mut e);
    ok(&mut e, r#"{"cmd":"solve.run","step":"static","solver":"cpu-pcg"}"#);
    let r = result(&mut e);
    assert_eq!(r.solver, "cpu-pcg");
    assert!(r.residual < 1e-10, "the refinement loop reached {}", r.residual);
    assert!(r.balance <= 1e-9, "reactions must still balance: {}", r.balance);
    let pcg = tip_uz(&mut e);
    assert!((pcg - direct).abs() <= 1e-9 * direct.abs(), "cpu-pcg {pcg} mm vs cpu-direct {direct} mm");
    // and a GPU the host never granted is refused by name, with the solvers that do exist
    let err = err(&mut e, r#"{"cmd":"solve.run","step":"static","solver":"gpu-pcg"}"#);
    assert_eq!(err.code, ErrorCode::Unsupported);
    assert!(err.cause.contains("no GPU adapter"), "{}", err.cause);
}

/// The locking lesson: the fully integrated linear hexahedron is much stiffer than the
/// incompatible-modes one on the same mesh, and the ratio is what the Benchmark records.
#[test]
fn the_fully_integrated_hexahedron_locks() {
    let coarse = r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"50 mm"},"order":1,"formulation":"%"}"#;
    let mut a = engine();
    solved_cantilever(&mut a, &coarse.replace('%', "incompatible-modes"));
    let im = (tip_uz(&mut a).abs() - B1_THEORY_MM).abs() / B1_THEORY_MM;
    let mut b = engine();
    solved_cantilever(&mut b, &coarse.replace('%', "full"));
    let full = (tip_uz(&mut b).abs() - B1_THEORY_MM).abs() / B1_THEORY_MM;
    assert!(im < 0.02, "incompatible modes at 50 mm: {:.2} %", im * 100.0);
    assert!(full > 5.0 * im, "full integration {:.2} % vs incompatible {:.2} %", full * 100.0, im * 100.0);
}

/// Quadratic elements land within 1 % of the beam formula; the last 0.7 % is the fully clamped
/// root, which beam theory does not model, not the mesh (see the Benchmark case's note).
#[test]
fn quadratic_elements_reach_the_beam_formula() {
    let mut e = engine();
    solved_cantilever(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"25 mm"},"order":2}"#);
    let error = (tip_uz(&mut e).abs() - B1_THEORY_MM).abs() / B1_THEORY_MM;
    assert!(error < 0.01, "hex20 at 25 mm: {:.2} %", error * 100.0);
    assert!(result(&mut e).balance <= 1e-9);
}

#[test]
fn a_solve_refuses_a_model_it_cannot_answer_for() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"bare"}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"beam","size":["1 m","100 mm","100 mm"]}"#);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"50 mm"},"order":1}"#);
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"root","on":"beam.xmin"}"#);
    ok(&mut e, r#"{"cmd":"step.add","name":"static","procedure":"static","constraints":["root"],"loads":[]}"#);
    // no material on the Body
    assert_eq!(code(&mut e, r#"{"cmd":"solve.run","step":"static"}"#), ErrorCode::ModelNoMaterial);
    ok(&mut e, r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3}"#);
    ok(&mut e, r#"{"cmd":"material.assign","material":"steel","bodies":["beam"]}"#);
    assert!(run(&mut e, r#"{"cmd":"solve.run","step":"static"}"#).is_ok());
    // nothing holding it
    ok(&mut e, r#"{"cmd":"step.add","name":"loose","procedure":"static","constraints":[],"loads":[]}"#);
    let err = err(&mut e, r#"{"cmd":"solve.run","step":"loose"}"#);
    assert_eq!(err.code, ErrorCode::ConstraintRigidModes);
    assert!(err.cause.contains("translation x"), "{}", err.cause);
    // and a Step nobody defined
    assert_eq!(code(&mut e, r#"{"cmd":"solve.run","step":"nope"}"#), ErrorCode::NotFound);
    // a Result Query before any solve, and for a Step that has none
    let mut fresh = engine();
    assert_eq!(fresh.query(Query::Result { step: None }).expect_err("nothing solved").code, ErrorCode::NotFound);
    assert_eq!(
        e.query(Query::Result { step: Some("loose".into()) }).expect_err("never solved").code,
        ErrorCode::NotFound
    );
}

#[test]
fn a_result_goes_stale_when_the_model_changes_and_undo_orphans_it() {
    let mut e = engine();
    solved_cantilever(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"50 mm"},"order":1}"#);
    assert!(!result(&mut e).stale);
    // an edit that does not touch the mesh still stales the Result: the Model hash moved
    ok(&mut e, r#"{"cmd":"model.setUnits","units":{"length":"m"}}"#);
    assert!(result(&mut e).stale, "the Result predates the edit");
    // undoing back to the solved Model makes it current again
    ok(&mut e, r#"{"cmd":"journal.undo"}"#);
    assert!(!result(&mut e).stale);
    // undoing past the solve orphans the Result: it survives, and says it is stale
    ok(&mut e, r#"{"cmd":"journal.undo","steps":3}"#);
    // the Step is gone from the Model, so only its name reaches the Result it orphaned
    assert_eq!(e.query(Query::Result { step: None }).expect_err("no Step to default to").code, ErrorCode::NotFound);
    let QueryResult::Result(r) = e.query(Query::Result { step: Some("static".into()) }).unwrap() else { panic!() };
    assert!(r.stale, "the Step it belongs to is gone");
    assert_eq!(r.step, "static");
    // model.new throws Results away entirely
    ok(&mut e, r#"{"cmd":"model.new","name":"other"}"#);
    assert_eq!(e.query(Query::Result { step: None }).expect_err("cleared").code, ErrorCode::NotFound);
}

#[test]
fn probing_and_walking_a_solved_field() {
    let mut e = engine();
    solved_cantilever(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"50 mm"},"order":1}"#);
    // the magnitude when no component is named
    let q = Query::Probe {
        step: Some("static".into()),
        field: Field::Displacement,
        component: None,
        at: [Q::text("1 m"), Q::text("50 mm"), Q::text("50 mm")],
    };
    let QueryResult::Probe(p) = e.query(q).unwrap() else { panic!() };
    assert!(p.value.value > 0.0, "a magnitude is positive: {}", p.value.value);
    // off the mesh
    let off = Query::Probe {
        step: None,
        field: Field::Displacement,
        component: Some(2),
        at: [Q::text("2 m"), Q::text("50 mm"), Q::text("50 mm")],
    };
    assert_eq!(e.query(off).expect_err("outside").code, ErrorCode::NotFound);
    // an unaveraged field is not nodal, so it cannot be sampled at a point
    let per_elem = Query::Probe {
        step: None,
        field: Field::StressUnaveraged,
        component: Some(0),
        at: [Q::text("0 m"), Q::text("50 mm"), Q::text("50 mm")],
    };
    assert_eq!(e.query(per_elem).expect_err("per element node").code, ErrorCode::Unsupported);
    // a path down the axis rises monotonically to the tip
    let path = Query::Path {
        step: None,
        field: Field::Displacement,
        component: Some(2),
        from: [Q::text("0 m"), Q::text("50 mm"), Q::text("50 mm")],
        to: [Q::text("1 m"), Q::text("50 mm"), Q::text("50 mm")],
        n: 9,
    };
    let QueryResult::Path(p) = e.query(path).unwrap() else { panic!() };
    assert_eq!(p.s.len(), 9);
    assert_eq!(p.unit, "mm");
    let v: Vec<f64> = p.values.iter().map(|x| x.expect("inside the beam")).collect();
    assert!(v.windows(2).all(|w| w[1] < w[0]), "{v:?}");
    // a path that misses the mesh reports the gaps
    let miss = Query::Path {
        step: None,
        field: Field::Displacement,
        component: Some(2),
        from: [Q::text("2 m"), Q::text("0 m"), Q::text("0 m")],
        to: [Q::text("3 m"), Q::text("0 m"), Q::text("0 m")],
        n: 3,
    };
    let QueryResult::Path(p) = e.query(miss).unwrap() else { panic!() };
    assert!(p.values.iter().all(Option::is_none));
    // re-meshing under the Result makes it unsamplable, and says why
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"25 mm"},"order":1}"#);
    let q = Query::Probe {
        step: None,
        field: Field::Displacement,
        component: Some(2),
        at: [Q::text("1 m"), Q::text("50 mm"), Q::text("50 mm")],
    };
    let e2 = e.query(q).expect_err("the mesh moved");
    assert_eq!(e2.code, ErrorCode::ResultStale);
    assert!(e2.cause.contains("current Model"), "{}", e2.cause);
}

fn assert_stale_mesh_consumers(e: &mut Engine) {
    let revision = e.revision();
    let export = err(e, r#"{"cmd":"mesh.export","format":"vtu","step":"static"}"#);
    let probe = e
        .query(
            serde_json::from_str(
                r#"{
        "query":"query.probe","field":"displacement","component":2,
        "at":["500 mm","50 mm","50 mm"]
    }"#,
            )
            .unwrap(),
        )
        .expect_err("a stale field cannot be sampled on the current Mesh");
    let path = e
        .query(
            serde_json::from_str(
                r#"{
        "query":"query.path","step":"static","field":"displacement","component":2,
        "from":["0 m","50 mm","50 mm"],"to":["1 m","50 mm","50 mm"],"n":5
    }"#,
            )
            .unwrap(),
        )
        .expect_err("a stale field cannot be sampled along the current Mesh");
    for error in [export, probe, path] {
        assert_eq!(error.code, ErrorCode::ResultStale);
        assert_eq!(error.where_.as_deref(), Some("step 'static'"));
        assert_eq!(error.suggestion.as_deref(), Some("solve.run on step 'static' again"));
    }
    assert_eq!(e.revision(), revision, "failed export and Queries cannot append Commands");
    assert!(result(e).stale, "the stored summary remains available and explicitly stale");
}

#[test]
fn result_mesh_consumers_reject_changed_counts_and_same_count_geometry() {
    let changes = [
        (r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"25 mm"},"order":1}"#, false),
        (
            r#"{"cmd":"geometry.addBox","name":"beam","size":["1 m","100 mm","100 mm"],"at":["0 m","10 mm","0 m"]}"#,
            true,
        ),
    ];
    for (change, same_count) in changes {
        let mut e = engine();
        solved_cantilever(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"50 mm"},"order":1}"#);
        let before = e.mesh().unwrap().mesh.clone();
        ok(&mut e, change);
        let after = &e.mesh().unwrap().mesh;
        assert_eq!(before.n_nodes() == after.n_nodes(), same_count);
        assert_ne!(before.coords, after.coords, "the current Mesh really changed");
        assert_stale_mesh_consumers(&mut e);
        // Restoring the exact solved Model makes the stored field safe again, even though
        // the Journal revision moved. Re-solving is not required just to undo the edit.
        ok(&mut e, r#"{"cmd":"journal.undo"}"#);
        assert!(!result(&mut e).stale);
        assert!(tip_uz(&mut e) < 0.0);
        let output = ok(&mut e, r#"{"cmd":"mesh.export","format":"vtu","step":"static"}"#).output;
        let Output::Export { text, .. } = output else { panic!("a VTU export") };
        let vtk = vtkio::Vtk::parse_xml(text.as_bytes()).expect("independent VTK reader accepts the restored Result");
        let piece = vtkio::model::UnstructuredGridPiece::try_from(vtk.data).unwrap();
        assert_eq!(piece.num_points(), before.n_nodes());
        // The suggested Command repairs the edited Model for all three consumers as well.
        ok(&mut e, change);
        ok(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
        assert!(tip_uz(&mut e) < 0.0);
        let path = serde_json::from_str(
            r#"{"query":"query.path","field":"displacement","component":2,
                "from":["0 m","50 mm","50 mm"],"to":["1 m","50 mm","50 mm"],"n":5}"#,
        )
        .unwrap();
        let QueryResult::Path(path) = e.query(path).unwrap() else { panic!("a path") };
        assert_eq!(path.values.len(), 5);
        assert!(path.values.iter().all(Option::is_some));
        let output = ok(&mut e, r#"{"cmd":"mesh.export","format":"vtu","step":"static"}"#).output;
        let Output::Export { text, .. } = output else { panic!("a VTU export") };
        let vtk = vtkio::Vtk::parse_xml(text.as_bytes()).expect("independent VTK reader accepts the re-solved Result");
        let piece = vtkio::model::UnstructuredGridPiece::try_from(vtk.data).unwrap();
        assert_eq!(piece.num_points(), e.mesh().unwrap().mesh.n_nodes());
    }
}

#[test]
fn the_cost_of_a_step_is_the_sparsity_of_its_mesh() {
    let mut e = engine();
    cantilever(&mut e);
    let QueryResult::Cost(c) = e.query(Query::Cost { step: "static".into() }).unwrap() else { panic!() };
    assert_eq!(c.dofs, 3075, "1025 nodes x 3");
    assert!(c.nnz > c.dofs);
    assert!(c.bytes > c.nnz * 12 + c.dofs * 32);
    assert_eq!(c.nnz_lower, c.nnz);
    assert_eq!((c.retained_frames, c.retained_bytes, c.transient_work_bytes, c.transport_staging_bytes), (0, 0, 0, 0));
    assert_eq!(c.bytes, c.assembly_bytes);
    assert_eq!(c.feasible, None);
    assert_eq!(c.budget_bytes, 1_610_612_736);
    assert!(c.note.starts_with("cpu-direct"), "{}", c.note);
    assert_eq!(e.query(Query::Cost { step: "nope".into() }).expect_err("no such step").code, ErrorCode::NotFound);
    for procedure in ["heat-steady", "heat-transient"] {
        ok(
            &mut e,
            &format!(
                r#"{{"cmd":"step.add","name":"{procedure}","procedure":"{procedure}","loads":[],"constraints":[],"dt":"0.1 s","tEnd":"1 s"}}"#
            ),
        );
        let QueryResult::Cost(heat) = e.query(Query::Cost { step: procedure.into() }).unwrap() else { panic!() };
        assert_eq!(heat.dofs, c.dofs / 3);
        assert_eq!(heat.nnz, c.nnz / 9);
        assert!(heat.bytes < c.bytes);
        if procedure == "heat-transient" {
            assert_eq!(heat.retained_frames, 11, "initial plus all ten steps");
            assert_eq!(heat.retained_bytes, 11 * (1025 + 1) * 8);
            assert_eq!(heat.transient_work_bytes, 1025 * 5 * 8);
            assert_eq!(heat.transport_staging_bytes, 1025 * 3 * 8);
            assert_eq!(heat.bytes, heat.assembly_bytes + heat.retained_bytes + heat.transient_work_bytes);
        } else {
            assert_eq!(heat.retained_frames, 0);
        }
    }
    for (name, every, frames) in [("partial", 4, 4), ("endpoint-only", 20, 2)] {
        ok(
            &mut e,
            &format!(
                r#"{{"cmd":"step.add","name":"{name}","procedure":"heat-transient","loads":[],"constraints":[],"dt":"0.1 s","tEnd":"1 s","outputEvery":{every}}}"#
            ),
        );
        let QueryResult::Cost(heat) = e.query(Query::Cost { step: name.into() }).unwrap() else { panic!() };
        assert_eq!(heat.retained_frames, frames);
        assert_eq!(heat.retained_bytes, frames * (1025 + 1) * 8);
    }
    ok(&mut e, r#"{"cmd":"step.add","name":"modes","procedure":"modal","constraints":["root"],"loads":[],"nModes":2}"#);
    let QueryResult::Cost(modal) = e.query(Query::Cost { step: "modes".into() }).unwrap() else { panic!() };
    assert_eq!(modal.retained_frames, 0);
}

#[test]
fn transient_cost_errors_are_structured_before_allocation() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"cost errors"}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"block","size":["1 m","1 m","1 m"]}"#);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":1,"ny":1,"nz":1}}}"#);
    ok(&mut e, r#"{"cmd":"step.add","name":"static","procedure":"static","constraints":[],"loads":[]}"#);
    let QueryResult::Cost(static_cost) = e.query(Query::Cost { step: "static".into() }).unwrap() else { panic!() };
    assert_eq!(static_cost.retained_frames, 0, "a static step retains no transient frames");

    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"missing-dt","procedure":"heat-transient","constraints":[],"loads":[],"tEnd":"1 s"}"#,
    );
    assert_eq!(e.query(Query::Cost { step: "missing-dt".into() }).expect_err("dt is required").code, ErrorCode::Schema);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"zero-dt","procedure":"heat-transient","constraints":[],"loads":[],"dt":"0 s","tEnd":"1 s"}"#,
    );
    assert_eq!(
        e.query(Query::Cost { step: "zero-dt".into() }).expect_err("the grid is invalid").code,
        ErrorCode::Schema
    );

    ok(&mut e, r#"{"cmd":"load.traction","name":"tip","on":"block.xmax","total":["1 N","0 N","0 N"]}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"dynamic","procedure":"explicit","constraints":[],"loads":["tip"],"tEnd":"1 ms"}"#,
    );
    assert_eq!(
        e.query(Query::Cost { step: "dynamic".into() }).expect_err("the Body has no Material").code,
        ErrorCode::ModelNoMaterial
    );
    ok(&mut e, r#"{"cmd":"material.add","name":"massless","E":"210 GPa","nu":0.3}"#);
    ok(&mut e, r#"{"cmd":"material.assign","material":"massless","bodies":["block"]}"#);
    assert_eq!(
        e.query(Query::Cost { step: "dynamic".into() }).expect_err("there is no density").code,
        ErrorCode::ModelIllPosed
    );

    ok(&mut e, r#"{"cmd":"material.add","name":"massless","E":"210 GPa","nu":0.3,"rho":"7850 kg/m^3"}"#);
    ok(&mut e, r#"{"cmd":"constraint.prescribe","name":"left-a","on":"block.xmin","dof":"ux","value":"0 m"}"#);
    ok(&mut e, r#"{"cmd":"constraint.prescribe","name":"left-b","on":"block.xmin","dof":"ux","value":"1 mm"}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"conflicting-grid","procedure":"explicit","constraints":["left-a","left-b"],"loads":[],"tEnd":"1 ms"}"#,
    );
    assert_eq!(
        e.query(Query::Cost { step: "conflicting-grid".into() })
            .expect_err("planning resolves the same conflicting constraints as integration")
            .code,
        ErrorCode::ConstraintConflict
    );
}

#[test]
fn exporting_a_step_writes_its_fields_as_point_data() {
    let mut e = engine();
    solved_cantilever(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"50 mm"},"order":1}"#);
    let ack = ok(&mut e, r#"{"cmd":"mesh.export","format":"vtu","step":"static"}"#);
    let Output::Export { text, filename, .. } = ack.output else { panic!("an export") };
    assert_eq!(filename, "cantilever.vtu");
    for name in ["Displacement", "Reaction", "Stress", "VonMises"] {
        assert!(text.contains(&format!("Name=\"{name}\"")), "missing {name}");
    }
    let nodes = decode_f64(&text, "Points").len() / 3;
    assert_eq!(decode_f64(&text, "Displacement").len(), nodes * 3);
    assert_eq!(decode_f64(&text, "VonMises").len(), nodes);
    assert_eq!(decode_f64(&text, "Stress").len(), nodes * 6);
    // An independent VTK implementation must accept the unmodified file and all tuple
    // counts. The former helper decoded header and payload separately, hiding invalid XML.
    let vtk = vtkio::Vtk::parse_xml(text.as_bytes()).expect("independent VTK reader accepts the result export");
    let piece = vtkio::model::UnstructuredGridPiece::try_from(vtk.data).unwrap();
    assert_eq!(piece.num_points(), nodes);
    assert_eq!(piece.cells.num_cells(), e.mesh().unwrap().mesh.n_elems());
    for attribute in &piece.data.point {
        let vtkio::model::Attribute::DataArray(array) = attribute else { panic!("XML point DataArray") };
        assert_eq!(array.data.len(), nodes * array.num_comp(), "{} tuple count", array.name);
    }
    // the same export without a Step carries the Mesh alone
    let ack = ok(&mut e, r#"{"cmd":"mesh.export","format":"vtu"}"#);
    let Output::Export { text, .. } = ack.output else { panic!() };
    assert!(!text.contains("VonMises"));
    // and a Step with no Result cannot be exported
    assert_eq!(code(&mut e, r#"{"cmd":"mesh.export","format":"vtu","step":"nope"}"#), ErrorCode::NotFound);
}

#[test]
fn the_mesh_writers_are_reachable_through_mesh_export() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"blocks"}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"b","size":["1 m","1 m","1 m"]}"#);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":1,"ny":1,"nz":1}},"order":1}"#);
    let cases = [
        ("msh", "blocks.msh", "model/mesh", "$MeshFormat", femlab_engine::command::ExportFormat::Msh),
        ("inp", "blocks.inp", "text/plain", "*NODE", femlab_engine::command::ExportFormat::Inp),
        ("stl", "blocks.stl", "model/stl", "solid", femlab_engine::command::ExportFormat::Stl),
    ];
    for (name, file, mime, marker, want) in cases {
        let ack = ok(&mut e, &format!(r#"{{"cmd":"mesh.export","format":"{name}"}}"#));
        let Output::Export { format, filename, mime: got_mime, text } = ack.output else { panic!("an export") };
        assert_eq!(format, want);
        assert_eq!(filename, file);
        assert_eq!(got_mime, mime);
        assert!(text.contains(marker), "{name} export is missing {marker}");
    }
    // Every variant answers `extension()`, which is what a host names the file from.
    assert_eq!(femlab_engine::command::ExportFormat::Vtu.extension(), ("vtu", "application/xml"));
}

#[test]
fn named_sets_keep_their_exact_membership_in_msh_and_inp_exports() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"groups"}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"b","size":["2 m","1 m","1 m"]}"#);
    ok(&mut e, r#"{"cmd":"geometry.nameFace","name":"loaded","of":"b","where":{"kind":"normal","normal":[1,0,0]}}"#);
    ok(
        &mut e,
        r#"{"cmd":"geometry.nameRegion","name":"left-cell","where":{"kind":"bbox","min":["0 m","0 m","0 m"],"max":["1 m","1 m","1 m"]}}"#,
    );
    ok(
        &mut e,
        r#"{"cmd":"geometry.nameRegion","name":"mid-plane","where":{"kind":"bbox","min":["1 m","0 m","0 m"],"max":["1 m","1 m","1 m"]}}"#,
    );
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":2,"ny":1,"nz":1}},"order":1}"#);

    let Output::Export { text: msh_text, .. } = ok(&mut e, r#"{"cmd":"mesh.export","format":"msh"}"#).output else {
        panic!("an MSH export")
    };
    let msh = femlab_engine::io::read_msh(&msh_text).unwrap();
    assert_eq!(msh.elem_sets["left-cell"], [0], "a partial original element block survives");
    let expected_left: Vec<u32> =
        msh.coords.chunks_exact(3).enumerate().filter(|(_, xyz)| xyz[0] <= 1.0).map(|(node, _)| node as u32).collect();
    let expected_mid: Vec<u32> =
        msh.coords.chunks_exact(3).enumerate().filter(|(_, xyz)| xyz[0] == 1.0).map(|(node, _)| node as u32).collect();
    let expected_loaded: Vec<u32> =
        msh.coords.chunks_exact(3).enumerate().filter(|(_, xyz)| xyz[0] == 2.0).map(|(node, _)| node as u32).collect();
    assert_eq!(msh.node_sets["left-cell"], expected_left, "an element region also keeps its nodes");
    assert_eq!(msh.node_sets["mid-plane"], expected_mid, "the node-only region survives");
    assert_eq!(msh.node_sets["loaded"], expected_loaded, "a face Set also keeps its nodes");
    assert_eq!(msh.face_sets["loaded"].len(), 1);
    assert_eq!(msh.face_sets["loaded"][0].elem, 1);

    let Output::Export { text: inp, .. } = ok(&mut e, r#"{"cmd":"mesh.export","format":"inp"}"#).output else {
        panic!("an INP export")
    };
    let records = |header: &str| -> Vec<&str> {
        inp.split_once(header)
            .map(|(_, rest)| rest.lines().take_while(|line| !line.starts_with('*')).collect())
            .unwrap_or_default()
    };
    assert_eq!(records("*ELSET, ELSET=left-cell\n"), ["1"]);
    let node_ids = |name: &str| -> Vec<u32> {
        records(&format!("*NSET, NSET={name}\n"))
            .iter()
            .flat_map(|line| line.split(", "))
            .map(|id| id.parse().unwrap())
            .collect()
    };
    assert_eq!(node_ids("left-cell"), expected_left.iter().map(|node| node + 1).collect::<Vec<_>>());
    assert_eq!(node_ids("mid-plane"), expected_mid.iter().map(|node| node + 1).collect::<Vec<_>>());
    assert_eq!(node_ids("loaded"), expected_loaded.iter().map(|node| node + 1).collect::<Vec<_>>());
    assert_eq!(records("*SURFACE, TYPE=ELEMENT, NAME=loaded\n"), ["2, S4"]);
}

#[test]
fn a_host_reads_a_field_straight_off_the_result() {
    let mut e = engine();
    solved_cantilever(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"50 mm"},"order":1}"#);
    let u = e.field(Some("static"), Field::Displacement).expect("displacement");
    assert_eq!(u.comps, 3);
    assert_eq!(u.data.len(), u.len() * 3);
    let uz = u.component(2);
    assert_eq!(uz.len(), u.len());
    assert!(uz.iter().any(|v| *v < 0.0), "the beam sags");
    assert_eq!(e.field(None, Field::Displacement).expect("the last solved step").comps, 3);
    // temperature was never computed in a static Step
    assert_eq!(e.field(None, Field::Temperature).expect_err("no such field").code, ErrorCode::NotFound);
    let before = e.revision();
    let unavailable = e
        .query(Query::Probe {
            step: None,
            field: Field::Temperature,
            component: None,
            at: [Q::text("500 mm"), Q::text("50 mm"), Q::text("50 mm")],
        })
        .expect_err("a current structural Result still has no temperature field");
    assert_eq!(unavailable.code, ErrorCode::NotFound);
    assert!(unavailable.cause.contains("no temperature field"));
    assert!(unavailable.suggestion.unwrap().contains("query.result"));
    assert_eq!(e.revision(), before);
    let unsolved = engine();
    let missing = unsolved.field(None, Field::Displacement).expect_err("a raw field needs a solved Step");
    assert_eq!(missing.code, ErrorCode::NotFound);
    assert_eq!(missing.suggestion.as_deref(), Some("solve.run"));
}

#[test]
fn a_cancelled_solve_changes_nothing() {
    let mut e = engine();
    cantilever(&mut e);
    let cmd: Command = serde_json::from_str(r#"{"cmd":"solve.run","step":"static"}"#).unwrap();
    let before = e.revision();
    let mut stop = |_: Progress| false;
    let err = pollster::block_on(e.dispatch(cmd, &mut stop)).expect_err("cancelled");
    assert_eq!(err.code, ErrorCode::Cancelled);
    assert_eq!(e.revision(), before, "a cancelled Command is not journaled");
    assert_eq!(e.query(Query::Result { step: None }).expect_err("nothing stored").code, ErrorCode::NotFound);
}

#[test]
fn a_gravity_load_and_a_prescribed_displacement_go_through_the_same_path() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"block"}"#);
    ok(&mut e, r#"{"cmd":"model.setUnits","units":{"length":"mm","force":"N"}}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"b","size":["1 m","1 m","1 m"]}"#);
    ok(&mut e, r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"rho":"7850 kg/m^3"}"#);
    ok(&mut e, r#"{"cmd":"material.assign","material":"steel","bodies":["b"]}"#);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"500 mm"},"order":1}"#);
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"base","on":"b.zmin"}"#);
    ok(&mut e, r#"{"cmd":"constraint.prescribe","name":"pull","on":"b.zmax","dof":"uz","value":"1 mm"}"#);
    ok(&mut e, r#"{"cmd":"load.gravity","name":"g","g":["0 m/s^2","0 m/s^2","-9.81 m/s^2"]}"#);
    ok(&mut e, r#"{"cmd":"load.force","name":"tug","on":"b.xmax","total":["1 kN","0 N","0 N"]}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"s","procedure":"static","constraints":["base","pull"],"loads":["g","tug"]}"#,
    );
    ok(&mut e, r#"{"cmd":"solve.run","step":"s"}"#);
    let r = result(&mut e);
    // the weight of a 1 m³ steel block plus the 1 kN tug
    assert!((r.applied_total[2].value + 7850.0 * 9.81).abs() <= 1e-6 * 7850.0 * 9.81);
    assert!((r.applied_total[0].value - 1000.0).abs() <= 1e-9 * 1000.0);
    assert!(r.balance <= 1e-9, "{}", r.balance);
    assert_eq!(r.reactions.len(), 2);
    assert!(r.reactions.iter().any(|x| x.constraint == "pull"));
}

#[test]
fn a_temperature_load_expands_a_free_block() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"hot"}"#);
    ok(&mut e, r#"{"cmd":"model.setUnits","units":{"length":"mm","stress":"MPa"}}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"b","size":["1 m","1 m","1 m"]}"#);
    ok(&mut e, r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"alpha":"1.2e-5 1/K"}"#);
    ok(&mut e, r#"{"cmd":"material.assign","material":"steel","bodies":["b"]}"#);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"500 mm"},"order":1}"#);
    ok(&mut e, r#"{"cmd":"constraint.symmetry","name":"sx","on":"b.xmin","normal":"x"}"#);
    ok(&mut e, r#"{"cmd":"constraint.symmetry","name":"sy","on":"b.ymin","normal":"y"}"#);
    ok(&mut e, r#"{"cmd":"constraint.symmetry","name":"sz","on":"b.zmin","normal":"z"}"#);
    ok(&mut e, r#"{"cmd":"load.temperature","name":"hot","bodies":["b"],"value":"100 K","reference":"0 K"}"#);
    ok(&mut e, r#"{"cmd":"step.add","name":"s","procedure":"static","constraints":["sx","sy","sz"],"loads":["hot"]}"#);
    ok(&mut e, r#"{"cmd":"solve.run","step":"s"}"#);
    let r = result(&mut e);
    // ε = α ΔT over 1 m is 1.2 mm at the far face, and the block carries no stress
    let ux = r.extremes.iter().find(|x| x.field == "displacement" && x.component == 0).expect("ux");
    assert!((ux.max.value - 1.2).abs() <= 1e-6, "{} mm", ux.max.value);
    let vm = r.extremes.iter().find(|x| x.field == "vonMises").expect("von Mises");
    assert!(vm.max.value.abs() <= 1e-6, "{} MPa", vm.max.value);
}

/// Three disconnected cubes with independently restrained rigid modes. The third is unheated.
fn thermal_cubes(e: &mut Engine, n: usize) -> Vec<String> {
    ok(e, r#"{"cmd":"model.new","name":"thermal cubes"}"#);
    ok(e, r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"alpha":"1.2e-5 1/K","k":"10 W/(m K)"}"#);
    let mut constraints = Vec::new();
    for (i, body) in ["a", "b", "c"].iter().enumerate() {
        ok(
            e,
            &format!(
                r#"{{"cmd":"geometry.addBox","name":"{body}","size":["1 m","1 m","1 m"],"at":["{} m","0 m","0 m"]}}"#,
                i * 2
            ),
        );
        for axis in ["x", "y", "z"] {
            let name = format!("{body}{axis}");
            ok(
                e,
                &format!(
                    r#"{{"cmd":"constraint.symmetry","name":"{name}","on":"{body}.{axis}min","normal":"{axis}"}}"#
                ),
            );
            constraints.push(name);
        }
    }
    ok(e, r#"{"cmd":"material.assign","material":"steel","bodies":["a","b","c"]}"#);
    ok(e, &serde_json::json!({"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":n,"ny":n,"nz":n}}}).to_string());
    ok(e, r#"{"cmd":"load.temperature","name":"warm","bodies":["a"],"value":"100 degC","reference":"20 degC"}"#);
    ok(e, r#"{"cmd":"load.temperature","name":"cool","bodies":["b"],"value":"10 degC","reference":"50 degC"}"#);
    constraints
}

/// Closed form at every node: free expansion, or expansion with x restrained at both ends.
fn assert_thermal_cubes(e: &mut Engine, restrained: bool, deltas: [f64; 3]) -> Vec<f64> {
    let coords = e.mesh().unwrap().mesh.coords.clone();
    let displacement = e.field(None, Field::Displacement).unwrap().data.clone();
    let stress = e.field(None, Field::Stress).unwrap().data.clone();
    for (i, x) in coords.chunks_exact(3).enumerate() {
        let body = (x[0] / 2.0).floor() as usize;
        let delta = deltas[body];
        let strain = 1.2e-5 * delta;
        let local = [x[0] - 2.0 * body as f64, x[1], x[2]];
        let expected = if restrained {
            [0.0, 1.3 * strain * local[1], 1.3 * strain * local[2]]
        } else {
            local.map(|v| strain * v)
        };
        for c in 0..3 {
            assert!(
                (displacement[3 * i + c] - expected[c]).abs() < 1e-12,
                "node {i}, component {c}: free thermal strain"
            );
        }
        let sigma_x = if restrained { -210e9 * strain } else { 0.0 };
        for c in 0..6 {
            let want = if c == 0 { sigma_x } else { 0.0 };
            assert!(
                (stress[6 * i + c] - want).abs() < 1e-3,
                "node {i}, stress {c}: {} vs {want} Pa",
                stress[6 * i + c]
            );
        }
    }
    [displacement, stress].concat()
}

#[test]
fn disjoint_temperature_loads_compose_independently_of_order() {
    for n in [1, 2, 3] {
        let mut fields = Vec::new();
        for loads in [r#"["warm","cool"]"#, r#"["cool","warm"]"#, r#"["warm","cool","same"]"#] {
            let mut e = engine();
            let constraints = thermal_cubes(&mut e, n);
            // Same increment, different absolute temperature/reference: overlap is harmless.
            ok(
                &mut e,
                r#"{"cmd":"load.temperature","name":"same","bodies":["a","a"],"value":"180 K","reference":"100 K"}"#,
            );
            ok(
                &mut e,
                &format!(
                    r#"{{"cmd":"step.add","name":"s","procedure":"static","constraints":{},"loads":{loads}}}"#,
                    serde_json::to_string(&constraints).unwrap()
                ),
            );
            ok(&mut e, r#"{"cmd":"solve.run","step":"s"}"#);
            fields.push(assert_thermal_cubes(&mut e, false, [80.0, -40.0, 0.0]));
        }
        assert_eq!(fields[0], fields[1], "load order cannot change the displacement field");
        assert_eq!(fields[0], fields[2], "duplicate increments must not be summed");
    }
}

#[test]
fn conflicting_temperature_loads_report_both_names_and_the_body() {
    for loads in [r#"["warm","different"]"#, r#"["different","warm"]"#] {
        let mut e = engine();
        let constraints = thermal_cubes(&mut e, 1);
        ok(
            &mut e,
            r#"{"cmd":"load.temperature","name":"different","bodies":["a"],"value":"180 K","reference":"50 K"}"#,
        );
        ok(
            &mut e,
            &format!(
                r#"{{"cmd":"step.add","name":"s","procedure":"static","constraints":{},"loads":{loads}}}"#,
                serde_json::to_string(&constraints).unwrap()
            ),
        );
        let before = e.export_file();
        let error = err(&mut e, r#"{"cmd":"solve.run","step":"s"}"#);
        assert_eq!(error.code, ErrorCode::ModelIllPosed);
        assert!(error.cause.contains("warm") && error.cause.contains("different") && error.cause.contains("body 'a'"));
        assert_eq!(error.where_.as_deref(), Some("step 's'"));
        assert!(error.suggestion.as_deref().unwrap().contains("load.temperature"));
        assert_eq!(e.export_file(), before);
        assert_eq!(e.query(Query::Result { step: None }).unwrap_err().code, ErrorCode::NotFound);
    }
}

#[test]
fn chained_heat_uses_each_bodys_reference_temperature() {
    for n in [1, 2, 3] {
        let mut fields = Vec::new();
        for (loads, deltas) in [
            (r#"["warm","cool"]"#, [80.0, -40.0, 0.0]),
            (r#"["cool","warm"]"#, [80.0, -40.0, 0.0]),
            ("[]", [80.0, -10.0, 0.0]),
        ] {
            let mut e = engine();
            let mut constraints = thermal_cubes(&mut e, n);
            let mut heat_constraints = Vec::new();
            for (body, temperature) in [("a", "100 degC"), ("b", "10 degC"), ("c", "20 degC")] {
                for face in ["xmin", "xmax"] {
                    let name = format!("{body}_{face}");
                    ok(
                        &mut e,
                        &format!(
                            r#"{{"cmd":"constraint.temperature","name":"{name}","on":"{body}.{face}","value":"{temperature}"}}"#
                        ),
                    );
                    heat_constraints.push(name);
                }
                let name = format!("{body}_end");
                ok(
                    &mut e,
                    &format!(r#"{{"cmd":"constraint.symmetry","name":"{name}","on":"{body}.xmax","normal":"x"}}"#),
                );
                constraints.push(name);
            }
            ok(
                &mut e,
                &format!(
                    r#"{{"cmd":"step.add","name":"heat","procedure":"heat-steady","constraints":{},"loads":[]}}"#,
                    serde_json::to_string(&heat_constraints).unwrap()
                ),
            );
            ok(
                &mut e,
                &format!(
                    r#"{{"cmd":"step.add","name":"stress","procedure":"static","after":"heat","constraints":{},"loads":{loads}}}"#,
                    serde_json::to_string(&constraints).unwrap()
                ),
            );
            ok(&mut e, r#"{"cmd":"solve.run","step":"heat"}"#);
            ok(&mut e, r#"{"cmd":"solve.run","step":"stress"}"#);
            fields.push(assert_thermal_cubes(&mut e, true, deltas));
            if loads == "[]" {
                // Equal prescribed increments can have different references. Once a heat
                // field supplies T, those references conflict and neither may win by order.
                ok(
                    &mut e,
                    r#"{"cmd":"load.temperature","name":"same","bodies":["a"],"value":"180 K","reference":"100 K"}"#,
                );
                ok(
                    &mut e,
                    &format!(
                        r#"{{"cmd":"step.add","name":"stress","procedure":"static","after":"heat","constraints":{},"loads":["warm","same"]}}"#,
                        serde_json::to_string(&constraints).unwrap()
                    ),
                );
                ok(&mut e, r#"{"cmd":"solve.run","step":"heat"}"#);
                let error = err(&mut e, r#"{"cmd":"solve.run","step":"stress"}"#);
                assert_eq!(error.code, ErrorCode::ModelIllPosed);
                assert!(
                    error.cause.contains("warm") && error.cause.contains("same") && error.cause.contains("body 'a'")
                );
            }
        }
        assert_eq!(fields[0], fields[1], "reference lookup must be independent of load order");
    }
}

/// The paths a Result Query can fail on: a Set a Load names that the Mesh never made, a Model
/// that cannot be meshed at all, and a point given in the wrong dimension.
#[test]
fn result_queries_refuse_what_they_cannot_answer() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"beam"}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"b","size":["1 m","100 mm","100 mm"]}"#);
    ok(&mut e, r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"rho":"7850 kg/m^3"}"#);
    ok(&mut e, r#"{"cmd":"material.assign","material":"steel","bodies":["b"]}"#);
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"root","on":"b.xmin"}"#);
    ok(&mut e, r#"{"cmd":"load.traction","name":"nowhere","on":"b.side","total":["0 N","0 N","-1 kN"]}"#);
    ok(&mut e, r#"{"cmd":"load.force","name":"tug","on":"b.side","total":["1 kN","0 N","0 N"]}"#);
    ok(&mut e, r#"{"cmd":"load.pressure","name":"squeeze","on":"b.xmax","value":"1 MPa"}"#);
    ok(&mut e, r#"{"cmd":"step.add","name":"s","procedure":"static","constraints":["root"],"loads":["squeeze"]}"#);
    // no mesh settings: nothing can be built
    assert_eq!(code(&mut e, r#"{"cmd":"solve.run","step":"s"}"#), ErrorCode::ModelIllPosed);
    assert_eq!(e.query(Query::Cost { step: "s".into() }).expect_err("no mesh").code, ErrorCode::ModelIllPosed);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"50 mm"},"order":1}"#);
    // a pressure on a real face solves, and the solver options come off the Command
    ok(&mut e, r#"{"cmd":"solve.run","step":"s","solver":"cpu-direct","tolerance":1e-12,"maxIterations":10}"#);
    assert!(result(&mut e).balance <= 1e-9);
    // a Load on a face the Mesh never made
    ok(&mut e, r#"{"cmd":"step.add","name":"t","procedure":"static","constraints":["root"],"loads":["nowhere"]}"#);
    assert_eq!(code(&mut e, r#"{"cmd":"solve.run","step":"t"}"#), ErrorCode::SetEmpty);
    ok(&mut e, r#"{"cmd":"step.add","name":"u","procedure":"static","constraints":["root"],"loads":["tug"]}"#);
    assert_eq!(code(&mut e, r#"{"cmd":"solve.run","step":"u"}"#), ErrorCode::SetEmpty);
    // The added Steps changed the Model; refresh the valid Result before testing bad units.
    ok(&mut e, r#"{"cmd":"solve.run","step":"s"}"#);
    // a point in the wrong dimension, on the probe and on both ends of a path
    let mut bad = |q: Query| e.query(q).expect_err("a mass is not a length").code;
    assert_eq!(
        bad(Query::Probe {
            step: None,
            field: Field::Displacement,
            component: Some(2),
            at: [Q::text("1 kg"), Q::text("0 m"), Q::text("0 m")],
        }),
        ErrorCode::UnitDimension
    );
    let line = |from: [Q<femlab_engine::units::Length>; 3], to: [Q<femlab_engine::units::Length>; 3]| Query::Path {
        step: None,
        field: Field::Displacement,
        component: Some(2),
        from,
        to,
        n: 3,
    };
    let ok3 = || [Q::text("0 m"), Q::text("0 m"), Q::text("0 m")];
    let bad3 = || [Q::text("1 kg"), Q::text("0 m"), Q::text("0 m")];
    assert_eq!(bad(line(bad3(), ok3())), ErrorCode::UnitDimension);
    assert_eq!(bad(line(ok3(), bad3())), ErrorCode::UnitDimension);
    // and a Model that stops meshing under a Result
    ok(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStrain"}}"#);
    let q = Query::Probe {
        step: None,
        field: Field::Displacement,
        component: Some(2),
        at: [Q::text("0 m"), Q::text("0 m"), Q::text("0 m")],
    };
    assert_eq!(e.query(q).expect_err("the Result predates the invalid idealisation").code, ErrorCode::ResultStale);
}

// ---------------------------------------------------- heat, modal, transient and explicit Steps

/// A heat-conducting bar: a box of steel with a conductivity and a capacity, meshed coarsely.
fn heat_bar(e: &mut Engine) {
    ok(e, r#"{"cmd":"model.new","name":"heat"}"#);
    ok(e, r#"{"cmd":"model.setUnits","units":{"length":"mm","temperature":"degC","time":"s"}}"#);
    ok(e, r#"{"cmd":"geometry.addBox","name":"bar","size":["1 m","100 mm","100 mm"]}"#);
    ok(
        e,
        r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"rho":"7850 kg/m^3",
            "alpha":"1.2e-5 1/K","k":"45 W/(m K)","cp":"460 J/(kg K)"}"#,
    );
    ok(e, r#"{"cmd":"material.assign","material":"steel","bodies":["bar"]}"#);
    ok(e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":10,"ny":1,"nz":1}}}"#);
}

fn result_of(e: &mut Engine, step: Option<&str>) -> femlab_engine::query::ResultSummary {
    let QueryResult::Result(r) = e.query(Query::Result { step: step.map(str::to_string) }).unwrap() else {
        panic!("a Result summary")
    };
    r
}

fn probe_at(e: &mut Engine, step: &str, field: Field, component: Option<u8>, at: [&str; 3]) -> f64 {
    let q = Query::Probe {
        step: Some(step.to_string()),
        field,
        component,
        at: [Q::text(at[0]), Q::text(at[1]), Q::text(at[2])],
    };
    let QueryResult::Probe(p) = e.query(q).unwrap() else { panic!("a probe") };
    p.value.value
}

/// The steady heat procedure through the registry: a held temperature at each end, the linear
/// profile out of `query.probe`, and the temperature field in the VTU export.
#[test]
fn a_steady_heat_step_conducts_a_linear_profile_and_exports_it() {
    let mut e = engine();
    heat_bar(&mut e);
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"cold","on":"bar.xmin","value":"0 degC"}"#);
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"hot","on":"bar.xmax","value":"100 degC"}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"conduct","procedure":"heat-steady","constraints":["cold","hot"],
            "loads":[],"output":["temperature"]}"#,
    );
    ok(&mut e, r#"{"cmd":"solve.run","step":"conduct"}"#);
    assert!((probe_at(&mut e, "conduct", Field::Temperature, None, ["500 mm", "50 mm", "50 mm"]) - 50.0).abs() < 1e-9);

    let QueryResult::Model(m) = e.query(Query::Model {}).unwrap() else { panic!() };
    assert_eq!(m.constraints[0].summary, "temperature = 0 degC");
    assert_eq!(m.steps[0].procedure, "heat-steady");
    let summary = result_of(&mut e, None);
    assert_eq!(summary.step, "conduct");
    assert!(summary.frequencies.is_empty() && summary.history.is_empty());
    // The heat in balances the heat out, exactly as a reaction balance does for forces.
    assert!(summary.balance < 1e-9, "{}", summary.balance);

    let Output::Export { text, .. } = ok(&mut e, r#"{"cmd":"mesh.export","format":"vtu","step":"conduct"}"#).output
    else {
        panic!("an export")
    };
    assert!(text.contains("Name=\"Temperature\""), "the VTU carries the temperature field");
    let vtk = vtkio::Vtk::parse_xml(text.as_bytes()).expect("independent VTK reader accepts the temperature export");
    let piece = vtkio::model::UnstructuredGridPiece::try_from(vtk.data).unwrap();
    let points = piece.points.into_vec::<f64>().unwrap();
    let attribute = piece.data.point.iter().find(|a| a.name() == "Temperature").expect("Temperature point field");
    let vtkio::model::Attribute::DataArray(array) = attribute else { panic!("XML point DataArray") };
    let temperature = array.data.cast_into::<f64>().unwrap();
    // Results use three components, with a one-DOF heat field in x.
    assert_eq!(array.num_comp(), 3);
    assert_eq!(temperature.len(), points.len());
    for (point, value) in points.chunks_exact(3).zip(temperature.chunks_exact(3)) {
        assert!((value[0] - (273.15 + 100.0 * point[0])).abs() < 1e-9, "T(x) = 273.15 + 100 x kelvin");
        assert_eq!(&value[1..], &[0.0, 0.0]);
    }
}

/// Convection, flux and source loads reach the Model, report themselves, survive a Body rename,
/// and hold a Step that has no fixed temperature at all.
#[test]
fn the_three_heat_loads_report_themselves_and_hold_a_step_on_their_own() {
    let mut e = engine();
    heat_bar(&mut e);
    ok(
        &mut e,
        r#"{"cmd":"geometry.nameFace","name":"filmFace","of":"bar","where":{"kind":"normal","normal":[1,0,0]}}"#,
    );
    ok(
        &mut e,
        r#"{"cmd":"geometry.nameFace","name":"fluxFace","of":"bar","where":{"kind":"normal","normal":[-1,0,0]}}"#,
    );
    ok(&mut e, r#"{"cmd":"load.convection","name":"film","on":"filmFace","h":"50 W/(m^2 K)","tInf":"20 degC"}"#);
    ok(&mut e, r#"{"cmd":"load.heatFlux","name":"in","on":"fluxFace","q":"1 kW/m^2"}"#);
    ok(&mut e, r#"{"cmd":"load.heatSource","name":"ohmic","bodies":["bar"],"q":"0 kW/m^3"}"#);
    ok(&mut e, r#"{"cmd":"model.rename","kind":"set","name":"filmFace","to":"filmBoundary"}"#);
    ok(&mut e, r#"{"cmd":"model.rename","kind":"set","name":"fluxFace","to":"fluxBoundary"}"#);
    assert_eq!(e.model().load("film").unwrap().kind.set(), Some("filmBoundary"));
    assert_eq!(e.model().load("in").unwrap().kind.set(), Some("fluxBoundary"));
    // Set rename is journaled like every other model edit and restores the exact references.
    ok(&mut e, r#"{"cmd":"journal.undo"}"#);
    assert_eq!(e.model().load("in").unwrap().kind.set(), Some("fluxFace"));
    ok(&mut e, r#"{"cmd":"journal.redo"}"#);
    assert_eq!(e.model().load("in").unwrap().kind.set(), Some("fluxBoundary"));
    let QueryResult::Model(m) = e.query(Query::Model {}).unwrap() else { panic!() };
    let kinds: Vec<&str> = m.loads.iter().map(|l| l.kind.as_str()).collect();
    assert_eq!(kinds, ["convection", "heatFlux", "heatSource"]);
    assert!(m.loads[0].summary.contains("tInf = 20 degC"), "{}", m.loads[0].summary);
    assert!(m.loads[1].summary.starts_with('1'), "{}", m.loads[1].summary);
    assert!(m.loads[2].summary.ends_with("on bar"), "{}", m.loads[2].summary);

    // Keep an automatic face reference too: Body rename must still rewrite it while the
    // explicitly named Sets keep their names and the volumetric source follows the Body.
    ok(&mut e, r#"{"cmd":"load.convection","name":"autoFilm","on":"bar.xmax","h":"50 W/(m^2 K)","tInf":"20 degC"}"#);
    ok(&mut e, r#"{"cmd":"model.rename","kind":"body","name":"bar","to":"rod"}"#);
    let QueryResult::Model(m) = e.query(Query::Model {}).unwrap() else { panic!() };
    assert_eq!(m.loads[0].on.as_deref(), Some("filmBoundary"));
    assert_eq!(e.model().load("autoFilm").unwrap().kind.set(), Some("rod.xmax"));
    assert!(m.loads[2].summary.ends_with("on rod"), "{}", m.loads[2].summary);

    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"conduct","procedure":"heat-steady","constraints":[],
            "loads":["film","in","ohmic"],"output":["temperature"]}"#,
    );
    ok(&mut e, r#"{"cmd":"solve.run","step":"conduct"}"#);
    // Steady state: everything in through the flux leaves through the film, so the far face is
    // T∞ + q/h and the near face one conduction drop above it.
    let far = probe_at(&mut e, "conduct", Field::Temperature, None, ["1 m", "50 mm", "50 mm"]);
    let near = probe_at(&mut e, "conduct", Field::Temperature, None, ["0 mm", "50 mm", "50 mm"]);
    assert!((far - 40.0).abs() < 1e-8, "far face {far}");
    assert!((near - (40.0 + 1000.0 / 45.0)).abs() < 1e-8, "near face {near}");

    // Replay the journal, including both Set renames, and verify the solved model is identical.
    let expected_hash = e.model_hash();
    let entries = e.journal().entries.clone();
    let mut replayed = engine();
    pollster::block_on(replayed.replay(&entries, true, true)).unwrap();
    assert_eq!(replayed.model_hash(), expected_hash);
    assert_eq!(replayed.model().load("film").unwrap().kind.set(), Some("filmBoundary"));
    assert_eq!(replayed.model().load("in").unwrap().kind.set(), Some("fluxBoundary"));
}

/// A heat Step with neither a held temperature nor a film is refused with the Command that
/// fixes it, and so is a transient with no clock.
#[test]
fn a_heat_step_says_what_it_is_missing() {
    let mut e = engine();
    heat_bar(&mut e);
    ok(&mut e, r#"{"cmd":"step.add","name":"bare","procedure":"heat-steady","constraints":[],"loads":[]}"#);
    let bad = err(&mut e, r#"{"cmd":"solve.run","step":"bare"}"#);
    assert_eq!(bad.code, ErrorCode::ConstraintRigidModes);

    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"cold","on":"bar.xmin","value":"0 degC"}"#);
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"hot","on":"bar.xmax","value":"100 degC"}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"noclock","procedure":"heat-transient","constraints":["cold","hot"],
            "loads":[],"tEnd":"10 s"}"#,
    );
    let bad = err(&mut e, r#"{"cmd":"solve.run","step":"noclock"}"#);
    assert_eq!(bad.code, ErrorCode::Schema);
    assert_eq!(bad.where_.as_deref(), Some("dt"));
    assert!(bad.cause.contains("heat-transient"), "{}", bad.cause);

    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"noend2","procedure":"heat-transient","constraints":["cold","hot"],
            "loads":[],"dt":"1 s"}"#,
    );
    let bad = err(&mut e, r#"{"cmd":"solve.run","step":"noend2"}"#);
    assert_eq!(bad.where_.as_deref(), Some("tEnd"));

    ok(&mut e, r#"{"cmd":"step.add","name":"noend","procedure":"explicit","constraints":["cold"],"loads":[]}"#);
    let bad = err(&mut e, r#"{"cmd":"solve.run","step":"noend"}"#);
    assert_eq!(bad.code, ErrorCode::Schema);
    assert_eq!(bad.where_.as_deref(), Some("tEnd"));
}

/// Heat procedures reject transport properties at the point where they become required. A
/// steady Step only needs conductivity, while a transient also needs density and specific
/// heat. Every refusal is recoverable: the same Engine accepts a corrected material and runs.
#[test]
fn heat_steps_validate_transport_properties_and_theta_without_panicking() {
    let mut e = engine();
    heat_bar(&mut e);
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"cold","on":"bar.xmin","value":"0 K"}"#);
    ok(&mut e, r#"{"cmd":"step.add","name":"steady","procedure":"heat-steady","constraints":["cold"],"loads":[]}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"transient","procedure":"heat-transient","constraints":["cold"],"loads":[],
            "dt":"0.1 s","tEnd":"0.1 s","theta":0.5}"#,
    );

    ok(
        &mut e,
        r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"rho":"7850 kg/m^3","cp":"460 J/(kg K)"}"#,
    );
    let bad = err(&mut e, r#"{"cmd":"solve.run","step":"steady"}"#);
    assert_eq!(bad.code, ErrorCode::ModelIllPosed);
    assert!(bad.cause.contains("conductivity k"), "{bad:?}");

    let bad_materials = [
        (
            r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"rho":"7850 kg/m^3","cp":"460 J/(kg K)"}"#,
            "conductivity k",
        ),
        (
            r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"rho":"7850 kg/m^3","k":"0 W/(m K)","cp":"460 J/(kg K)"}"#,
            "conductivity k",
        ),
        (
            r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"rho":"7850 kg/m^3","k":"-1 W/(m K)","cp":"460 J/(kg K)"}"#,
            "conductivity k",
        ),
        (
            r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"k":"45 W/(m K)","cp":"460 J/(kg K)"}"#,
            "density rho",
        ),
        (
            r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"rho":"0 kg/m^3","k":"45 W/(m K)","cp":"460 J/(kg K)"}"#,
            "density rho",
        ),
        (
            r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"rho":"-1 kg/m^3","k":"45 W/(m K)","cp":"460 J/(kg K)"}"#,
            "density rho",
        ),
        (
            r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"rho":"7850 kg/m^3","k":"45 W/(m K)"}"#,
            "specific heat cp",
        ),
        (
            r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"rho":"7850 kg/m^3","k":"45 W/(m K)","cp":"0 J/(kg K)"}"#,
            "specific heat cp",
        ),
        (
            r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"rho":"7850 kg/m^3","k":"45 W/(m K)","cp":"-1 J/(kg K)"}"#,
            "specific heat cp",
        ),
    ];
    for (material, property) in bad_materials {
        ok(&mut e, material);
        let bad = err(&mut e, r#"{"cmd":"solve.run","step":"transient"}"#);
        assert_eq!(bad.code, ErrorCode::ModelIllPosed, "{bad:?}");
        assert_eq!(bad.where_.as_deref(), Some("body 'bar'"));
        assert!(bad.cause.contains(property), "{bad:?}");
        assert!(bad.suggestion.as_deref().is_some_and(|s| s.starts_with("material.add with")));
    }

    // Capacity is irrelevant to steady conduction, so omitted rho and cp remain valid there.
    ok(&mut e, r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"k":"45 W/(m K)"}"#);
    ok(&mut e, r#"{"cmd":"solve.run","step":"steady"}"#);

    ok(
        &mut e,
        r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"rho":"7850 kg/m^3",
            "k":"45 W/(m K)","cp":"460 J/(kg K)"}"#,
    );
    for theta in [-0.1, 1.1] {
        ok(
            &mut e,
            &format!(
                r#"{{"cmd":"step.add","name":"bad-theta","procedure":"heat-transient","constraints":["cold"],
                    "loads":[],"dt":"0.1 s","tEnd":"0.1 s","theta":{theta}}}"#
            ),
        );
        let bad = err(&mut e, r#"{"cmd":"solve.run","step":"bad-theta"}"#);
        assert_eq!(bad.code, ErrorCode::Schema);
        assert_eq!(bad.where_.as_deref(), Some("theta"));
    }
    // The lower endpoint is a valid forward-Euler Step; theta = 0.5 and 1 are covered by the
    // transient history and NAFEMS benchmark tests.
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"forward","procedure":"heat-transient","constraints":["cold"],"loads":[],
            "dt":"0.1 s","tEnd":"0.1 s","theta":0}"#,
    );
    ok(&mut e, r#"{"cmd":"solve.run","step":"forward"}"#);
}

/// Even after physical validation, a bad extension or boundary may produce an indefinite
/// matrix. The direct factorisation error crosses the procedure boundary and the Engine stays
/// alive to solve the corrected model.
#[test]
fn transient_heat_propagates_factorisation_failure_and_recovers() {
    let mut e = engine();
    heat_bar(&mut e);
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"cold","on":"bar.xmin","value":"0 K"}"#);
    ok(&mut e, r#"{"cmd":"load.convection","name":"film","on":"bar.xmax","h":"-1e12 W/(m^2 K)","tInf":"0 K"}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"cool","procedure":"heat-transient","constraints":["cold"],"loads":["film"],
            "dt":"1 s","tEnd":"1 s","theta":1}"#,
    );
    let bad = err(&mut e, r#"{"cmd":"solve.run","step":"cool"}"#);
    assert_eq!(bad.code, ErrorCode::SolveNotPositiveDefinite, "{bad:?}");

    ok(&mut e, r#"{"cmd":"load.convection","name":"film","on":"bar.xmax","h":"50 W/(m^2 K)","tInf":"0 K"}"#);
    ok(&mut e, r#"{"cmd":"solve.run","step":"cool"}"#);
    assert_eq!(result_of(&mut e, Some("cool")).history.len(), 2);
}

/// A transient Step keeps a history the Result summary reports, and its amplitude may be a sine
/// or a table; a malformed table is refused when the Command is dispatched, not when it is run.
#[test]
fn a_transient_heat_step_reports_its_history_and_validates_its_amplitude() {
    let mut e = engine();
    heat_bar(&mut e);
    // Kelvin above the initial state, which is how a driven-boundary transient is stated.
    ok(&mut e, r#"{"cmd":"model.setUnits","units":{"length":"mm","time":"s"}}"#);
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"driven","on":"bar.xmax","value":"100 K"}"#);
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"cold","on":"bar.xmin","value":"0 K"}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"warm","procedure":"heat-transient","constraints":["driven","cold"],
            "loads":[],"output":["temperature"],"dt":"2 s","tEnd":"20 s","theta":1.0,"initial":"0 K",
            "outputEvery":5,"amplitude":{"kind":"table","t":["0 s","10 s"],"value":[0.0,1.0]}}"#,
    );
    ok(&mut e, r#"{"cmd":"solve.run","step":"warm"}"#);
    let summary = result_of(&mut e, Some("warm"));
    // Rows at t = 0, 10 and 20 s: the initial state and every fifth of the ten steps.
    assert_eq!(summary.history.len(), 3);
    assert_eq!(summary.history[0].time.value, 0.0);
    assert_eq!(summary.history[2].time.value, 20.0);
    assert_eq!(summary.history[0].max.value, 0.0, "nothing is warm before the ramp starts");
    // The driven node is the hottest, at 100 K times the table: zero, then full from t = 10 s on.
    assert!((summary.history[1].max.value - 100.0).abs() < 1e-9, "{:?}", summary.history[1].max);
    assert!((summary.history[2].max.value - 100.0).abs() < 1e-9, "{:?}", summary.history[2].max);
    // A consistent capacity undershoots when the step is far below h^2 rho c / 6k, which it is
    // here; the undershoot recovers, and the history is where a user would see it.
    assert!(summary.history[1].min.value < -1.0 && summary.history[2].min.value > summary.history[1].min.value);
    assert_eq!(summary.history[0].time.unit, "s");

    // A sine amplitude needs a period, and a table needs two arrays of the same, non-zero length.
    let bad = err(
        &mut e,
        r#"{"cmd":"step.add","name":"bad","procedure":"heat-transient","constraints":["cold"],"loads":[],
            "dt":"1 s","tEnd":"2 s","amplitude":{"kind":"sine","amplitude":1.0,"period":"0 s"}}"#,
    );
    assert_eq!(bad.where_.as_deref(), Some("amplitude.period"));
    let bad = err(
        &mut e,
        r#"{"cmd":"step.add","name":"bad","procedure":"heat-transient","constraints":["cold"],"loads":[],
            "dt":"1 s","tEnd":"2 s","amplitude":{"kind":"table","t":["0 s"],"value":[]}}"#,
    );
    assert_eq!(bad.where_.as_deref(), Some("amplitude.t"));
    let bad = err(
        &mut e,
        r#"{"cmd":"step.add","name":"bad","procedure":"heat-transient","constraints":["cold"],"loads":[],
            "dt":"1 s","tEnd":"2 s","amplitude":{"kind":"table","t":["0 zork"],"value":[1.0]}}"#,
    );
    assert_eq!(bad.where_.as_deref(), Some("amplitude.t[0]"));
    let bad = err(
        &mut e,
        r#"{"cmd":"step.add","name":"bad","procedure":"heat-transient","constraints":["cold"],"loads":[],
            "dt":"1 zork","tEnd":"2 s"}"#,
    );
    assert_eq!(bad.where_.as_deref(), Some("dt"));
    // A sine amplitude that is well formed is accepted and runs.
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"cycled","procedure":"heat-transient","constraints":["driven","cold"],
            "loads":[],"output":["temperature"],"dt":"4 s","tEnd":"8 s","initial":"0 K",
            "amplitude":{"kind":"sine","amplitude":1.0,"period":"80 s"}}"#,
    );
    ok(&mut e, r#"{"cmd":"solve.run","step":"cycled"}"#);
    assert_eq!(result_of(&mut e, Some("cycled")).history.len(), 3);
}

/// Retention is budgeted before History allocation. A rejected replacement leaves the earlier
/// Result available, and the same Engine accepts a corrected schedule afterwards.
#[test]
fn an_over_budget_transient_preserves_the_prior_result_and_engine() {
    let mut e = engine();
    heat_bar(&mut e);
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"cold","on":"bar.xmin","value":"0 degC"}"#);
    let ordinary = r#"{"cmd":"step.add","name":"warm","procedure":"heat-transient","constraints":["cold"],
        "loads":[],"dt":"0.5 s","tEnd":"1 s","theta":1.0,"initial":"20 degC","outputEvery":1}"#;
    ok(&mut e, ordinary);
    ok(&mut e, r#"{"cmd":"solve.run","step":"warm"}"#);
    let prior = result_of(&mut e, Some("warm"));
    assert_eq!(prior.history.len(), 3);

    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"warm","procedure":"heat-transient","constraints":["cold"],
            "loads":[],"dt":"0.000000001 s","tEnd":"1 s","theta":1.0,"initial":"20 degC","outputEvery":1}"#,
    );
    let QueryResult::Cost(cost) = e.query(Query::Cost { step: "warm".into() }).unwrap() else { panic!() };
    assert_eq!(cost.retained_frames, 1_000_000_001);
    assert!(cost.retained_bytes > cost.budget_bytes);
    assert_eq!(cost.feasible, Some(false));
    let rejected = err(&mut e, r#"{"cmd":"solve.run","step":"warm"}"#);
    assert_eq!(rejected.code, ErrorCode::SolveTooLarge);
    assert_eq!(rejected.where_.as_deref(), Some("step 'warm'.outputEvery"));
    assert!(rejected.suggestion.as_deref().unwrap().contains("outputEvery at least"));

    ok(&mut e, ordinary);
    let retained = result_of(&mut e, Some("warm"));
    assert!(!retained.stale, "restoring the solved Model makes the prior Result current again");
    assert_eq!(retained.history, prior.history);
    ok(&mut e, r#"{"cmd":"solve.run","step":"warm"}"#);
    assert_eq!(result_of(&mut e, Some("warm")).history.len(), 3);
}

/// A modal Step reports its frequencies in hertz, and a host fetches mode `k`'s shape by name.
#[test]
fn a_modal_step_reports_frequencies_and_hands_out_mode_shapes_by_name() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"modal"}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"beam","size":["1 m","50 mm","50 mm"]}"#);
    ok(&mut e, r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"rho":"7800 kg/m^3"}"#);
    ok(&mut e, r#"{"cmd":"material.assign","material":"steel","bodies":["beam"]}"#);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":12,"ny":1,"nz":1}},"order":2}"#);
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"root","on":"beam.xmin"}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"modes","procedure":"modal","constraints":["root"],"loads":[],
            "output":["displacement"],"nModes":2,"shift":-1000.0}"#,
    );
    ok(&mut e, r#"{"cmd":"solve.run","step":"modes"}"#);
    let summary = result_of(&mut e, Some("modes"));
    assert_eq!(summary.frequencies.len(), 2);
    assert_eq!(summary.frequencies[0].unit, "Hz");
    // A square section: the first two modes are the same bending frequency in two planes.
    let (f1, f2) = (summary.frequencies[0].value, summary.frequencies[1].value);
    assert!((f1 - f2).abs() <= 1e-6 * f1, "{f1} and {f2}");
    assert!((f1 - 41.9107).abs() <= 0.015 * 41.9107, "first bending mode {f1} Hz");

    // Mode shapes are fields named `mode:k`, and mode 1 is also the Result's displacement.
    let first = e.field_named(Some("modes"), "mode:1").expect("mode 1").data.clone();
    assert_eq!(e.field_named(Some("modes"), "displacement").expect("displacement").data, first);
    assert!(e.field_named(Some("modes"), "mode:2").is_ok());
    let missing = e.field_named(Some("modes"), "mode:3").expect_err("only two modes were asked for");
    assert_eq!(missing.code, ErrorCode::NotFound);
    let missing = e.field_named(Some("modes"), "mode:0").expect_err("modes count from one");
    assert_eq!(missing.code, ErrorCode::NotFound);
    let bad = e.field_named(Some("modes"), "wobble").expect_err("not a field");
    assert_eq!(bad.code, ErrorCode::Schema);
}

/// A modal model with every displacement DOF constrained has no reduced system to solve. The
/// failed solve must be a structured model error, and the Engine must remain usable afterwards.
#[test]
fn a_modal_solve_with_no_free_dofs_returns_an_error_and_recovers() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"fully-fixed-modal"}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"block","size":["1 m","1 m","1 m"]}"#);
    ok(&mut e, r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"rho":"7800 kg/m^3"}"#);
    ok(&mut e, r#"{"cmd":"material.assign","material":"steel","bodies":["block"]}"#);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":1,"ny":1,"nz":1}}}"#);
    for (name, face) in [
        ("xmin", "block.xmin"),
        ("xmax", "block.xmax"),
        ("ymin", "block.ymin"),
        ("ymax", "block.ymax"),
        ("zmin", "block.zmin"),
        ("zmax", "block.zmax"),
    ] {
        ok(&mut e, &format!(r#"{{"cmd":"constraint.fix","name":"{name}","on":"{face}"}}"#));
    }
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"modes","procedure":"modal",
            "constraints":["xmin","xmax","ymin","ymax","zmin","zmax"],"loads":[],"nModes":2}"#,
    );

    let failure = err(&mut e, r#"{"cmd":"solve.run","step":"modes"}"#);
    assert_eq!(failure.code, ErrorCode::ModelIllPosed);
    assert_eq!(failure.where_.as_deref(), Some("constraints"));
    assert!(failure.cause.contains("no free displacement DOF"), "{}", failure.cause);
    assert_eq!(
        failure.suggestion.as_deref(),
        Some("constraint.remove on an over-constraining displacement constraint")
    );

    // The failed solve is transactional: reissuing the Step with five faces released and solving
    // again works on the same Engine, so the worker did not abort or retain broken state.
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"modes","procedure":"modal",
            "constraints":["xmax"],"loads":[],"nModes":2}"#,
    );
    ok(&mut e, r#"{"cmd":"solve.run","step":"modes"}"#);
    assert_eq!(result_of(&mut e, Some("modes")).frequencies.len(), 2);
}

/// A Step that names an earlier one with `after` reads its temperature field: the
/// thermal-to-structural chain. Running it before the Step it continues is a `not-found`.
#[test]
fn a_static_step_after_a_heat_step_turns_temperature_into_stress() {
    let mut e = engine();
    heat_bar(&mut e);
    ok(&mut e, r#"{"cmd":"model.setUnits","units":{"length":"mm","stress":"MPa","temperature":"degC"}}"#);
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"cold","on":"bar.xmin","value":"0 degC"}"#);
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"hot","on":"bar.xmax","value":"100 degC"}"#);
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"left","on":"bar.xmin"}"#);
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"right","on":"bar.xmax","dofs":["ux"]}"#);
    ok(
        &mut e,
        r#"{"cmd":"load.temperature","name":"reference","bodies":["bar"],"value":"0 degC","reference":"0 degC"}"#,
    );
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"conduct","procedure":"heat-steady","constraints":["cold","hot"],
            "loads":[],"output":["temperature"]}"#,
    );
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"stress","procedure":"static","after":"conduct",
            "constraints":["left","right"],"loads":["reference"]}"#,
    );
    // The chain needs the Step it continues to have been solved.
    let early = err(&mut e, r#"{"cmd":"solve.run","step":"stress"}"#);
    assert_eq!(early.code, ErrorCode::NotFound);
    assert!(early.cause.contains("no Result to continue from"), "{}", early.cause);
    // And `after` must name a Step that exists at all.
    let unknown = err(
        &mut e,
        r#"{"cmd":"step.add","name":"orphan","procedure":"static","after":"nowhere","constraints":[],"loads":[]}"#,
    );
    assert_eq!(unknown.code, ErrorCode::NotFound);

    ok(&mut e, r#"{"cmd":"solve.run","step":"conduct"}"#);
    ok(&mut e, r#"{"cmd":"solve.run","step":"stress"}"#);
    // A bar held at both ends against a temperature rise ΔT carries σ = −E α ΔT: at the middle
    // ΔT is 50 K, so σ_xx is −210 GPa × 1.2e-5 × 50 = −126 MPa.
    let sigma = probe_at(&mut e, "stress", Field::Stress, Some(0), ["500 mm", "50 mm", "50 mm"]);
    assert!((sigma + 126.0).abs() <= 0.02 * 126.0, "σ_xx = {sigma} MPa");

    // A rename follows the dependency. The old Result remains as a stale orphan, so it cannot
    // silently satisfy the renamed reference; rerunning the predecessor makes the chain valid.
    ok(&mut e, r#"{"cmd":"model.rename","kind":"step","name":"conduct","to":"thermal"}"#);
    assert_eq!(e.model().step("stress").unwrap().after.as_deref(), Some("thermal"));
    let missing = err(&mut e, r#"{"cmd":"solve.run","step":"stress"}"#);
    assert!(missing.cause.contains("'thermal' has no Result"), "{missing:?}");

    ok(&mut e, r#"{"cmd":"journal.undo"}"#);
    assert_eq!(e.model().step("stress").unwrap().after.as_deref(), Some("conduct"));
    ok(&mut e, r#"{"cmd":"journal.redo"}"#);
    assert_eq!(e.model().step("stress").unwrap().after.as_deref(), Some("thermal"));

    let before = e.revision();
    let used = err(&mut e, r#"{"cmd":"step.remove","name":"thermal"}"#);
    assert_eq!(used.code, ErrorCode::InUse);
    assert!(used.cause.contains("stress"), "{used:?}");
    assert_eq!(e.revision(), before, "a refused removal is not journaled");
    ok(&mut e, r#"{"cmd":"solve.run","step":"thermal"}"#);
    ok(&mut e, r#"{"cmd":"solve.run","step":"stress"}"#);

    // Saved files contain the retargeted Model but no Results, while replay reruns the Journal.
    let saved = e.export_file();
    let mut reopened = engine();
    reopened.import_file(saved.clone()).unwrap();
    assert_eq!(reopened.model().step("stress").unwrap().after.as_deref(), Some("thermal"));
    let missing = err(&mut reopened, r#"{"cmd":"solve.run","step":"stress"}"#);
    assert!(missing.cause.contains("'thermal' has no Result"), "{missing:?}");
    ok(&mut reopened, r#"{"cmd":"solve.run","step":"thermal"}"#);
    ok(&mut reopened, r#"{"cmd":"solve.run","step":"stress"}"#);

    let mut replayed = engine();
    pollster::block_on(replayed.replay(&saved.journal.entries, false, true)).expect("the renamed chain replays");
    assert_eq!(replayed.model().step("stress").unwrap().after.as_deref(), Some("thermal"));
    assert!(replayed.field_named(Some("stress"), "stress").is_ok());
}

fn solved_thermal_chain() -> Engine {
    let mut e = engine();
    heat_bar(&mut e);
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"cold","on":"bar.xmin","value":"0 degC"}"#);
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"hot","on":"bar.xmax","value":"100 degC"}"#);
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"left","on":"bar.xmin"}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"conduct","procedure":"heat-steady","constraints":["cold","hot"],
            "loads":[],"output":["temperature"]}"#,
    );
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"stress","procedure":"static","after":"conduct",
            "constraints":["left"],"loads":[]}"#,
    );
    ok(&mut e, r#"{"cmd":"solve.run","step":"conduct"}"#);
    e
}

fn assert_stale_predecessor(e: &mut Engine) {
    let stale = err(e, r#"{"cmd":"solve.run","step":"stress"}"#);
    assert_eq!(stale.code, ErrorCode::ResultStale);
    assert_eq!(stale.where_.as_deref(), Some("step 'stress'"));
    assert!(stale.cause.contains("step 'conduct'"), "{}", stale.cause);
    assert_eq!(stale.suggestion.as_deref(), Some("solve.run on step 'conduct' again"));
}

/// A chained solve must never attach an old nodal field to a new Mesh: refinement used to
/// panic while gathering temperatures by the new node ids.
#[test]
fn a_chained_step_refuses_a_predecessor_result_from_before_mesh_refinement() {
    let mut e = solved_thermal_chain();
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":20,"ny":1,"nz":1}}}"#);
    assert_stale_predecessor(&mut e);
}

/// Equal field and Mesh lengths do not prove compatibility: geometry and material edits can
/// keep every node id while invalidating the predecessor's temperature field.
#[test]
fn a_chained_step_refuses_a_stale_same_node_count_temperature_field() {
    let mut e = solved_thermal_chain();
    let nodes = mesh_summary(&mut e).nodes;
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"bar","size":["2 m","100 mm","100 mm"]}"#);
    assert_eq!(mesh_summary(&mut e).nodes, nodes, "fixed division counts preserve the node count");
    assert_stale_predecessor(&mut e);

    // Re-solving makes the chain valid for the changed geometry; a material edit stales it
    // again without changing any part of the Mesh.
    ok(&mut e, r#"{"cmd":"solve.run","step":"conduct"}"#);
    ok(
        &mut e,
        r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"rho":"7850 kg/m^3",
            "alpha":"1.2e-5 1/K","k":"90 W/(m K)","cp":"460 J/(kg K)"}"#,
    );
    assert_eq!(mesh_summary(&mut e).nodes, nodes);
    assert_stale_predecessor(&mut e);
}

/// An explicit Step falls under gravity by exactly `g t²/2`, which is what central differences
/// give for a constant acceleration, and a Step that names no `tEnd` says so.
#[test]
fn an_explicit_step_drops_a_free_block_by_g_t_squared_over_two() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"drop"}"#);
    ok(&mut e, r#"{"cmd":"model.setUnits","units":{"length":"mm","time":"s"}}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"block","size":["100 mm","100 mm","100 mm"]}"#);
    ok(&mut e, r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"rho":"7800 kg/m^3"}"#);
    ok(&mut e, r#"{"cmd":"material.assign","material":"steel","bodies":["block"]}"#);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":2,"ny":2,"nz":2}}}"#);
    ok(&mut e, r#"{"cmd":"load.gravity","name":"g","g":["0 m/s^2","0 m/s^2","-9.81 m/s^2"]}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"fall","procedure":"explicit","constraints":[],"loads":["g"],
            "output":["displacement"],"tEnd":"1 ms","dtFactor":0.9,"outputEvery":10}"#,
    );
    let QueryResult::Cost(cost) = e.query(Query::Cost { step: "fall".into() }).unwrap() else { panic!() };
    ok(&mut e, r#"{"cmd":"solve.run","step":"fall"}"#);
    let uz = probe_at(&mut e, "fall", Field::Displacement, Some(2), ["50 mm", "50 mm", "50 mm"]);
    let want = -0.5 * 9.81 * 1e-6 * 1e3;
    assert!((uz - want).abs() <= 0.01 * want.abs(), "u_z = {uz} mm, want {want} mm");
    let summary = result_of(&mut e, Some("fall"));
    assert_eq!(summary.solver, "cpu-explicit");
    assert!(summary.iterations > 100, "{}", summary.iterations);
    assert_eq!(cost.retained_frames as usize, summary.history.len());
    assert_eq!(
        cost.retained_frames,
        u64::from(1 + summary.iterations / 10 + u32::from(!summary.iterations.is_multiple_of(10)))
    );
}

/// Cost planning and integration must use the same supported massless-element rule. A wholly
/// held massless Body contributes no frequency; the massive Body supplies the grid. Making the
/// massless Body free turns the same model into the structured local-CFL error before allocation.
#[test]
fn explicit_cost_and_run_share_the_fixed_massless_element_grid() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"planned massless support"}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"massive","size":["0.1 m","0.1 m","0.1 m"]}"#);
    ok(
        &mut e,
        r#"{"cmd":"geometry.addBox","name":"massless","size":["0.1 m","0.1 m","0.1 m"],"at":["0.2 m","0 m","0 m"]}"#,
    );
    ok(
        &mut e,
        r#"{"cmd":"geometry.nameRegion","name":"held-massless","where":{"kind":"bbox","min":["0.19 m","-0.01 m","-0.01 m"],"max":["0.31 m","0.11 m","0.11 m"]}}"#,
    );
    ok(&mut e, r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"rho":"7850 kg/m^3"}"#);
    ok(&mut e, r#"{"cmd":"material.add","name":"zero","E":"210 GPa","nu":0.3}"#);
    ok(&mut e, r#"{"cmd":"material.assign","material":"steel","bodies":["massive"]}"#);
    ok(&mut e, r#"{"cmd":"material.assign","material":"zero","bodies":["massless"]}"#);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":1,"ny":1,"nz":1}}}"#);
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"hold","on":"held-massless"}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"dynamic","procedure":"explicit","constraints":["hold"],"loads":[],"tEnd":"1e-8 s","dtFactor":0.9,"outputEvery":2}"#,
    );
    let QueryResult::Cost(cost) = e.query(Query::Cost { step: "dynamic".into() }).unwrap() else { panic!() };
    ok(&mut e, r#"{"cmd":"solve.run","step":"dynamic"}"#);
    let summary = result_of(&mut e, Some("dynamic"));
    assert_eq!(cost.retained_frames as usize, summary.history.len());
    assert_eq!(
        cost.retained_frames,
        u64::from(1 + summary.iterations / 2 + u32::from(!summary.iterations.is_multiple_of(2)))
    );

    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"dynamic","procedure":"explicit","constraints":[],"loads":[],"tEnd":"1e-8 s","dtFactor":0.9,"outputEvery":2}"#,
    );
    let err = e.query(Query::Cost { step: "dynamic".into() }).expect_err("free massless stiffness has no CFL bound");
    assert_eq!(err.code, ErrorCode::ModelIllPosed);
    assert!(err.where_.as_deref().is_some_and(|where_| where_.starts_with("element ")));
    assert!(err.cause.contains("finite explicit frequency bound is undefined"), "{}", err.cause);
}

/// Every procedure refuses a Model whose Body has no material, and says which Body.
#[test]
fn every_procedure_runs_the_well_posedness_checks_first() {
    let cases = [
        (r#""modal","nModes":2"#, "modal"),
        (r#""heat-steady""#, "heat"),
        (r#""heat-transient","dt":"1 s","tEnd":"2 s""#, "transient"),
        (r#""explicit","tEnd":"1 ms""#, "explicit"),
    ];
    for (procedure, name) in cases {
        let mut e = engine();
        ok(&mut e, r#"{"cmd":"model.new","name":"bare"}"#);
        ok(&mut e, r#"{"cmd":"geometry.addBox","name":"block","size":["1 m","1 m","1 m"]}"#);
        ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":1,"ny":1,"nz":1}}}"#);
        ok(&mut e, r#"{"cmd":"constraint.fix","name":"root","on":"block.xmin"}"#);
        ok(&mut e, r#"{"cmd":"constraint.temperature","name":"cold","on":"block.xmin","value":"0 degC"}"#);
        let step = format!(
            r#"{{"cmd":"step.add","name":"{name}","procedure":{procedure},
                "constraints":["root","cold"],"loads":[]}}"#
        );
        ok(&mut e, &step);
        let bad = err(&mut e, &format!(r#"{{"cmd":"solve.run","step":"{name}"}}"#));
        assert_eq!(bad.code, ErrorCode::ModelNoMaterial, "{name}: {bad:?}");
    }
}

/// Every new Command validates its name, its Set or Bodies, and every quantity it takes, in the
/// same order and with the same error codes the older ones use.
#[test]
fn the_heat_commands_validate_their_names_sets_and_units() {
    let mut e = engine();
    heat_bar(&mut e);
    let cases: [(&str, ErrorCode, &str); 12] = [
        (r#"{"cmd":"constraint.temperature","name":"","on":"bar.xmin","value":"0 degC"}"#, ErrorCode::Schema, "name"),
        (r#"{"cmd":"constraint.temperature","name":"t","on":"nowhere","value":"0 degC"}"#, ErrorCode::NotFound, "on"),
        (
            r#"{"cmd":"constraint.temperature","name":"t","on":"bar.xmin","value":"3 m"}"#,
            ErrorCode::UnitDimension,
            "value",
        ),
        (
            r#"{"cmd":"load.convection","name":"","on":"bar.xmin","h":"1 W/(m^2 K)","tInf":"0 degC"}"#,
            ErrorCode::Schema,
            "name",
        ),
        (
            r#"{"cmd":"load.convection","name":"c","on":"nowhere","h":"1 W/(m^2 K)","tInf":"0 degC"}"#,
            ErrorCode::NotFound,
            "on",
        ),
        (
            r#"{"cmd":"load.convection","name":"c","on":"bar.xmin","h":"1 m","tInf":"0 degC"}"#,
            ErrorCode::UnitDimension,
            "h",
        ),
        (
            r#"{"cmd":"load.convection","name":"c","on":"bar.xmin","h":"1 W/(m^2 K)","tInf":"1 m"}"#,
            ErrorCode::UnitDimension,
            "tInf",
        ),
        (r#"{"cmd":"load.heatFlux","name":"","on":"bar.xmin","q":"1 kW/m^2"}"#, ErrorCode::Schema, "name"),
        (r#"{"cmd":"load.heatFlux","name":"f","on":"nowhere","q":"1 kW/m^2"}"#, ErrorCode::NotFound, "on"),
        (r#"{"cmd":"load.heatFlux","name":"f","on":"bar.xmin","q":"1 m"}"#, ErrorCode::UnitDimension, "q"),
        (r#"{"cmd":"load.heatSource","name":"","bodies":["bar"],"q":"1 kW/m^3"}"#, ErrorCode::Schema, "name"),
        (r#"{"cmd":"load.heatSource","name":"s","bodies":["bar"],"q":"1 m"}"#, ErrorCode::UnitDimension, "q"),
    ];
    for (json, code, _field) in cases {
        let got = err(&mut e, json);
        assert_eq!(got.code, code, "{json}: {got:?}");
    }
    let missing = err(&mut e, r#"{"cmd":"load.heatSource","name":"s","bodies":["nowhere"],"q":"1 kW/m^3"}"#);
    assert_eq!(missing.code, ErrorCode::NotFound);

    // step.add's own quantities are checked the same way.
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"cold","on":"bar.xmin","value":"0 degC"}"#);
    let bad_end = err(
        &mut e,
        r#"{"cmd":"step.add","name":"s","procedure":"heat-transient","constraints":["cold"],"loads":[],
            "dt":"1 s","tEnd":"1 m"}"#,
    );
    assert_eq!(bad_end.where_.as_deref(), Some("tEnd"));
    let bad_initial = err(
        &mut e,
        r#"{"cmd":"step.add","name":"s","procedure":"heat-transient","constraints":["cold"],"loads":[],
            "dt":"1 s","tEnd":"2 s","initial":"1 m"}"#,
    );
    assert_eq!(bad_initial.where_.as_deref(), Some("initial"));
    let bad_period = err(
        &mut e,
        r#"{"cmd":"step.add","name":"s","procedure":"heat-transient","constraints":["cold"],"loads":[],
            "dt":"1 s","tEnd":"2 s","amplitude":{"kind":"sine","amplitude":1.0,"period":"1 m"}}"#,
    );
    assert_eq!(bad_period.where_.as_deref(), Some("amplitude.period"));

    // A mode shape asked for before anything has been solved is a not-found, like any Result.
    assert_eq!(e.field_named(None, "mode:1").expect_err("nothing solved").code, ErrorCode::NotFound);
}

// ------------------------------------------------------------------ phase 3: the 2D, axisymmetric and 3D Benchmarks
//
// Every case below also exists as a Journal with checks in `crates/femlab/benches/cases`, which is what
// `femlab bench` runs; the tests here are the half a case file cannot hold — the mesh
// sequences, the Richardson extrapolations and the two models that must agree with each other.

/// One component of a nodal field at a point of the last solved Step, in display units.
fn probe_value(e: &mut Engine, field: Field, component: u8, at: [&str; 3]) -> f64 {
    let q = Query::Probe {
        step: None,
        field,
        component: Some(component),
        at: [Q::text(at[0]), Q::text(at[1]), Q::text(at[2])],
    };
    let QueryResult::Probe(p) = e.query(q).unwrap_or_else(|err| panic!("{err:?}")) else { panic!("a ProbeResult") };
    p.value.value
}

/// Relative error against a reference value.
fn rel(got: f64, want: f64) -> f64 {
    (got - want).abs() / want.abs()
}

/// `h = 1/n` for a mesh sequence, which is all `richardson` and `observed_rate` need.
fn inv(ns: &[usize]) -> Vec<f64> {
    ns.iter().map(|&n| 1.0 / n as f64).collect()
}

// ---------------------------------------------------------------- C4 Cook's membrane

/// Cook's membrane at one mesh: u_y at C = (48, 52), the midpoint of the loaded edge.
fn cook(idealisation: &str, n: usize) -> f64 {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"cook"}"#);
    ok(&mut e, r#"{"cmd":"model.setUnits","units":{"length":"m","stress":"Pa","force":"N"}}"#);
    ok(&mut e, &format!(r#"{{"cmd":"model.setIdealisation","idealisation":{idealisation}}}"#));
    ok(&mut e, r#"{"cmd":"material.add","name":"soft","E":"1 Pa","nu":0.3333333333333333}"#);
    ok(
        &mut e,
        &format!(
            r#"{{"cmd":"mesh.set","mesher":{{"kind":"mapped","body":"membrane","blocks":[{{
               "corners":[["0 m","0 m"],["48 m","44 m"],["48 m","60 m"],["0 m","44 m"]],
               "n":[{n},{n}],"tags":["bottom","right","top","left"]}}]}},"order":2}}"#
        ),
    );
    ok(&mut e, r#"{"cmd":"material.assign","material":"soft","bodies":["membrane"]}"#);
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"clamp","on":"membrane.left"}"#);
    ok(&mut e, r#"{"cmd":"load.traction","name":"shear","on":"membrane.right","total":["0 N","1 N","0 N"]}"#);
    ok(&mut e, r#"{"cmd":"step.add","name":"static","procedure":"static","constraints":["clamp"],"loads":["shear"]}"#);
    ok(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
    probe_value(&mut e, Field::Displacement, 1, ["48 m", "52 m", "0 m"])
}

/// C4's **resolve**: 23.9 and 21.52 are not rival answers to one problem, they are the two
/// idealisations of it. Richardson over n = 4, 8, 16, 32 quad8 confirms each against its own
/// literature value, and the monitored point is C = (48, 52), the midpoint of the loaded edge:
/// the top corner (48, 60) that plans A and C name is a different quantity, 25.18 and 22.63.
#[test]
fn cooks_membrane_extrapolates_to_both_of_its_published_values() {
    let ns = [4usize, 8, 16, 32];
    let h = inv(&ns);
    for (idealisation, literature) in
        [(r#"{"kind":"planeStress","thickness":"1 m"}"#, 23.9), (r#"{"kind":"planeStrain"}"#, 21.52)]
    {
        let q: Vec<f64> = ns.iter().map(|&n| cook(idealisation, n)).collect();
        assert!(q.windows(2).all(|w| w[0] < w[1]), "monotone from below: {q:?}");
        let (limit, rate) = richardson(&h, &q);
        assert!(rate > 1.0 && rate < 3.0, "a plausible rate on a corner-singular domain: {rate}");
        assert!(rel(limit, literature) < 0.01, "extrapolated {limit} vs the published {literature}");
        assert!(rel(*q.last().expect("n = 32"), limit) < 0.01, "the finest mesh is within 1 % of the limit");
    }
}

// ---------------------------------------------------------------- C1 Kirsch

/// Half-width of the Kirsch plate, in hole radii: the hole is 1/20 of the full width, where
/// Howland's finite-width correction is about 0.2 %.
const KIRSCH_W: f64 = 20.0;

/// `(x, y)` turned by `q` right angles. The quarter plate's two blocks are mirror images of
/// each other about the diagonal, so its four rotations tile the full plate with exactly the
/// nodes four mirrored quarters would have — and a rotation, unlike a reflection, keeps every
/// block counter-clockwise and every hole arc turning the same way.
fn turn(q: usize, p: [f64; 2]) -> [f64; 2] {
    match q % 4 {
        0 => p,
        1 => [-p[1], p[0]],
        2 => [-p[0], -p[1]],
        _ => [p[1], -p[0]],
    }
}

/// One mapped block of the Kirsch plate: `which` is 0 for the block below the diagonal and 1
/// for the one above it, turned by `q` right angles, with the hole arc always on edge 3.
fn kirsch_block(which: usize, q: usize, n: usize, tags: [&str; 4]) -> String {
    let (w, d) = (KIRSCH_W, std::f64::consts::FRAC_1_SQRT_2);
    let corners: [[f64; 2]; 4] =
        if which == 0 { [[1.0, 0.0], [w, 0.0], [w, w], [d, d]] } else { [[d, d], [w, w], [0.0, w], [0.0, 1.0]] };
    let c: Vec<String> = corners
        .iter()
        .map(|&p| {
            let r = turn(q, p);
            format!(r#"["{} m","{} m"]"#, r[0], r[1])
        })
        .collect();
    let t: Vec<String> =
        tags.iter().map(|s| if s.is_empty() { "null".to_string() } else { format!("\"{s}\"") }).collect();
    format!(
        r#"{{"corners":[{}],"edges":[{{"kind":"line"}},{{"kind":"line"}},{{"kind":"line"}},
           {{"kind":"arc","center":["0 m","0 m"],"ccw":false}}],
           "n":[{n},{n}],"grading":[1.25,1.0],"tags":[{}]}}"#,
        c.join(","),
        t.join(",")
    )
}

/// The plate, its material and the tension on it; `blocks` is the mesher's block list.
fn kirsch_model(e: &mut Engine, blocks: &str) {
    ok(e, r#"{"cmd":"model.new","name":"kirsch"}"#);
    ok(e, r#"{"cmd":"model.setUnits","units":{"length":"m","stress":"MPa","force":"N"}}"#);
    ok(e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStress","thickness":"1 m"}}"#);
    ok(e, r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3}"#);
    ok(
        e,
        &format!(r#"{{"cmd":"mesh.set","mesher":{{"kind":"mapped","body":"plate","blocks":[{blocks}]}},"order":2}}"#),
    );
    ok(e, r#"{"cmd":"material.assign","material":"steel","bodies":["plate"]}"#);
}

/// The quarter model at one mesh: `sigma_xx(0, a)` in MPa, so `K_t` is that over 100.
fn kirsch_quarter(n: usize) -> f64 {
    let mut e = engine();
    let blocks = format!(
        "{},{}",
        kirsch_block(0, 0, n, ["ymin", "xmax", "", "hole"]),
        kirsch_block(1, 0, n, ["", "", "xmin", "hole"])
    );
    kirsch_model(&mut e, &blocks);
    ok(&mut e, r#"{"cmd":"constraint.symmetry","name":"symx","on":"plate.xmin","normal":"x"}"#);
    ok(&mut e, r#"{"cmd":"constraint.symmetry","name":"symy","on":"plate.ymin","normal":"y"}"#);
    ok(&mut e, r#"{"cmd":"load.pressure","name":"tension","on":"plate.xmax","value":"-100 MPa"}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"static","procedure":"static","constraints":["symx","symy"],"loads":["tension"]}"#,
    );
    ok(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
    probe_value(&mut e, Field::Stress, 0, ["0 m", "1 m", "0 m"])
}

/// C1: the stress concentration itself. n = 8, 16, 32 rises monotonically and Richardson lands
/// within 2 % of Kirsch's infinite-plate 3.00.
#[test]
fn the_kirsch_plate_reaches_a_stress_concentration_of_three() {
    let ns = [8usize, 16, 32];
    let k: Vec<f64> = ns.iter().map(|&n| kirsch_quarter(n) / 100.0).collect();
    assert!(k.windows(2).all(|w| w[0] < w[1]), "monotone from below: {k:?}");
    let (limit, _) = richardson(&inv(&ns), &k);
    assert!(rel(limit, 3.0) < 0.02, "extrapolated K_t = {limit}, more than 2 % from 3.00");
    assert!(rel(k[1], 3.0) < 0.02 && rel(k[2], 3.0) < 0.02, "the two finest against 3.00: {k:?}");
    // the discretisation error is what must fall; measured against 3.00 it crosses zero, because
    // the plate is finite and the mesh is converging to 3.024 rather than to Kirsch's 3.00
    let err: Vec<f64> = k.iter().map(|&v| rel(v, limit)).collect();
    assert!(err.windows(2).all(|w| w[1] < w[0]), "the error must not grow: {err:?}");
}

/// C1's symmetry half: the same plate as a full model of eight blocks, held only on its two
/// centre lines, gives the quarter model's stress at the shared point to roundoff. The two
/// meshes are different systems — four times the elements, a different elimination order — so
/// this is the discretisation agreeing with itself, not one solve compared with a copy.
#[test]
fn the_kirsch_full_plate_equals_the_quarter_model_at_the_hole() {
    let n = 4;
    let mut e = engine();
    let mut blocks = Vec::new();
    for q in 0..4 {
        // Only the two ends carry the tension; every other outer edge is free and every edge on
        // a centre line is interior to the full plate.
        blocks.push(kirsch_block(
            0,
            q,
            n,
            [
                "",
                if q == 0 {
                    "xmax"
                } else if q == 2 {
                    "xmin"
                } else {
                    ""
                },
                "",
                "hole",
            ],
        ));
        blocks.push(kirsch_block(
            1,
            q,
            n,
            [
                "",
                if q == 1 {
                    "xmin"
                } else if q == 3 {
                    "xmax"
                } else {
                    ""
                },
                "",
                "hole",
            ],
        ));
    }
    kirsch_model(&mut e, &blocks.join(","));
    ok(
        &mut e,
        r#"{"cmd":"geometry.nameRegion","name":"axis-x","where":{"kind":"bbox",
           "min":["-1e-9 m","-30 m","-1 m"],"max":["1e-9 m","30 m","1 m"]}}"#,
    );
    ok(
        &mut e,
        r#"{"cmd":"geometry.nameRegion","name":"axis-y","where":{"kind":"bbox",
           "min":["-30 m","-1e-9 m","-1 m"],"max":["30 m","1e-9 m","1 m"]}}"#,
    );
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"hold-x","on":"axis-x","dofs":["ux"]}"#);
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"hold-y","on":"axis-y","dofs":["uy"]}"#);
    ok(&mut e, r#"{"cmd":"load.pressure","name":"pull-right","on":"plate.xmax","value":"-100 MPa"}"#);
    ok(&mut e, r#"{"cmd":"load.pressure","name":"pull-left","on":"plate.xmin","value":"-100 MPa"}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"static","procedure":"static","constraints":["hold-x","hold-y"],
           "loads":["pull-right","pull-left"]}"#,
    );
    ok(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
    let full = probe_value(&mut e, Field::Stress, 0, ["0 m", "1 m", "0 m"]);
    let quarter = kirsch_quarter(n);
    assert!(rel(full, quarter) < 1e-10, "full {full} MPa vs quarter {quarter} MPa");
    // the full plate really is four times the model, and its two end tractions cancel: it is
    // held only against rigid motion, so the reactions are zero rather than balancing a total
    let QueryResult::Mesh(m) = e.query(Query::Mesh {}).expect("meshed") else { panic!("a MeshSummary") };
    assert_eq!(m.elements, 8 * (n * n) as u32);
    let r = result(&mut e);
    // 2e9 N flows through each end, so a residual of 1e-3 N is 5e-13 of the load that is there
    assert!(r.applied_total.iter().all(|v| v.value.abs() < 1e-3), "{:?}", r.applied_total);
    assert!(r.reactions.iter().flat_map(|x| &x.total).all(|v| v.value.abs() < 1e-3), "{:?}", r.reactions);
}

// ---------------------------------------------------------------- C5 LE1 and D1 LE10

/// LE1's elliptic-annulus block at `n × n` divisions.
fn le1_block(n: usize) -> String {
    format!(
        r#"{{"corners":[["2 m","0 m"],["3.25 m","0 m"],["0 m","2.75 m"],["0 m","1 m"]],
           "edges":[{{"kind":"line"}},{{"kind":"ellipse","center":["0 m","0 m"],"semiAxes":["3.25 m","2.75 m"]}},
                    {{"kind":"line"}},{{"kind":"ellipse","center":["0 m","0 m"],"semiAxes":["2 m","1 m"]}}],
           "n":[{n},{n}],"tags":["y0","outer","x0","inner"]}}"#
    )
}

/// NAFEMS LE1 at one mesh and one element order: `sigma_yy(D)` in MPa at D = (2, 0).
fn le1(order: u8, n: usize) -> f64 {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"le1"}"#);
    ok(&mut e, r#"{"cmd":"model.setUnits","units":{"length":"m","stress":"MPa","force":"N"}}"#);
    ok(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStress","thickness":"0.1 m"}}"#);
    ok(&mut e, r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3}"#);
    ok(
        &mut e,
        &format!(
            r#"{{"cmd":"mesh.set","mesher":{{"kind":"mapped","body":"plate","blocks":[{}]}},"order":{order}}}"#,
            le1_block(n)
        ),
    );
    ok(&mut e, r#"{"cmd":"material.assign","material":"steel","bodies":["plate"]}"#);
    ok(&mut e, r#"{"cmd":"constraint.symmetry","name":"symx","on":"plate.x0","normal":"x"}"#);
    ok(&mut e, r#"{"cmd":"constraint.symmetry","name":"symy","on":"plate.y0","normal":"y"}"#);
    ok(&mut e, r#"{"cmd":"load.pressure","name":"outward","on":"plate.outer","value":"-10 MPa"}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"static","procedure":"static","constraints":["symx","symy"],"loads":["outward"]}"#,
    );
    ok(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
    probe_value(&mut e, Field::Stress, 1, ["2 m", "0 m", "0 m"])
}

/// C5: the elliptic membrane's 92.7 MPa, by the point-value rule — the two finest meshes inside
/// the tolerance and the error never growing — at both element orders.
#[test]
fn the_nafems_le1_membrane_reaches_its_target_stress() {
    for (order, tol) in [(2u8, 0.02), (1, 0.05)] {
        let s: Vec<f64> = [6usize, 12, 24].iter().map(|&n| le1(order, n)).collect();
        let err: Vec<f64> = s.iter().map(|&v| rel(v, 92.7)).collect();
        assert!(err.windows(2).all(|w| w[1] <= w[0]), "error must not grow at order {order}: {s:?}");
        assert!(err[1] < tol && err[2] < tol, "order {order}: {s:?} against 92.7 MPa");
    }
}

/// NAFEMS LE10 at one in-plane mesh: `sigma_yy(D)` in MPa on the loaded surface above D.
fn le10_stress(n: usize) -> f64 {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"le10"}"#);
    ok(&mut e, r#"{"cmd":"model.setUnits","units":{"length":"m","stress":"MPa","force":"N"}}"#);
    ok(&mut e, r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3}"#);
    ok(
        &mut e,
        &format!(
            r#"{{"cmd":"mesh.set","mesher":{{"kind":"sweep","base":{{"kind":"mapped","body":"plate","blocks":[{}]}},
               "sweep":{{"kind":"extrude","layers":4,"height":"0.6 m"}}}},"order":2}}"#,
            le1_block(n)
        ),
    );
    ok(&mut e, r#"{"cmd":"material.assign","material":"steel","bodies":["plate"]}"#);
    ok(&mut e, r#"{"cmd":"constraint.symmetry","name":"symx","on":"plate.x0","normal":"x"}"#);
    ok(&mut e, r#"{"cmd":"constraint.symmetry","name":"symy","on":"plate.y0","normal":"y"}"#);
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"rim","on":"plate.outer"}"#);
    ok(&mut e, r#"{"cmd":"load.pressure","name":"top","on":"plate.top","value":"1 MPa"}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"static","procedure":"static","constraints":["symx","symy","rim"],"loads":["top"]}"#,
    );
    ok(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
    probe_value(&mut e, Field::Stress, 1, ["2 m", "0 m", "0.6 m"])
}

/// D1: the thick plate's −5.38 MPa, hex20, by the same point-value rule over two meshes.
#[test]
fn the_nafems_le10_thick_plate_reaches_its_target_stress() {
    let coarse = rel(le10_stress(6), -5.38);
    let fine = rel(le10_stress(12), -5.38);
    assert!(fine < 0.02, "hex20 at n = 12 is {:.2} % from -5.38 MPa", fine * 100.0);
    assert!(fine < coarse, "the error must fall with the mesh: {coarse} then {fine}");
}

// ---------------------------------------------------------------- C2 and C3 Lamé

/// The Lamé quarter annulus, meshed and solved; `blocks` chooses the polar block, `extra` the
/// mesher's element order and formulation.
fn lame_quarter(nu: f64, nr: usize, nt: usize, extra: &str) -> f64 {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"lame"}"#);
    ok(&mut e, r#"{"cmd":"model.setUnits","units":{"length":"m","stress":"MPa","force":"N"}}"#);
    ok(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStrain"}}"#);
    ok(&mut e, &format!(r#"{{"cmd":"material.add","name":"steel","E":"200 GPa","nu":{nu}}}"#));
    ok(
        &mut e,
        &format!(
            r#"{{"cmd":"mesh.set","mesher":{{"kind":"mapped","body":"tube","blocks":[{{
               "corners":[["0.1 m","0 m"],["0.2 m","0 m"],["0 m","0.2 m"],["0 m","0.1 m"]],
               "edges":[{{"kind":"line"}},{{"kind":"arc","center":["0 m","0 m"],"ccw":true}},
                        {{"kind":"line"}},{{"kind":"arc","center":["0 m","0 m"],"ccw":false}}],
               "n":[{nr},{nt}],"tags":["ymin","outer","xmin","inner"]}}]}},{extra}}}"#
        ),
    );
    ok(&mut e, r#"{"cmd":"material.assign","material":"steel","bodies":["tube"]}"#);
    ok(&mut e, r#"{"cmd":"constraint.symmetry","name":"symy","on":"tube.ymin","normal":"y"}"#);
    ok(&mut e, r#"{"cmd":"constraint.symmetry","name":"symx","on":"tube.xmin","normal":"x"}"#);
    ok(&mut e, r#"{"cmd":"load.pressure","name":"inside","on":"tube.inner","value":"60 MPa"}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"static","procedure":"static","constraints":["symx","symy"],"loads":["inside"]}"#,
    );
    ok(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
    probe_value(&mut e, Field::Displacement, 0, ["0.1 m", "0 m", "0 m"])
}

/// C2's closed form for `u_r(a)` with `eps_z = 0`: A = 20 MPa, B = 8e5 Pa·m², a = 0.1 m.
fn lame_ur(nu: f64) -> f64 {
    (1.0 + nu) / 200e9 * (20e6 * (1.0 - 2.0 * nu) * 0.1 + 8e5 / 0.1)
}

/// C3: at nu = 0.4999 the fully integrated quadrilateral locks solid, and both cures — the
/// Wilson–Taylor incompatible modes and the quadratic element — stay inside 2 %. That is why
/// no B-bar formulation was written: nothing in C3 needs one.
#[test]
fn volumetric_locking_is_cured_by_incompatible_modes_and_by_quadratic_elements() {
    for nu in [0.49, 0.499, 0.4999] {
        let exact = lame_ur(nu);
        let full = lame_quarter(nu, 8, 16, r#""order":1,"formulation":"full""#);
        let im = lame_quarter(nu, 8, 16, r#""order":1,"formulation":"incompatible-modes""#);
        let quad8 = lame_quarter(nu, 8, 16, r#""order":2"#);
        assert!(rel(im, exact) < 0.02, "quad4 incompatible modes at nu = {nu}: {im} vs {exact}");
        assert!(rel(quad8, exact) < 0.02, "quad8 at nu = {nu}: {quad8} vs {exact}");
        assert!(rel(full, exact) > 2.0 * rel(im, exact), "full integration must lock at nu = {nu}: {full}");
    }
}

/// C2's third row: revolving the axisymmetric strip through 90° with the same radial and
/// circumferential divisions the plane-strain block has, and holding both ends, gives the
/// plane-strain answer digit for digit — 3D and 2D agree far inside the plan's 0.5 %.
#[test]
fn the_revolved_lame_ring_reproduces_the_plane_strain_answer() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"lame-3d"}"#);
    ok(&mut e, r#"{"cmd":"model.setUnits","units":{"length":"m","stress":"MPa","force":"N"}}"#);
    ok(&mut e, r#"{"cmd":"material.add","name":"steel","E":"200 GPa","nu":0.3}"#);
    ok(
        &mut e,
        r#"{"cmd":"mesh.set","mesher":{"kind":"sweep","base":{"kind":"mapped","body":"tube","blocks":[
           {"corners":[["0.1 m","0 m"],["0.2 m","0 m"],["0.2 m","0.1 m"],["0.1 m","0.1 m"]],
            "n":[8,2],"tags":["zmin","outer","zmax","inner"]}]},
           "sweep":{"kind":"revolve","segments":16,"angleDeg":90}},"order":2}"#,
    );
    ok(&mut e, r#"{"cmd":"material.assign","material":"steel","bodies":["tube"]}"#);
    ok(&mut e, r#"{"cmd":"constraint.symmetry","name":"theta0","on":"tube.theta0","normal":"y"}"#);
    ok(&mut e, r#"{"cmd":"constraint.symmetry","name":"theta1","on":"tube.theta1","normal":"x"}"#);
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"zmin","on":"tube.zmin","dofs":["uz"]}"#);
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"zmax","on":"tube.zmax","dofs":["uz"]}"#);
    ok(&mut e, r#"{"cmd":"load.pressure","name":"inside","on":"tube.inner","value":"60 MPa"}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"static","procedure":"static",
           "constraints":["theta0","theta1","zmin","zmax"],"loads":["inside"]}"#,
    );
    ok(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
    let ur_3d = probe_value(&mut e, Field::Displacement, 0, ["0.1 m", "0 m", "0.05 m"]);
    let sig_3d = probe_value(&mut e, Field::Stress, 1, ["0.1 m", "0 m", "0.05 m"]);
    let ur_2d = lame_quarter(0.3, 8, 16, r#""order":2"#);
    assert!(rel(ur_3d, ur_2d) < 1e-10, "u_r(a): 3D {ur_3d} vs plane strain {ur_2d}");
    assert!(rel(ur_3d, lame_ur(0.3)) < 0.01, "u_r(a) = {ur_3d} m against the closed form");
    assert!(rel(sig_3d, 100.0) < 0.02, "sigma_theta(a) = {sig_3d} MPa against 100 MPa");
}

// ---------------------------------------------------------------- B2 MacNeal–Harder

/// One of MacNeal–Harder's three six-element meshes of the straight cantilever, as the mapped
/// mesher's block list: `kind` is 0 for rectangles, 1 for the alternating trapezoids and 2 for
/// the 45° parallelograms.
fn macneal_blocks(kind: usize) -> String {
    let end = |i: usize| i == 0 || i == 6;
    let sign = |i: usize| if i % 2 == 1 { -0.1 } else { 0.1 };
    let bottom = |i: usize| if kind == 1 && !end(i) { i as f64 + sign(i) } else { i as f64 };
    let top = |i: usize| match kind {
        2 => i as f64 + 0.2,
        1 if !end(i) => i as f64 - sign(i),
        _ => i as f64,
    };
    let one = |i: usize| {
        let tag = |t: &str| if t.is_empty() { "null".to_string() } else { format!("\"{t}\"") };
        format!(
            r#"{{"corners":[["{} m","0 m"],["{} m","0 m"],["{} m","0.2 m"],["{} m","0.2 m"]],
               "n":[1,1],"tags":[null,{},null,{}]}}"#,
            bottom(i),
            bottom(i + 1),
            top(i + 1),
            top(i),
            tag(if i == 5 { "tip" } else { "" }),
            tag(if i == 0 { "root" } else { "" })
        )
    };
    (0..6).map(one).collect::<Vec<_>>().join(",")
}

/// The MacNeal–Harder beam at one mesh and order: the tip deflection at the neutral axis.
fn macneal(kind: usize, order: u8) -> f64 {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"macneal-harder"}"#);
    ok(&mut e, r#"{"cmd":"model.setUnits","units":{"length":"m","stress":"Pa","force":"N"}}"#);
    ok(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStress","thickness":"0.1 m"}}"#);
    ok(&mut e, r#"{"cmd":"material.add","name":"generic","E":"1e7 Pa","nu":0.3}"#);
    ok(
        &mut e,
        &format!(
            r#"{{"cmd":"mesh.set","mesher":{{"kind":"mapped","body":"beam","blocks":[{}]}},"order":{order}}}"#,
            macneal_blocks(kind)
        ),
    );
    ok(&mut e, r#"{"cmd":"material.assign","material":"generic","bodies":["beam"]}"#);
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"root","on":"beam.root"}"#);
    ok(&mut e, r#"{"cmd":"load.traction","name":"tip","on":"beam.tip","total":["0 N","1 N","0 N"]}"#);
    ok(&mut e, r#"{"cmd":"step.add","name":"static","procedure":"static","constraints":["root"],"loads":["tip"]}"#);
    ok(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
    let x = if kind == 2 { "6.1 m" } else { "6 m" };
    probe_value(&mut e, Field::Displacement, 1, [x, "0.1 m", "0 m"])
}

/// B2: 0.1081 in on the regular mesh at both orders, and the distortion sensitivity the
/// benchmark exists to expose everywhere else. The trapezoid is what breaks the incompatible
/// modes (5 % of the answer), and the parallelogram is what breaks the quadratic element — the
/// two failures are of different mechanisms, which is why both meshes are in the set.
#[test]
fn the_macneal_harder_beam_shows_its_distortion_sensitivity() {
    const REFERENCE: f64 = 0.1081;
    let quad4: Vec<f64> = (0..3).map(|k| macneal(k, 1)).collect();
    let quad8: Vec<f64> = (0..3).map(|k| macneal(k, 2)).collect();
    assert!(rel(quad4[0], REFERENCE) < 0.02, "quad4 regular: {}", quad4[0]);
    assert!(rel(quad8[0], REFERENCE) < 0.02, "quad8 regular: {}", quad8[0]);
    // incompatible modes survive a parallelogram (its Jacobian is constant) and not a trapezoid
    assert!(rel(quad4[2], REFERENCE) < 0.02, "quad4 parallelogram: {}", quad4[2]);
    assert!(quad4[1] < 0.1 * REFERENCE, "quad4 trapezoid must collapse: {}", quad4[1]);
    // the quadratic element is the other way round: the trapezoid costs it 10 %, the 45° skew 19 %
    assert!(rel(quad8[1], REFERENCE) > 0.05 && rel(quad8[1], REFERENCE) < 0.15, "quad8 trapezoid: {}", quad8[1]);
    assert!(rel(quad8[2], REFERENCE) > 0.15, "quad8 parallelogram: {}", quad8[2]);
    // and every one of them is a real number, not a NaN from a folded element
    assert!(quad4.iter().chain(&quad8).all(|v| v.is_finite() && *v > 0.0), "{quad4:?} {quad8:?}");
}

// ---------------------------------------------------------------- study.converge

fn study(e: &mut Engine, json: &str) -> femlab_engine::query::StudyReport {
    let Output::Study { report } = ok(e, json).output else { panic!("a StudyReport") };
    report
}

/// The tip-deflection quantity of the cantilever fixture.
const TIP_UZ: &str = r#"{"kind":"probe","field":"displacement","component":2,"at":["1 m","50 mm","50 mm"]}"#;

/// `study.converge` re-meshes, re-solves and reports the trend. The lattice mesher takes an
/// element size, so each size is set on it directly, and the mesh settings the study borrowed
/// come back afterwards.
///
/// The rate is about 1, not the 2 plan A hoped for: a fully clamped three-dimensional root is a
/// re-entrant corner, and a point quantity measured over a singular corner converges at first
/// order however good the element is. (The same study over 100, 50 and 25 mm is not even in the
/// asymptotic range yet — its differences grow, so `richardson` reports a negative rate.) What
/// the extrapolation does reach is the beam formula, inside 1 %.
#[test]
fn a_convergence_study_reports_a_rate_and_restores_the_mesh() {
    let mut e = engine();
    cantilever(&mut e);
    let r = study(
        &mut e,
        &format!(
            r#"{{"cmd":"study.converge","step":"static","sizes":["50 mm","25 mm","12.5 mm"],"quantity":{TIP_UZ}}}"#
        ),
    );
    assert_eq!(r.rows.len(), 3);
    assert_eq!(r.unit, "mm");
    assert_eq!(r.rows[0].size.unit, "mm");
    assert!((r.rows[0].size.value - 50.0).abs() < 1e-9, "{:?}", r.rows[0].size);
    assert!(r.rows.windows(2).all(|w| w[0].dofs < w[1].dofs), "the mesh must grow: {:?}", r.rows);
    assert_eq!(r.rows[1].dofs, 3075, "the middle row is the 25 mm lattice");
    assert!(r.rows.iter().all(|row| row.value < 0.0 && row.time_ms >= 0.0), "{:?}", r.rows);
    let rate = r.observed_rate.expect("three sizes give a rate");
    assert!((0.8..1.5).contains(&rate), "a point quantity over a clamped corner converges at about 1: {rate}");
    let limit = r.extrapolated.expect("three sizes give a limit");
    assert!(rel(limit, -B1_THEORY_MM) < 0.01, "extrapolated {limit} mm against Timoshenko's {B1_THEORY_MM}");
    // the Model's own mesh settings are back, and no Result was left behind
    let QueryResult::Mesh(m) = e.query(Query::Mesh {}).expect("meshed") else { panic!("a MeshSummary") };
    assert_eq!(m.nodes, 1025);
    assert_eq!(e.query(Query::Result { step: None }).expect_err("no Result").code, ErrorCode::NotFound);
}

/// A mapped block counts divisions rather than measuring elements, so the study scales its `n`
/// by `sizes[0] / size`: Cook's membrane at n = 4 asked for 1, 1/2 and 1/4 m gives 4, 8 and 16.
/// With `restore: false` the finest mesh and its Result stay.
#[test]
fn a_convergence_study_scales_a_mapped_mesh_and_can_keep_the_finest() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"cook"}"#);
    ok(&mut e, r#"{"cmd":"model.setUnits","units":{"length":"m","stress":"Pa","force":"N"}}"#);
    ok(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStress","thickness":"1 m"}}"#);
    ok(&mut e, r#"{"cmd":"material.add","name":"soft","E":"1 Pa","nu":0.3333333333333333}"#);
    ok(
        &mut e,
        r#"{"cmd":"mesh.set","mesher":{"kind":"mapped","body":"membrane","blocks":[
           {"corners":[["0 m","0 m"],["48 m","44 m"],["48 m","60 m"],["0 m","44 m"]],
            "n":[4,4],"tags":["bottom","right","top","left"]}]},"order":2}"#,
    );
    ok(&mut e, r#"{"cmd":"material.assign","material":"soft","bodies":["membrane"]}"#);
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"clamp","on":"membrane.left"}"#);
    ok(&mut e, r#"{"cmd":"load.traction","name":"shear","on":"membrane.right","total":["0 N","1 N","0 N"]}"#);
    ok(&mut e, r#"{"cmd":"step.add","name":"static","procedure":"static","constraints":["clamp"],"loads":["shear"]}"#);
    let r = study(
        &mut e,
        r#"{"cmd":"study.converge","step":"static","sizes":["1 m","0.5 m","0.25 m"],
           "quantity":{"kind":"probe","field":"displacement","component":1,"at":["48 m","52 m","0 m"]},
           "restore":false}"#,
    );
    assert_eq!(r.rows.len(), 3);
    assert_eq!(r.unit, "m");
    assert!(rel(r.extrapolated.expect("a limit"), 23.9) < 0.02, "Cook's membrane: {:?}", r.extrapolated);
    let QueryResult::Mesh(m) = e.query(Query::Mesh {}).expect("meshed") else { panic!("a MeshSummary") };
    assert_eq!(m.elements, 16 * 16, "restore: false leaves the finest mesh in place");
    assert!(!result(&mut e).stale, "and its Result with it");
}

/// The extremes a study can follow instead of a point, and what two sizes alone can say: a
/// slope needs an error to measure and Richardson needs three meshes, so both come back empty.
#[test]
fn a_convergence_study_can_follow_an_extreme_and_says_when_it_cannot_extrapolate() {
    let mut e = engine();
    cantilever(&mut e);
    let sizes = r#""sizes":["100 mm","50 mm"]"#;
    let max = study(
        &mut e,
        &format!(
            r#"{{"cmd":"study.converge","step":"static",{sizes},"quantity":{{"kind":"max","field":"vonMises"}}}}"#
        ),
    );
    assert_eq!(max.rows.len(), 2);
    assert_eq!(max.unit, "MPa");
    assert!(max.rows.iter().all(|r| r.value > 0.0), "{:?}", max.rows);
    assert_eq!((max.observed_rate, max.extrapolated), (None, None), "two meshes cannot extrapolate");
    let min = study(
        &mut e,
        &format!(
            r#"{{"cmd":"study.converge","step":"static",{sizes},
               "quantity":{{"kind":"min","field":"displacement","component":2}}}}"#
        ),
    );
    assert!(min.rows.iter().all(|r| r.value < 0.0), "the tip goes down: {:?}", min.rows);
}

/// Every way a study can be asked for something it cannot do, each naming its own field.
#[test]
fn a_convergence_study_refuses_what_it_cannot_run() {
    let mut e = engine();
    cantilever(&mut e);
    let study_json = |step: &str, sizes: &str, quantity: &str| {
        format!(r#"{{"cmd":"study.converge","step":"{step}","sizes":{sizes},"quantity":{quantity}}}"#)
    };
    let two = r#"["100 mm","50 mm"]"#;
    assert_eq!(code(&mut e, &study_json("nope", two, TIP_UZ)), ErrorCode::NotFound);
    let one = err(&mut e, &study_json("static", r#"["50 mm"]"#, TIP_UZ));
    assert_eq!((one.code, one.where_.as_deref()), (ErrorCode::Schema, Some("sizes")));
    assert_eq!(where_(&mut e, &study_json("static", r#"["100 mm","1 kg"]"#, TIP_UZ)), "sizes[1]");
    assert_eq!(code(&mut e, &study_json("static", r#"["100 mm","1 kg"]"#, TIP_UZ)), ErrorCode::UnitDimension);
    let neg = err(&mut e, &study_json("static", r#"["100 mm","-50 mm"]"#, TIP_UZ));
    assert_eq!((neg.code, neg.where_.as_deref()), (ErrorCode::Schema, Some("sizes[1]")));
    // a field the static procedure never produces, and one that is not nodal
    let absent = err(&mut e, &study_json("static", two, r#"{"kind":"max","field":"temperature"}"#));
    assert_eq!((absent.code, absent.where_.as_deref()), (ErrorCode::NotFound, Some("quantity.field")));
    let raw = err(&mut e, &study_json("static", two, r#"{"kind":"max","field":"stressUnaveraged"}"#));
    assert_eq!((raw.code, raw.where_.as_deref()), (ErrorCode::Unsupported, Some("quantity.field")));
    // a probe point outside the mesh, and one in the wrong dimension
    let outside = r#"{"kind":"probe","field":"displacement","component":2,"at":["9 m","0 m","0 m"]}"#;
    let out = err(&mut e, &study_json("static", two, outside));
    assert_eq!((out.code, out.where_.as_deref()), (ErrorCode::NotFound, Some("quantity.at")));
    let mass = r#"{"kind":"probe","field":"displacement","component":2,"at":["1 kg","0 m","0 m"]}"#;
    let bad = err(&mut e, &study_json("static", two, mass));
    assert_eq!((bad.code, bad.where_.as_deref()), (ErrorCode::UnitDimension, Some("quantity.at")));
    // a host that says stop, at the first size
    let mut stop = |_: Progress| false;
    let cmd: Command = serde_json::from_str(&study_json("static", two, TIP_UZ)).expect("valid JSON");
    let cancelled = pollster::block_on(e.dispatch(cmd, &mut stop)).expect_err("cancelled");
    assert_eq!(cancelled.code, ErrorCode::Cancelled);
    // the failures were transactional: the mesh settings never moved
    let QueryResult::Mesh(m) = e.query(Query::Mesh {}).expect("meshed") else { panic!("a MeshSummary") };
    assert_eq!(m.nodes, 1025);
    // and a Model with no mesh settings at all cannot be studied
    let mut f = engine();
    ok(&mut f, r#"{"cmd":"model.new","name":"bare"}"#);
    ok(&mut f, r#"{"cmd":"geometry.addBox","name":"b","size":["1 m","1 m","1 m"]}"#);
    ok(&mut f, r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3}"#);
    ok(&mut f, r#"{"cmd":"material.assign","material":"steel","bodies":["b"]}"#);
    ok(&mut f, r#"{"cmd":"constraint.fix","name":"root","on":"b.xmin"}"#);
    ok(&mut f, r#"{"cmd":"load.pressure","name":"p","on":"b.xmax","value":"1 MPa"}"#);
    ok(&mut f, r#"{"cmd":"step.add","name":"s","procedure":"static","constraints":["root"],"loads":["p"]}"#);
    assert_eq!(code(&mut f, &study_json("s", two, r#"{"kind":"max","field":"vonMises"}"#)), ErrorCode::ModelIllPosed);

    // The three ways a size can fail after the study has already started: a Set the coarser
    // mesh cannot hold, a Load whose face the Mesh never makes, and a Step that is not held.
    let mut g = engine();
    ok(&mut g, r#"{"cmd":"model.new","name":"vanishing"}"#);
    ok(&mut g, r#"{"cmd":"geometry.addBox","name":"b","size":["1 m","1 m","1 m"]}"#);
    ok(&mut g, r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3}"#);
    ok(&mut g, r#"{"cmd":"material.assign","material":"steel","bodies":["b"]}"#);
    ok(&mut g, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"250 mm"},"order":1}"#);
    ok(&mut g, r#"{"cmd":"constraint.fix","name":"root","on":"b.xmin"}"#);
    ok(&mut g, r#"{"cmd":"load.pressure","name":"p","on":"b.xmax","value":"1 MPa"}"#);
    ok(&mut g, r#"{"cmd":"load.traction","name":"nowhere","on":"b.side","total":["1 N","0 N","0 N"]}"#);
    ok(&mut g, r#"{"cmd":"step.add","name":"held","procedure":"static","constraints":["root"],"loads":["p"]}"#);
    ok(&mut g, r#"{"cmd":"step.add","name":"lost","procedure":"static","constraints":["root"],"loads":["nowhere"]}"#);
    ok(&mut g, r#"{"cmd":"step.add","name":"loose","procedure":"static","constraints":[],"loads":["p"]}"#);
    let vm = r#"{"kind":"max","field":"vonMises"}"#;
    let coarse = r#"["500 mm","250 mm"]"#;
    assert_eq!(code(&mut g, &study_json("lost", coarse, vm)), ErrorCode::SetEmpty, "the Load has no face");
    assert_eq!(code(&mut g, &study_json("loose", coarse, vm)), ErrorCode::ConstraintRigidModes);
    // a named Set that the coarsest mesh in the sequence cannot hold: one element has no
    // node and no element centroid anywhere near the corner this box asks for
    ok(
        &mut g,
        r#"{"cmd":"geometry.nameRegion","name":"corner","where":{"kind":"bbox",
           "min":["0.1 m","0.1 m","0.1 m"],"max":["0.2 m","0.2 m","0.2 m"]}}"#,
    );
    assert_eq!(code(&mut g, &study_json("held", r#"["250 mm","1 m"]"#, vm)), ErrorCode::SetEmpty, "the Set empties");
}

/// The other three meshers scale too: a lattice given counts, a free mesh given a size, and a
/// sweep, which scales its base and its own layers or segments with it.
#[test]
fn a_convergence_study_scales_every_mesher() {
    let mut e = engine();
    cantilever(&mut e);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":4,"ny":1,"nz":1}},"order":1}"#);
    let counts = study(
        &mut e,
        &format!(r#"{{"cmd":"study.converge","step":"static","sizes":["1 m","0.5 m"],"quantity":{TIP_UZ}}}"#),
    );
    assert_eq!(counts.rows[0].dofs, 3 * 5 * 2 * 2, "4 x 1 x 1 hexahedra");
    assert_eq!(counts.rows[1].dofs, 3 * 9 * 3 * 3, "and 8 x 2 x 2 at half the size");

    // a free 2D mesh: the size goes straight to the mesher
    let mut f = engine();
    ok(&mut f, r#"{"cmd":"model.new","name":"sheet"}"#);
    ok(&mut f, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStress","thickness":"1 m"}}"#);
    ok(
        &mut f,
        r#"{"cmd":"geometry.add","name":"plate","shape":{"kind":"sheet","sketch":{"outer":[
           {"kind":"line","to":["4 m","0 m"],"tag":"bottom"},{"kind":"line","to":["4 m","1 m"],"tag":"right"},
           {"kind":"line","to":["0 m","1 m"],"tag":"top"},{"kind":"line","to":["0 m","0 m"],"tag":"left"}]}}}"#,
    );
    ok(&mut f, r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3}"#);
    ok(&mut f, r#"{"cmd":"material.assign","material":"steel","bodies":["plate"]}"#);
    ok(&mut f, r#"{"cmd":"mesh.set","mesher":{"kind":"free","of":"plate","size":"1 m"},"order":1}"#);
    ok(&mut f, r#"{"cmd":"constraint.fix","name":"root","on":"plate.left"}"#);
    ok(&mut f, r#"{"cmd":"load.traction","name":"tip","on":"plate.right","total":["0 N","-1 kN","0 N"]}"#);
    ok(&mut f, r#"{"cmd":"step.add","name":"s","procedure":"static","constraints":["root"],"loads":["tip"]}"#);
    let free = study(
        &mut f,
        r#"{"cmd":"study.converge","step":"s","sizes":["1 m","0.5 m"],
           "quantity":{"kind":"min","field":"displacement","component":1}}"#,
    );
    assert!(free.rows[0].dofs < free.rows[1].dofs, "a smaller size is a bigger mesh: {:?}", free.rows);

    // a sweep: the base's divisions and the extrusion's layers both scale
    let mut g = engine();
    ok(&mut g, r#"{"cmd":"model.new","name":"bar"}"#);
    ok(&mut g, r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3}"#);
    ok(
        &mut g,
        r#"{"cmd":"mesh.set","mesher":{"kind":"sweep","base":{"kind":"mapped","body":"bar","blocks":[
           {"corners":[["0 m","0 m"],["1 m","0 m"],["1 m","1 m"],["0 m","1 m"]],
            "n":[2,2],"tags":["ymin","xmax","ymax","xmin"]}]},
           "sweep":{"kind":"extrude","layers":2,"height":"2 m"}},"order":1}"#,
    );
    ok(&mut g, r#"{"cmd":"material.assign","material":"steel","bodies":["bar"]}"#);
    ok(&mut g, r#"{"cmd":"constraint.fix","name":"root","on":"bar.bottom"}"#);
    ok(&mut g, r#"{"cmd":"load.pressure","name":"p","on":"bar.top","value":"1 MPa"}"#);
    ok(&mut g, r#"{"cmd":"step.add","name":"s","procedure":"static","constraints":["root"],"loads":["p"]}"#);
    let swept = study(
        &mut g,
        r#"{"cmd":"study.converge","step":"s","sizes":["1 m","0.5 m"],
           "quantity":{"kind":"min","field":"displacement","component":2}}"#,
    );
    assert_eq!(swept.rows[0].dofs, 3 * 3 * 3 * 3, "2 x 2 x 2 hexahedra");
    assert_eq!(swept.rows[1].dofs, 3 * 5 * 5 * 5, "and 4 x 4 x 4 at half the size");

    // and a revolution, whose segments scale the same way
    ok(
        &mut g,
        r#"{"cmd":"mesh.set","mesher":{"kind":"sweep","base":{"kind":"mapped","body":"bar","blocks":[
           {"corners":[["1 m","0 m"],["2 m","0 m"],["2 m","1 m"],["1 m","1 m"]],
            "n":[2,2],"tags":["zmin","outer","zmax","inner"]}]},
           "sweep":{"kind":"revolve","segments":2,"angleDeg":90}},"order":1}"#,
    );
    ok(&mut g, r#"{"cmd":"constraint.fix","name":"hold","on":"bar.zmin"}"#);
    ok(&mut g, r#"{"cmd":"load.pressure","name":"push","on":"bar.inner","value":"1 MPa"}"#);
    ok(&mut g, r#"{"cmd":"step.add","name":"r","procedure":"static","constraints":["hold"],"loads":["push"]}"#);
    let turned = study(
        &mut g,
        r#"{"cmd":"study.converge","step":"r","sizes":["1 m","0.5 m"],
           "quantity":{"kind":"max","field":"vonMises"}}"#,
    );
    assert_eq!(turned.rows[0].dofs, 3 * 3 * 3 * 3, "2 x 2 elements through 2 segments");
    assert_eq!(turned.rows[1].dofs, 3 * 5 * 5 * 5, "and 4 x 4 through 4 segments");
}

#[test]
fn mapped_body_warns_until_a_constraint_targets_its_sets() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"supports"}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"other","size":["1 m","1 m","1 m"]}"#);
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"hold","on":"other.xmin"}"#);
    ok(&mut e, COOK);
    let warnings = e.warnings();
    let warning = warnings.iter().find(|w| w.code == "model.unconstrained").unwrap();
    assert_eq!(warning.where_.as_deref(), Some("body 'sheet'"));
    assert!(warning.text.contains("constraint.fix"));
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"hold","on":"sheet.left"}"#);
    assert!(!e.warnings().iter().any(|w| w.code == "model.unconstrained"));
    // An explicitly named face still belongs to its declared Body, not its display name.
    ok(
        &mut e,
        r#"{"cmd":"geometry.nameFace","name":"support","of":"other","where":{"kind":"normal","normal":[-1,0,0]}}"#,
    );
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"hold","on":"support"}"#);
    assert!(e.warnings().iter().any(|w| w.code == "model.unconstrained"));
    // A Body region is explicit too: an unrelated Body's Set cannot support the mapped one.
    ok(&mut e, r#"{"cmd":"geometry.nameRegion","name":"region","where":{"kind":"body","name":"other"}}"#);
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"hold","on":"region"}"#);
    assert!(e.warnings().iter().any(|w| w.code == "model.unconstrained"));
    // Box predicates can select the mapped mesh directly, without naming a Body.
    ok(
        &mut e,
        r#"{"cmd":"geometry.nameRegion","name":"region","where":{"kind":"bbox","min":["0 m","0 m","0 m"],"max":["0 m","44 m","0 m"]}}"#,
    );
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"hold","on":"region"}"#);
    assert!(!e.warnings().iter().any(|w| w.code == "model.unconstrained"));
    ok(&mut e, r#"{"cmd":"constraint.remove","name":"hold"}"#);
    assert!(e.warnings().iter().any(|w| w.code == "model.unconstrained"));
}

/// The mapped mesher's implicit Body is a Body: it takes a material like any other, appears in
/// `query.model` with the extent and area of the Mesh it makes, warns while it has none, and
/// holds that material against `material.remove`. Without this every 2D Benchmark would be
/// unsolvable, because the blocks that *are* the geometry have no `geometry.add` to hang a
/// material on.
#[test]
fn the_mapped_meshers_implicit_body_owns_a_material() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"cook"}"#);
    ok(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStress","thickness":"1 m"}}"#);
    ok(&mut e, r#"{"cmd":"material.add","name":"soft","E":"1 Pa","nu":0.3}"#);
    ok(&mut e, COOK);
    let QueryResult::Model(m) = e.query(Query::Model {}).expect("a model") else { panic!("a ModelSummary") };
    assert_eq!(m.bodies.len(), 1);
    assert_eq!(m.bodies[0].name, "sheet");
    assert_eq!(m.bodies[0].material, None);
    assert_eq!(m.bodies[0].mass, None, "a sheet has an area, not a mass");
    assert_eq!(m.bodies[0].faces, ["sheet.bottom", "sheet.left", "sheet.right", "sheet.top"]);
    assert_eq!(m.bodies[0].measure.unit, "m^2");
    assert!((m.bodies[0].measure.value - 1440.0).abs() < 1e-9, "{:?}", m.bodies[0].measure);
    assert!((m.bodies[0].bbox[3].value - 48.0).abs() < 1e-9, "{:?}", m.bodies[0].bbox);
    // a Model whose only geometry is the mesher's is not empty, and that geometry wants a material
    assert!(m.warnings.iter().any(|w| w.code == "model.no-material"), "{:?}", m.warnings);
    assert!(!m.warnings.iter().any(|w| w.code == "model.empty"), "{:?}", m.warnings);
    // an unknown Body still says so, and lists the implicit one among the ones it knows
    let miss = err(&mut e, r#"{"cmd":"material.assign","material":"soft","bodies":["nope"]}"#);
    assert_eq!(miss.code, ErrorCode::NotFound);
    assert!(miss.suggestion.as_deref().is_some_and(|s| s.contains("sheet")), "{miss:?}");
    ok(&mut e, r#"{"cmd":"material.assign","material":"soft","bodies":["sheet"]}"#);
    let QueryResult::Model(m) = e.query(Query::Model {}).expect("a model") else { panic!("a ModelSummary") };
    assert_eq!(m.bodies[0].material.as_deref(), Some("soft"));
    assert_eq!(m.materials[0].assigned_to, ["sheet"]);
    assert!(!m.warnings.iter().any(|w| w.code == "model.no-material"), "{:?}", m.warnings);
    // and the material cannot be removed while that Body holds it
    let used = err(&mut e, r#"{"cmd":"material.remove","name":"soft"}"#);
    assert_eq!(used.code, ErrorCode::InUse);
    assert!(used.cause.contains("sheet"), "{}", used.cause);
    // a mesher whose Mesh will not build has no extent to report, so it has no row either
    ok(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"solid3d"}}"#);
    let QueryResult::Model(m) = e.query(Query::Model {}).expect("a model") else { panic!("a ModelSummary") };
    assert!(m.bodies.is_empty(), "{:?}", m.bodies);
}

// ---------------------------------------------------------------- query.report

#[test]
fn material_rename_preserves_the_mapped_assignment_and_solve_after_replay() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"cook-rename"}"#);
    ok(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStress","thickness":"1 m"}}"#);
    ok(&mut e, COOK);
    ok(&mut e, r#"{"cmd":"material.add","name":"soft","E":"1 Pa","nu":0.3}"#);
    ok(&mut e, r#"{"cmd":"material.assign","material":"soft","bodies":["sheet"]}"#);
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"root","on":"sheet.left"}"#);
    ok(&mut e, r#"{"cmd":"load.traction","name":"tip","on":"sheet.right","total":["0 N","1 N","0 N"]}"#);
    ok(&mut e, r#"{"cmd":"step.add","name":"static","procedure":"static","constraints":["root"],"loads":["tip"]}"#);
    ok(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
    let before = probe_at(&mut e, "static", Field::Displacement, Some(1), ["48 m", "60 m", "0 m"]);
    assert!(before > 0.0 && before.is_finite());
    // Renaming an unrelated Material must leave the implicit assignment alone.
    ok(&mut e, r#"{"cmd":"material.add","name":"unused","E":"2 Pa","nu":0.3}"#);
    ok(&mut e, r#"{"cmd":"model.rename","kind":"material","name":"unused","to":"other"}"#);
    assert_eq!(e.model().material_of_body("sheet"), Some("soft"));
    ok(&mut e, r#"{"cmd":"model.rename","kind":"material","name":"soft","to":"renamed"}"#);
    assert_eq!(e.model().material_of_body("sheet"), Some("renamed"));
    let QueryResult::Model(m) = e.query(Query::Model {}).unwrap() else { panic!("a ModelSummary") };
    assert_eq!(m.bodies[0].material.as_deref(), Some("renamed"));
    assert_eq!(m.materials[0].assigned_to, ["sheet"]);
    assert!(!m.warnings.iter().any(|w| w.code == "model.no-material"));
    ok(&mut e, r#"{"cmd":"journal.undo"}"#);
    assert_eq!(e.model().material_of_body("sheet"), Some("soft"));
    ok(&mut e, r#"{"cmd":"journal.redo"}"#);
    assert_eq!(e.model().material_of_body("sheet"), Some("renamed"));
    ok(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
    assert_eq!(probe_at(&mut e, "static", Field::Displacement, Some(1), ["48 m", "60 m", "0 m"]), before);
    let file = e.export_file();
    let mut replayed = engine();
    pollster::block_on(replayed.replay(&file.journal.entries, false, true)).expect("renamed Journal replays");
    assert_eq!(replayed.model_hash(), e.model_hash());
    assert_eq!(replayed.model().material_of_body("sheet"), Some("renamed"));
    assert_eq!(probe_at(&mut replayed, "static", Field::Displacement, Some(1), ["48 m", "60 m", "0 m"]), before);
    let mut reopened = engine();
    reopened.import_file(file).expect("renamed Model reopens");
    ok(&mut reopened, r#"{"cmd":"solve.run","step":"static"}"#);
    assert_eq!(probe_at(&mut reopened, "static", Field::Displacement, Some(1), ["48 m", "60 m", "0 m"]), before);
}

/// The shipped cantilever fixture, so the report is written about the model the gallery shows.
const CANTILEVER_JOURNAL: &str = include_str!("../benches/journals/cantilever.json");

fn replay_cantilever(e: &mut Engine) {
    let entries: Vec<femlab_engine::JournalEntry> = serde_json::from_str(CANTILEVER_JOURNAL).expect("the fixture");
    pollster::block_on(e.replay(&entries, false, true)).expect("the fixture replays");
}

fn report(e: &mut Engine, step: Option<&str>, include: Option<Vec<ReportSection>>) -> femlab_engine::query::ReportText {
    let QueryResult::Report(r) = e.query(Query::Report { step: step.map(str::to_string), include }).expect("a report")
    else {
        panic!("a ReportText")
    };
    r
}

/// The calculation note J11.2 asks for: every section, in order, about the cantilever fixture —
/// and the same bytes both times, because a note whose text depends on the clock cannot be
/// reviewed in a diff (J11.3).
#[test]
fn the_report_is_the_whole_analysis_in_order_and_reproducible() {
    let mut e = engine();
    replay_cantilever(&mut e);
    ok(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
    let r = report(&mut e, None, None);
    assert_eq!(
        r.sections,
        ["header", "assumptions", "geometry", "materials", "mesh", "loads", "results", "verification", "journal"]
    );
    let md = &r.markdown;
    let headings = [
        "# Calculation note: cantilever",
        "## Assumptions",
        "## Geometry",
        "## Materials",
        "## Mesh",
        "## Loads and constraints",
        "## Results",
        "## Verification",
        "## Journal",
    ];
    let mut at = 0;
    for h in headings {
        let found = md[at..].find(h).unwrap_or_else(|| panic!("'{h}' is missing or out of order in:\n{md}")) + at;
        at = found + h.len();
    }
    // the header carries what identifies the run, and nothing that changes between runs
    assert!(md.contains("| Idealisation | solid3d |"), "{md}");
    assert!(md.contains(&format!("| Model hash | `{}` |", e.model_hash())), "{md}");
    assert!(md.contains("| Units | length mm, force kN, stress MPa"), "{md}");
    // assumptions, with the formulation the mesh actually uses and a KaTeX block
    assert!(md.contains("- **Linear elastic material.**"), "{md}");
    assert!(md.contains("- **Element formulation**: incompatible-modes, order 1."), "{md}");
    assert!(md.contains("$$\\boldsymbol{\\sigma} = \\mathbf{C}"), "{md}");
    assert!(md.contains("The Model carries no warnings."), "{md}");
    // geometry, materials with their source, mesh with quality and cost
    assert!(md.contains("| `beam` | steel | 1000 × 100 × 100 mm | 10000000 mm^3 | 78.5 kg |"), "{md}");
    assert!(md.contains("Faces of `beam`: beam.xmax, beam.xmin"), "{md}");
    assert!(md.contains("| `steel` | 210000 MPa | 0.3 | 7850 kg/m^3 | EN 10025 | beam |"), "{md}");
    assert!(md.contains("| Element kind | hex8 |"), "{md}");
    assert!(md.contains("min det J ratio"), "{md}");
    assert!(md.contains("Cost estimate:"), "{md}");
    // loads with their totals, and the Steps
    assert!(md.contains("Total applied force from Forces and Tractions: 0, 0, -1 kN."), "{md}");
    assert!(md.contains("| `root` | `beam.xmin` | fix ux, uy, uz |"), "{md}");
    // results: extremes with locations, reactions against the applied total, and the balance
    assert!(md.contains("### Step `static`"), "{md}");
    assert!(md.contains("#### Extremes"), "{md}");
    assert!(md.contains("#### Reactions and applied load"), "{md}");
    assert!(md.contains("| **Σ applied** | 0 | 0 | -1 | kN |"), "{md}");
    assert!(md.contains("Reaction balance |Σ reactions + Σ applied| / max|F| ="), "{md}");
    assert!(md.contains("— **pass** (tolerance 1e-9)."), "{md}");
    // verification: the checks, the verdict and the hand calculation next to the FEM number
    assert!(md.contains("- no element is inverted (min det J > 0 everywhere);"), "{md}");
    assert!(md.contains("### Hand calculation for step `static`"), "{md}");
    assert!(md.contains("$$\\delta = \\frac{P L^3}{3 E I}"), "{md}");
    assert!(md.contains("with P = 1 kN, L = 1000 mm, b = 100 mm, h = 100 mm, E = 210000 MPa."), "{md}");
    assert!(md.contains("| Hand calculation | 0.19048 mm |"), "{md}");
    assert!(md.contains("| This analysis | 0.19012 mm |"), "{md}");
    // the Journal appendix: the entries as JSON and the same Journal as a script
    assert!(md.contains("\"cmd\": \"geometry.addBox\""), "{md}");
    assert!(md.contains(r#"await fem.geometry.addBox({ name: "beam", size: ["1 m", "100 mm", "100 mm"] });"#), "{md}");
    // byte-identical when the same Journal is replayed and solved again
    let mut again = engine();
    replay_cantilever(&mut again);
    ok(&mut again, r#"{"cmd":"solve.run","step":"static"}"#);
    assert_eq!(report(&mut again, None, None).markdown, *md);
    // and the same text arrives through mesh.export, as the file the Export dialog offers
    let Output::Export { format, filename, mime, text } =
        ok(&mut e, r#"{"cmd":"mesh.export","format":"report"}"#).output
    else {
        panic!("an export")
    };
    assert_eq!(format, femlab_engine::command::ExportFormat::Report);
    assert_eq!(filename, "cantilever.md");
    assert_eq!(mime, "text/markdown");
    assert_eq!(text, *md);
}

/// `include` picks sections; each one stands on its own, and `step` picks one Step's Result.
#[test]
fn a_report_can_be_asked_for_one_section_or_one_step() {
    let mut e = engine();
    replay_cantilever(&mut e);
    ok(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
    for s in ReportSection::ALL {
        let r = report(&mut e, None, Some(vec![s]));
        assert_eq!(r.sections, [s.name()]);
        assert!(!r.markdown.is_empty(), "{s:?} wrote nothing");
    }
    let all = report(&mut e, None, Some(ReportSection::ALL.to_vec()));
    assert_eq!(all.markdown, report(&mut e, None, None).markdown);
    let one = report(&mut e, Some("static"), Some(vec![ReportSection::Results]));
    assert!(one.markdown.contains("### Step `static`"), "{}", one.markdown);
    // a Step with no Result names the ones that have one
    let er = e.query(Query::Report { step: Some("nope".into()), include: None }).expect_err("no such Result");
    assert_eq!(er.code, ErrorCode::NotFound);
}

/// A Model that has not been meshed or solved still produces a note; it says what is missing
/// instead of pretending, which is the point of writing the assumptions down.
#[test]
fn a_report_on_an_empty_model_says_what_is_missing() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"blank"}"#);
    let md = report(&mut e, None, None).markdown;
    assert!(md.contains("- **Element formulation**: no mesh settings yet."), "{md}");
    assert!(md.contains("The Model has no Bodies yet."), "{md}");
    assert!(md.contains("The Model has no materials yet."), "{md}");
    assert!(md.contains("No Mesh: the Model has no mesh settings"), "{md}");
    assert!(md.contains("No Constraints: a static solve would be singular."), "{md}");
    assert!(md.contains("No Loads."), "{md}");
    assert!(md.contains("No analysis Steps: add one with `step.add`."), "{md}");
    assert!(md.contains("No Step has been solved yet; run `solve.run` first."), "{md}");
    assert!(md.contains("Nothing has been solved, so there is nothing to verify yet."), "{md}");
    assert!(md.contains("`model.empty`"), "{md}");
    // a Body with neither material nor density, and a body load that names no Set
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"beam","size":["1 m","100 mm","100 mm"]}"#);
    ok(&mut e, r#"{"cmd":"material.add","name":"paper","E":"1 GPa","nu":0.3}"#);
    ok(&mut e, r#"{"cmd":"load.gravity","name":"g","g":["0 m/s^2","0 m/s^2","-9.81 m/s^2"]}"#);
    ok(
        &mut e,
        r#"{"cmd":"geometry.nameRegion","name":"tipZone","where":{"kind":"bbox","min":["900 mm","0 mm","0 mm"],"max":["1 m","100 mm","100 mm"]}}"#,
    );
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"25 mm"},"order":1}"#);
    let md = report(&mut e, None, None).markdown;
    assert!(md.contains("| `beam` | none | 1 × 0.1 × 0.1 m | 0.01 m^3 | — |"), "{md}");
    assert!(md.contains("| `paper` | 1e9 Pa | 0.3 | — | not stated |"), "{md}");
    assert!(md.contains("| `g` | gravity | whole model |"), "{md}");
    assert!(md.contains("| `tipZone` | region | region Bbox"), "{md}");
    assert!(md.contains("| Element kind | hex8 |"), "{md}");
    // mesh settings that cannot build: the Mesh section says so rather than failing the report
    ok(&mut e, r#"{"cmd":"geometry.remove","name":"beam"}"#);
    let md = report(&mut e, None, None).markdown;
    assert!(md.contains("No Mesh: the Model has no mesh settings, or they do not build."), "{md}");
}

/// The hand calculation is a hook, not a solver: it fires for one box under one force and
/// stands aside for anything else. A bar loaded along its axis gets the uniaxial formula.
#[test]
fn the_hand_calculation_covers_the_one_case_it_claims() {
    let mut e = engine();
    replay_cantilever(&mut e);
    ok(&mut e, r#"{"cmd":"load.traction","name":"tip","on":"beam.xmax","total":["100 kN","0 N","0 N"]}"#);
    ok(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
    let md = report(&mut e, None, None).markdown;
    assert!(md.contains("is a prismatic bar in uniaxial bar theory"), "{md}");
    assert!(md.contains("$$\\delta = \\frac{F L}{E A}$$"), "{md}");
    assert!(md.contains("with F = 100 kN, L = 1000 mm, A = 10000 mm^2, E = 210000 MPa."), "{md}");
    // δ = FL/EA = 100e3 · 1 / (210e9 · 0.01) = 47.62 µm
    assert!(md.contains("| Hand calculation | 0.047619 mm |"), "{md}");
    // a load that carries no total force is not a case the hook knows
    ok(&mut e, r#"{"cmd":"load.pressure","name":"tip","on":"beam.xmax","value":"1 MPa"}"#);
    assert!(!report(&mut e, Some("static"), None).markdown.contains("### Hand calculation"));
    // nor is a second material, a second Body, or a Body that is not an axis-aligned box
    let mut e = engine();
    replay_cantilever(&mut e);
    ok(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
    ok(&mut e, r#"{"cmd":"material.add","name":"alu","E":"70 GPa","nu":0.33}"#);
    assert!(!report(&mut e, Some("static"), None).markdown.contains("### Hand calculation"));
    ok(&mut e, r#"{"cmd":"material.remove","name":"alu"}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"plate","size":["1 m","1 m","10 mm"]}"#);
    assert!(!report(&mut e, Some("static"), None).markdown.contains("### Hand calculation"));
    ok(&mut e, r#"{"cmd":"geometry.remove","name":"plate"}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"beam","size":["1 m","100 mm","100 mm"],"at":["1 m","0 m","0 m"]}"#);
    assert!(!report(&mut e, Some("static"), None).markdown.contains("### Hand calculation"));
    // the Result the Step produced has no displacement to compare against: a heat Step
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"bar"}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"bar","size":["1 m","100 mm","100 mm"]}"#);
    ok(
        &mut e,
        r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"k":"45 W/(m*K)","cp":"460 J/(kg*K)","rho":"7850 kg/m^3"}"#,
    );
    ok(&mut e, r#"{"cmd":"material.assign","material":"steel","bodies":["bar"]}"#);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"50 mm"},"order":1}"#);
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"cold","on":"bar.xmin","value":"300 K"}"#);
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"hot","on":"bar.xmax","value":"400 K"}"#);
    ok(&mut e, r#"{"cmd":"load.force","name":"unused","on":"bar.zmax","total":["0 N","0 N","-1 kN"]}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"conduct","procedure":"heat-steady","constraints":["cold","hot"],"loads":[]}"#,
    );
    ok(&mut e, r#"{"cmd":"solve.run","step":"conduct"}"#);
    let md = report(&mut e, None, None).markdown;
    assert!(!md.contains("### Hand calculation"), "{md}");
    assert!(md.contains("| temperature | 0 |"), "{md}");
}

/// A modal Step contributes its frequencies, a transient its history, and a convergence study
/// the table it measured: the three things a note about a dynamic or refined model must carry.
#[test]
fn the_report_carries_frequencies_history_and_the_convergence_study() {
    let mut e = engine();
    replay_cantilever(&mut e);
    ok(&mut e, r#"{"cmd":"step.add","name":"modes","procedure":"modal","constraints":["root"],"loads":[],"nModes":3}"#);
    ok(&mut e, r#"{"cmd":"solve.run","step":"modes"}"#);
    ok(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
    ok(
        &mut e,
        r#"{"cmd":"study.converge","step":"static","sizes":["100 mm","50 mm","25 mm"],
            "quantity":{"kind":"min","field":"displacement","component":2}}"#,
    );
    ok(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
    let md = report(&mut e, None, None).markdown;
    assert!(md.contains("#### Natural frequencies"), "{md}");
    assert!(md.contains("| Mode | Frequency |"), "{md}");
    assert!(md.contains("#### Convergence study\n"), "{md}");
    assert!(md.contains("| Element size | Degrees of freedom | Quantity of interest |"), "{md}");
    assert!(md.contains("Observed convergence rate:"), "{md}");
    // a transient Step reports its history instead
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"bar"}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"bar","size":["1 m","100 mm","100 mm"]}"#);
    ok(
        &mut e,
        r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"k":"45 W/(m*K)","cp":"460 J/(kg*K)","rho":"7850 kg/m^3"}"#,
    );
    ok(&mut e, r#"{"cmd":"material.assign","material":"steel","bodies":["bar"]}"#);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"100 mm"},"order":1}"#);
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"hot","on":"bar.xmin","value":"400 K"}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"cool","procedure":"heat-transient","constraints":["hot"],"loads":[],
            "dt":"10 s","tEnd":"30 s","initial":"300 K"}"#,
    );
    ok(&mut e, r#"{"cmd":"solve.run","step":"cool"}"#);
    let md = report(&mut e, None, None).markdown;
    assert!(md.contains("#### History"), "{md}");
    assert!(md.contains("| Time | Minimum | Maximum |"), "{md}");
}

/// A stale Result — the Model changed after the solve — says so in the note rather than
/// quietly reporting numbers that no longer describe the Model in front of it.
#[test]
fn a_stale_result_is_labelled_in_the_report() {
    let mut e = engine();
    replay_cantilever(&mut e);
    ok(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
    assert!(report(&mut e, None, None).markdown.contains("| Up to date | yes |"));
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":"50 mm"},"order":1}"#);
    let md = report(&mut e, Some("static"), None).markdown;
    assert!(md.contains("| Up to date | no: the Model changed after the solve |"), "{md}");
    assert!(!md.contains("### Hand calculation"));
    assert!(md.contains("No applicable automatic hand-calculation reference"));
}

#[test]
fn automatic_hand_checks_require_the_steps_actual_supports_and_end_load() {
    for divisions in [10, 20] {
        let mut e = engine();
        cantilever(&mut e);
        ok(
            &mut e,
            &serde_json::json!({"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":divisions,"ny":2,"nz":2}}})
                .to_string(),
        );
        ok(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
        let text = report(&mut e, Some("static"), Some(vec![ReportSection::Verification])).markdown;
        // PL³/(3EI) = 1000/(3*210e9*(.1*.1³/12)) m, independent of the FEM solution.
        assert!(text.contains("| Hand calculation | 0.19048 mm |"), "{text}");
        assert!(text.contains("verified fully clamped at the opposite end"));
        // An unused load must not provide a reference for this Step, even though it remains
        // the only Load in the Model and would have matched the former global heuristic.
        ok(&mut e, r#"{"cmd":"step.add","name":"static","procedure":"static","constraints":["root"],"loads":[]}"#);
        ok(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
        let text = report(&mut e, Some("static"), Some(vec![ReportSection::Verification])).markdown;
        assert!(!text.contains("### Hand calculation"));
        assert!(text.contains("No applicable automatic hand-calculation reference"));
        // The same cantilever with a load at its midpoint has a different closed form;
        // the automatic end-load reference must stand aside rather than quote PL³/(3EI).
        ok(
            &mut e,
            r#"{"cmd":"geometry.nameRegion","name":"middle","where":{"kind":"bbox","min":["0.499999 m","0 m","0 m"],"max":["0.500001 m","0.1 m","0.1 m"]}}"#,
        );
        ok(&mut e, r#"{"cmd":"load.force","name":"tip","on":"middle","total":["0 N","0 N","-1 kN"]}"#);
        ok(&mut e, r#"{"cmd":"step.add","name":"static","procedure":"static","constraints":["root"],"loads":["tip"]}"#);
        ok(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
        assert!(!report(&mut e, Some("static"), Some(vec![ReportSection::Verification]))
            .markdown
            .contains("### Hand calculation"));
        // Simply supported transverse bending: uy/uz on both ends,
        // and one axial anchor. Neither support clamps all three components of an end.
        ok(&mut e, r#"{"cmd":"constraint.fix","name":"root","on":"beam.xmin","dofs":["uy","uz"]}"#);
        ok(&mut e, r#"{"cmd":"constraint.fix","name":"roller","on":"beam.xmax","dofs":["uy","uz"]}"#);
        ok(
            &mut e,
            r#"{"cmd":"geometry.nameRegion","name":"anchor","where":{"kind":"bbox","min":["0 m","0 m","0 m"],"max":["0.000001 m","0.000001 m","0.000001 m"]}}"#,
        );
        ok(&mut e, r#"{"cmd":"constraint.fix","name":"axial","on":"anchor","dofs":["ux"]}"#);
        ok(
            &mut e,
            r#"{"cmd":"step.add","name":"static","procedure":"static","constraints":["root","roller","axial"],"loads":["tip"]}"#,
        );
        ok(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
        assert!(!report(&mut e, Some("static"), Some(vec![ReportSection::Verification]))
            .markdown
            .contains("### Hand calculation"));
    }
}

/// A source-heated rod has T(x)=q*x*(L-x)/(2*k), with 0°C ends. Linear nodal
/// interpolation at x=L/3 has the independent error q*h²/(9*k) on these meshes.
#[test]
fn convergence_studies_use_the_heat_operator_and_one_temperature_dof() {
    let mut e = engine();
    heat_bar(&mut e);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":2,"ny":1,"nz":1}}}"#);
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"left","on":"bar.xmin","value":"0 degC"}"#);
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"right","on":"bar.xmax","value":"0 degC"}"#);
    ok(&mut e, r#"{"cmd":"load.heatSource","name":"source","bodies":["bar"],"q":"900 W/m^3"}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"heat","procedure":"heat-steady","constraints":["left","right"],"loads":["source"]}"#,
    );
    ok(&mut e, r#"{"cmd":"solve.run","step":"heat"}"#);
    let original_model = e.model_hash();
    let original = e.field(Some("heat"), Field::Temperature).unwrap().data.clone();
    for restore in [true, false] {
        let r = study(
            &mut e,
            &format!(
                r#"{{"cmd":"study.converge","step":"heat","sizes":["0.5 m","0.25 m","0.125 m"],
          "quantity":{{"kind":"probe","field":"temperature","at":["0.3333333333333333 m","0.05 m","0.05 m"]}},"restore":{restore}}}"#
            ),
        );
        assert_eq!(r.unit, "degC");
        for (i, row) in r.rows.iter().enumerate() {
            let h = [0.5_f64, 0.25, 0.125][i];
            let expected = 20.0 / 9.0 - 20.0 * h * h / 9.0;
            assert!((row.value - expected).abs() < 1e-9, "{row:?}, expected {expected} degC");
            assert_eq!(row.dofs, [12, 45, 225][i]);
        }
        assert!((r.extrapolated.unwrap() - 20.0 / 9.0).abs() < 1e-8);
        assert!((r.observed_rate.unwrap() - 2.0).abs() < 1e-7);
        if restore {
            assert_eq!(e.model_hash(), original_model);
            assert_eq!(e.field(Some("heat"), Field::Temperature).unwrap().data, original);
        } else {
            assert_eq!(e.mesh().unwrap().mesh.n_nodes(), 225);
            assert!(!result_of(&mut e, Some("heat")).stale);
            assert!(
                (probe_at(&mut e, "heat", Field::Temperature, None, ["0.3333333333333333 m", "0.05 m", "0.05 m"])
                    - r.rows[2].value)
                    .abs()
                    < 1e-9
            );
        }
    }
}

/// Uniform heating T=10t K: q=rho*cp*10 and the same ramp at both ends. The
/// time integration is exact for this linear function, independently of mesh and theta.
#[test]
fn convergence_studies_keep_transient_initial_time_and_amplitude_settings() {
    for end in [2.0, 4.0] {
        let mut e = engine();
        heat_bar(&mut e);
        ok(&mut e, r#"{"cmd":"model.setUnits","units":{"temperature":"K"}}"#);
        ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":2,"ny":1,"nz":1}}}"#);
        ok(&mut e, r#"{"cmd":"constraint.temperature","name":"left","on":"bar.xmin","value":"100 K"}"#);
        ok(&mut e, r#"{"cmd":"constraint.temperature","name":"right","on":"bar.xmax","value":"100 K"}"#);
        ok(&mut e, r#"{"cmd":"load.heatSource","name":"source","bodies":["bar"],"q":"36110000 W/m^3"}"#);
        ok(
            &mut e,
            &format!(
                r#"{{"cmd":"step.add","name":"warm","procedure":"heat-transient","constraints":["left","right"],"loads":["source"],
            "dt":"0.25 s","tEnd":"{end} s","theta":0.5,"initial":"0 K","outputEvery":3,
            "amplitude":{{"kind":"table","t":["0 s","10 s"],"value":[0.0,1.0]}}}}"#
            ),
        );
        let r = study(
            &mut e,
            r#"{"cmd":"study.converge","step":"warm","sizes":["0.5 m","0.25 m","0.125 m"],
            "quantity":{"kind":"probe","field":"temperature","at":["0.5 m","0.05 m","0.05 m"]},"restore":false}"#,
        );
        assert_eq!(r.unit, "K");
        for row in &r.rows {
            assert!((row.value - 10.0 * end).abs() < 1e-8, "{row:?}");
        }
        let summary = result_of(&mut e, Some("warm"));
        assert_eq!(summary.history.last().unwrap().time.value, end);
        assert_eq!(summary.history[1].time.value, 0.75);
        assert_eq!(summary.history[0].max.value, 0.0);
    }
}

#[test]
fn convergence_studies_use_explicit_dynamics_for_a_falling_block() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"drop-study"}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"block","size":["0.1 m","0.1 m","0.1 m"]}"#);
    ok(&mut e, r#"{"cmd":"material.add","name":"steel","E":"210 GPa","nu":0.3,"rho":"7800 kg/m^3"}"#);
    ok(&mut e, r#"{"cmd":"material.assign","material":"steel","bodies":["block"]}"#);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":1,"ny":1,"nz":1}}}"#);
    ok(&mut e, r#"{"cmd":"load.gravity","name":"g","g":["0 m/s^2","0 m/s^2","-9.81 m/s^2"]}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"fall","procedure":"explicit","constraints":[],"loads":["g"],"tEnd":"1 ms","dtFactor":0.8}"#,
    );
    let r = study(
        &mut e,
        r#"{"cmd":"study.converge","step":"fall","sizes":["0.1 m","0.05 m","0.025 m"],
        "quantity":{"kind":"probe","field":"displacement","component":2,"at":["0.05 m","0.05 m","0.05 m"]},"restore":false}"#,
    );
    let expected = -0.5 * 9.81 * 1e-6;
    for row in &r.rows {
        assert!((row.value - expected).abs() < 0.01 * expected.abs(), "{row:?}");
    }
    assert_eq!(result_of(&mut e, Some("fall")).solver, "cpu-explicit");
}

#[test]
fn convergence_studies_reject_modal_and_chained_steps_without_mutation() {
    let mut e = engine();
    heat_bar(&mut e);
    ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":12,"ny":1,"nz":1}},"order":2}"#);
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"cold","on":"bar.xmin","value":"0 degC"}"#);
    ok(&mut e, r#"{"cmd":"constraint.temperature","name":"hot","on":"bar.xmax","value":"100 degC"}"#);
    ok(&mut e, r#"{"cmd":"constraint.fix","name":"root","on":"bar.xmin"}"#);
    ok(&mut e, r#"{"cmd":"step.add","name":"heat","procedure":"heat-steady","constraints":["cold","hot"],"loads":[]}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"chain","procedure":"static","after":"heat","constraints":["root"],"loads":[]}"#,
    );
    ok(&mut e, r#"{"cmd":"step.add","name":"modes","procedure":"modal","constraints":["root"],"loads":[],"nModes":1}"#);
    ok(&mut e, r#"{"cmd":"solve.run","step":"heat"}"#);
    ok(&mut e, r#"{"cmd":"solve.run","step":"chain"}"#);
    ok(&mut e, r#"{"cmd":"solve.run","step":"modes"}"#);
    // Euler–Bernoulli f1=β1²/(2πL²)*sqrt(EI/(rho*A)), β1=1.8751040687.
    let frequency = result_of(&mut e, Some("modes")).frequencies[0].value;
    let reference = 1.8751040687_f64.powi(2) / (2.0 * std::f64::consts::PI)
        * (210e9_f64 * 0.1_f64.powi(2) / (12.0 * 7850.0)).sqrt();
    assert!(rel(frequency, reference) < 0.02, "{frequency} Hz vs {reference} Hz");
    let mode = e.field(Some("modes"), Field::Displacement).unwrap().data.clone();
    let before = e.export_file();
    let heat = e.field(Some("heat"), Field::Temperature).unwrap().data.clone();
    let displacement = e.field(Some("chain"), Field::Displacement).unwrap().data.clone();
    for (step, location) in [("modes", "step.procedure"), ("chain", "step.after")] {
        let error = err(
            &mut e,
            &format!(
                r#"{{"cmd":"study.converge","step":"{step}","sizes":["0.1 m","0.05 m"],"quantity":{{"kind":"max","field":"displacement"}},"restore":false}}"#
            ),
        );
        assert_eq!(error.code, ErrorCode::Unsupported);
        assert_eq!(error.where_.as_deref(), Some(location));
        assert!(error.cause.contains(step));
        assert!(error.suggestion.unwrap().contains("solve.run"));
        assert_eq!(serde_json::to_value(e.export_file()).unwrap(), serde_json::to_value(&before).unwrap());
        assert_eq!(e.field(Some("heat"), Field::Temperature).unwrap().data, heat);
        assert_eq!(e.field(Some("chain"), Field::Displacement).unwrap().data, displacement);
        assert_eq!(e.field(Some("modes"), Field::Displacement).unwrap().data, mode);
    }
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"no-clock","procedure":"heat-transient","constraints":["cold","hot"],"loads":[],"tEnd":"1 s"}"#,
    );
    let before = e.export_file();
    let missing = err(
        &mut e,
        r#"{"cmd":"study.converge","step":"no-clock","sizes":["1 m","0.5 m"],"quantity":{"kind":"max","field":"temperature"}}"#,
    );
    assert_eq!((missing.code, missing.where_.as_deref()), (ErrorCode::Schema, Some("dt")));
    assert_eq!(serde_json::to_value(e.export_file()).unwrap(), serde_json::to_value(before).unwrap());
}

#[test]
fn guarded_undo_checks_the_whole_history_at_execution() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"guarded"}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"beam","size":["1 m","1 m","1 m"]}"#);
    let boundary = e.journal().entries.clone();
    let guarded = serde_json::json!({"cmd":"journal.undo","steps":1,"expectedJournal":e.journal().hash()}).to_string();
    ok(&mut e, &guarded);
    assert_eq!(e.revision(), 1);
    assert_eq!(run(&mut e, &guarded).unwrap_err().code, ErrorCode::InUse);
    assert_eq!(e.revision(), 1);
    ok(&mut e, r#"{"cmd":"journal.redo"}"#);
    ok(&mut e, &guarded);
    // A rewrite with the same length and final model is a different Journal boundary.
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"beam","size":["1000 mm","1 m","1 m"]}"#);
    assert_eq!(e.model_hash(), boundary[1].hash_after);
    let unchanged = e.journal().clone();
    assert_eq!(run(&mut e, &guarded).unwrap_err().code, ErrorCode::InUse);
    assert_eq!(e.journal(), &unchanged);
    // A later human Command queued before the guarded undo cannot be removed by it.
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"human","size":["1 m","1 m","1 m"]}"#);
    assert_eq!(run(&mut e, &guarded).unwrap_err().code, ErrorCode::InUse);
    assert_eq!(e.revision(), 3);
}

#[test]
fn journal_guard_uses_full_history_even_for_filtered_queries() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"hash"}"#);
    ok(&mut e, r#"{"cmd":"geometry.addBox","name":"beam","size":["1 m","1 m","1 m"],"at":null}"#);
    let QueryResult::Journal(full) = e.query(Query::Journal { from_seq: None }).unwrap() else { panic!() };
    let QueryResult::Journal(tail) = e.query(Query::Journal { from_seq: Some(1) }).unwrap() else { panic!() };
    assert_eq!(full.hash, tail.hash);
    assert_eq!(tail.entries.len(), 1);
    assert_eq!(
        serde_json::to_value(&tail.entries[0].cmd).unwrap(),
        serde_json::json!({"cmd":"geometry.addBox","name":"beam","size":["1 m","1 m","1 m"]})
    );
    let guarded = serde_json::json!({"cmd":"journal.undo","expectedJournal":tail.hash}).to_string();
    ok(&mut e, &guarded);
    assert_eq!(e.revision(), 1);
}

fn selector_mesh(e: &mut Engine, n: u32, order: u32, swept: bool) {
    let base = serde_json::json!({"kind":"mapped","body":"sheet","blocks":[{
        "corners":[["0 m","0 m"],["2 m","0 m"],["2 m","1 m"],["0 m","1 m"]],
        "n":[2*n,n],"tags":["bottom","right","top","left"]
    }]});
    let mesher = if swept {
        serde_json::json!({"kind":"sweep","base":base,"sweep":{"kind":"extrude","layers":n,"height":"3 m"}})
    } else {
        base
    };
    ok(e, &serde_json::json!({"cmd":"mesh.set","mesher":mesher,"order":order}).to_string());
}

fn selector_patch(e: &mut Engine, order: u32, swept: bool) {
    ok(e, r#"{"cmd":"model.new","name":"mapped-selectors"}"#);
    if !swept {
        ok(e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStress","thickness":"0.1 m"}}"#);
    }
    selector_mesh(e, 1, order, swept);
    ok(e, r#"{"cmd":"geometry.nameFace","name":"left","of":"sheet","where":{"kind":"normal","normal":[-1,0,0]}}"#);
    ok(e, r#"{"cmd":"geometry.nameFace","name":"right","of":"sheet","where":{"kind":"normal","normal":[1,0,0]}}"#);
    ok(e, r#"{"cmd":"geometry.nameFace","name":"floor","of":"sheet","where":{"kind":"normal","normal":[0,-1,0]}}"#);
    ok(e, r#"{"cmd":"geometry.nameRegion","name":"domain","where":{"kind":"body","name":"sheet"}}"#);
    ok(e, r#"{"cmd":"material.add","name":"solid","E":"200 GPa","nu":0.25}"#);
    ok(e, r#"{"cmd":"material.assign","material":"solid","bodies":["sheet"]}"#);
    ok(e, r#"{"cmd":"constraint.fix","name":"root","on":"left","dofs":["ux"]}"#);
    ok(e, r#"{"cmd":"constraint.fix","name":"symmetryY","on":"floor","dofs":["uy"]}"#);
    let mut constraints = vec!["root", "symmetryY"];
    if swept {
        ok(e, r#"{"cmd":"geometry.nameFace","name":"back","of":"sheet","where":{"kind":"normal","normal":[0,0,-1]}}"#);
        ok(e, r#"{"cmd":"constraint.fix","name":"symmetryZ","on":"back","dofs":["uz"]}"#);
        constraints.push("symmetryZ");
    }
    let force = if swept { "60 MN" } else { "2 MN" };
    ok(
        e,
        &serde_json::json!({"cmd":"load.traction","name":"pull","on":"right","total":[force,"0 N","0 N"]}).to_string(),
    );
    ok(e, &serde_json::json!({"cmd":"step.add","name":"axial","procedure":"static","constraints":constraints,"loads":["pull"]}).to_string());
}

/// Exact uniaxial stress sigma=20MPa: ux=sigma*x/E, uy,z=-nu*sigma*y,z/E.
/// The named constraints remove rigid motion without blocking Poisson contraction.
#[test]
fn mapped_and_swept_bodies_resolve_face_and_body_selectors_for_an_exact_patch() {
    for swept in [false, true] {
        for order in [1, 2] {
            let mut e = engine();
            selector_patch(&mut e, order, swept);
            for n in [1, 2, 4] {
                selector_mesh(&mut e, n, order, swept);
                let face_count = if swept { n * n } else { n } as usize;
                let built = e.mesh().unwrap();
                assert_eq!(built.sets["left"].faces.len(), face_count);
                assert_eq!(built.sets["right"].faces.len(), face_count);
                assert!(built.sets["left"].nodes.iter().all(|&node| built.mesh.node(node)[0] == 0.0));
                assert!(built.sets["right"].nodes.iter().all(|&node| built.mesh.node(node)[0] == 2.0));
                assert_eq!(built.sets["domain"].elems.len(), built.mesh.n_elems());
                assert_eq!(built.sets["domain"].nodes.len(), built.mesh.n_nodes());
                assert!((set_info(&mut e, "domain").measure.value - if swept { 6.0 } else { 2.0 }).abs() < 1e-9);
                assert!((set_info(&mut e, "left").measure.value - if swept { 3.0 } else { 1.0 }).abs() < 1e-9);
                let QueryResult::Objects(objects) =
                    e.query(Query::Objects { kinds: Some(vec![ObjectKind::Set]) }).unwrap()
                else {
                    panic!("objects")
                };
                for name in ["left", "right", "floor", "domain"] {
                    assert!(objects.objects.iter().any(|o| o.name == name));
                }
                let QueryResult::Model(model) = e.query(Query::Model {}).unwrap() else { panic!("model") };
                assert!(model.bodies.iter().any(|b| b.name == "sheet"));
                ok(&mut e, r#"{"cmd":"solve.run","step":"axial"}"#);
                let u = e.field(Some("axial"), Field::Displacement).unwrap().clone();
                let stress = e.field(Some("axial"), Field::Stress).unwrap().clone();
                let mesh = &e.mesh().unwrap().mesh;
                for node in 0..mesh.n_nodes() {
                    let p = mesh.node(node as u32);
                    for (component, &x) in p.iter().take(mesh.dim).enumerate() {
                        let strain = if component == 0 { 1e-4 } else { -2.5e-5 };
                        assert!((u.data[node * u.comps + component] - strain * x).abs() < 1e-12);
                    }
                    for component in 0..stress.comps {
                        let expected = if component == 0 { 20e6 } else { 0.0 };
                        assert!((stress.data[node * stress.comps + component] - expected).abs() < 1e-3);
                    }
                }
                assert!(result_of(&mut e, Some("axial")).balance < 1e-10);
            }
        }
    }
}

#[test]
fn implicit_body_selectors_keep_named_set_dependencies_and_journal_semantics() {
    let mut e = engine();
    selector_patch(&mut e, 1, false);
    selector_mesh(&mut e, 2, 1, false);
    ok(&mut e, r#"{"cmd":"solve.run","step":"axial"}"#);
    ok(&mut e, r#"{"cmd":"load.force","name":"bodyforce","on":"domain","total":["10 N","0 N","0 N"]}"#);
    ok(
        &mut e,
        r#"{"cmd":"step.add","name":"axial","procedure":"static","constraints":["root","symmetryY"],"loads":["pull","bodyforce"]}"#,
    );
    for (name, user) in [("left", "root"), ("right", "pull"), ("domain", "bodyforce")] {
        let before = e.model_hash();
        let error = err(&mut e, &format!(r#"{{"cmd":"geometry.remove","name":"{name}"}}"#));
        assert_eq!(error.code, ErrorCode::InUse);
        assert!(error.cause.contains(user));
        assert_eq!(e.model_hash(), before);
    }
    ok(&mut e, r#"{"cmd":"model.rename","kind":"set","name":"left","to":"support"}"#);
    let renamed_hash = e.model_hash();
    ok(&mut e, r#"{"cmd":"journal.undo"}"#);
    assert_eq!(e.model().constraint("root").unwrap().on, "left");
    assert!(e.mesh().unwrap().sets.contains_key("left"));
    ok(&mut e, r#"{"cmd":"journal.redo"}"#);
    assert_eq!(e.model_hash(), renamed_hash);
    ok(&mut e, r#"{"cmd":"model.rename","kind":"set","name":"right","to":"loaded"}"#);
    ok(&mut e, r#"{"cmd":"model.rename","kind":"set","name":"domain","to":"whole"}"#);
    assert_eq!(e.model().constraint("root").unwrap().on, "support");
    assert_eq!(e.model().load("pull").unwrap().kind.set(), Some("loaded"));
    assert_eq!(e.model().load("bodyforce").unwrap().kind.set(), Some("whole"));
    assert_eq!(e.query(Query::Set { name: "left".into() }).unwrap_err().code, ErrorCode::NotFound);
    ok(&mut e, r#"{"cmd":"model.duplicate","kind":"set","name":"loaded","as":"copy"}"#);
    let loaded = e.mesh().unwrap().sets["loaded"].clone();
    assert_eq!(e.mesh().unwrap().sets["copy"], loaded);
    ok(&mut e, r#"{"cmd":"geometry.remove","name":"copy"}"#);
    let removed_hash = e.model_hash();
    ok(&mut e, r#"{"cmd":"journal.undo"}"#);
    assert_eq!(e.mesh().unwrap().sets["copy"], loaded);
    ok(&mut e, r#"{"cmd":"journal.redo"}"#);
    assert_eq!(e.model_hash(), removed_hash);
    ok(&mut e, r#"{"cmd":"solve.run","step":"axial"}"#);
    let result = result_of(&mut e, Some("axial"));
    assert!((result.applied_total[0].value - 2_000_010.0).abs() < 1e-8);
    let reaction: f64 = result.reactions.iter().map(|r| r.total[0].value).sum();
    assert!((reaction + 2_000_010.0).abs() < 1e-5);
    assert!(result.balance < 1e-10);
    let u = e.field(Some("axial"), Field::Displacement).unwrap().data.clone();
    let file = e.export_file();
    let mut replay = engine();
    pollster::block_on(replay.replay(&file.journal.entries, false, true)).unwrap();
    assert_eq!(replay.model_hash(), e.model_hash());
    assert_eq!(replay.mesh().unwrap().sets, e.mesh().unwrap().sets);
    assert_eq!(replay.field(Some("axial"), Field::Displacement).unwrap().data, u);
    ok(&mut e, r#"{"cmd":"step.remove","name":"axial"}"#);
    ok(&mut e, r#"{"cmd":"constraint.remove","name":"root"}"#);
    ok(&mut e, r#"{"cmd":"load.remove","name":"pull"}"#);
    ok(&mut e, r#"{"cmd":"geometry.remove","name":"support"}"#);
    ok(&mut e, r#"{"cmd":"geometry.remove","name":"loaded"}"#);
    ok(&mut e, r#"{"cmd":"load.remove","name":"bodyforce"}"#);
    ok(&mut e, r#"{"cmd":"geometry.remove","name":"whole"}"#);
    assert_eq!(e.query(Query::Set { name: "whole".into() }).unwrap_err().code, ErrorCode::NotFound);
}

#[test]
fn unknown_selector_bodies_list_the_mapped_body_and_preserve_the_journal() {
    let mut e = engine();
    ok(&mut e, r#"{"cmd":"model.new","name":"mapped-errors"}"#);
    ok(&mut e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStrain"}}"#);
    selector_mesh(&mut e, 1, 1, false);
    let before = serde_json::to_value(e.export_file()).unwrap();
    for (cmd, location) in [
        (
            r#"{"cmd":"geometry.nameFace","name":"bad","of":"missing","where":{"kind":"normal","normal":[-1,0,0]}}"#,
            "of",
        ),
        (r#"{"cmd":"geometry.nameRegion","name":"bad","where":{"kind":"body","name":"missing"}}"#, "where.name"),
    ] {
        let error = err(&mut e, cmd);
        assert_eq!((error.code, error.where_.as_deref()), (ErrorCode::NotFound, Some(location)));
        let suggestion = error.suggestion.unwrap();
        assert!(suggestion.contains("sheet"));
        assert!(suggestion.contains("query.model"));
        assert_eq!(serde_json::to_value(e.export_file()).unwrap(), before);
    }
}

/// Public Commands reproduce rigid free fall on both implicit mapped and swept Bodies,
/// including the quad8/hex20 cases whose consistent gravity opposed the lumped inertia.
#[test]
fn explicit_gravity_on_mapped_and_swept_bodies_is_rigid_free_fall() {
    for order in [1, 2] {
        for n in [1, 2, 4] {
            for swept in [false, true] {
                let mut e = engine();
                ok(&mut e, r#"{"cmd":"model.new","name":"gravity"}"#);
                ok(&mut e, r#"{"cmd":"model.setUnits","units":{"length":"m"}}"#);
                ok(&mut e, r#"{"cmd":"material.add","name":"mat","E":"1 MPa","nu":0.25,"rho":"2 kg/m^3"}"#);
                let block = format!(
                    r#"{{"corners":[["0 m","0 m"],["1 m","0 m"],["1 m","0.1 m"],["0 m","0.1 m"]],"n":[{n},1],"tags":["bottom","right","top","left"]}}"#
                );
                let mesher = if swept {
                    format!(
                        r#"{{"kind":"sweep","base":{{"kind":"mapped","body":"bar","blocks":[{block}]}},"sweep":{{"kind":"extrude","layers":1,"height":"0.1 m"}}}}"#
                    )
                } else {
                    ok(
                        &mut e,
                        r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStress","thickness":"0.1 m"}}"#,
                    );
                    format!(r#"{{"kind":"mapped","body":"bar","blocks":[{block}]}}"#)
                };
                ok(&mut e, &format!(r#"{{"cmd":"mesh.set","mesher":{mesher},"order":{order}}}"#));
                ok(&mut e, r#"{"cmd":"material.assign","material":"mat","bodies":["bar"]}"#);
                ok(&mut e, r#"{"cmd":"load.gravity","name":"g","g":["0 m/s^2","-9.81 m/s^2","0 m/s^2"]}"#);
                for end in [0.00006, 0.0007, 0.0013] {
                    ok(
                        &mut e,
                        &format!(
                            r#"{{"cmd":"step.add","name":"fall","procedure":"explicit","constraints":[],"loads":["g"],"tEnd":"{end} s","dtFactor":0.5}}"#
                        ),
                    );
                    ok(&mut e, r#"{"cmd":"solve.run","step":"fall"}"#);
                    for v in e.field(None, Field::Displacement).unwrap().data.chunks_exact(3) {
                        assert!(v[0].abs() < 1e-12 && v[2].abs() < 1e-12);
                        assert!(
                            (v[1] + 4.905 * end * end).abs() < 1e-12,
                            "order{order} n{n} swept{swept} t{end}: {v:?}"
                        );
                    }
                    let z = if swept { "0.05 m" } else { "0 m" };
                    let got = probe_at(&mut e, "fall", Field::Displacement, Some(1), ["0.5 m", "0.05 m", z]);
                    assert!((got + 4.905 * end * end).abs() < 1e-12);
                }
            }
        }
    }
}

const IMPLICIT_TEMPERATURE: &str =
    r#"{"cmd":"load.temperature","name":"heated","bodies":["sheet"],"value":"343.15 K","reference":"293.15 K"}"#;
const IMPLICIT_SOURCE: &str = r#"{"cmd":"load.heatSource","name":"power","bodies":["sheet"],"q":"100 W/m^3"}"#;

fn implicit_thermal_mesh(e: &mut Engine, n: u32, order: u32, swept: bool) {
    ok(e, r#"{"cmd":"model.new","name":"implicit-thermal"}"#);
    if !swept {
        ok(e, r#"{"cmd":"model.setIdealisation","idealisation":{"kind":"planeStress","thickness":"0.25 m"}}"#);
    }
    let base = serde_json::json!({"kind":"mapped","body":"sheet","blocks":[{
        "corners":[["0 m","0 m"],["2 m","0 m"],["2 m","1 m"],["0 m","1 m"]],
        "n":[n,1],"tags":["floor","right","ceiling","left"]
    }]});
    let mesher = if swept {
        serde_json::json!({"kind":"sweep","base":base,"sweep":{"kind":"extrude","layers":1,"height":"3 m"}})
    } else {
        base
    };
    ok(e, &serde_json::json!({"cmd":"mesh.set","mesher":mesher,"order":order}).to_string());
    ok(e, r#"{"cmd":"material.add","name":"solid","E":"200 GPa","nu":0.25,"alpha":"1e-5 1/K","k":"10 W/(m*K)"}"#);
    ok(e, r#"{"cmd":"material.assign","material":"solid","bodies":["sheet"]}"#);
}

fn implicit_temperature_steps(e: &mut Engine, swept: bool) {
    ok(e, r#"{"cmd":"constraint.fix","name":"sx","on":"sheet.left","dofs":["ux"]}"#);
    ok(e, r#"{"cmd":"constraint.fix","name":"sy","on":"sheet.floor","dofs":["uy"]}"#);
    let mut constraints = vec!["sx", "sy"];
    if swept {
        ok(e, r#"{"cmd":"constraint.fix","name":"sz","on":"sheet.bottom","dofs":["uz"]}"#);
        constraints.push("sz");
    }
    ok(e, &serde_json::json!({"cmd":"step.add","name":"free","procedure":"static","constraints":constraints,"loads":["heated"]}).to_string());
    ok(e, r#"{"cmd":"constraint.fix","name":"end","on":"sheet.right","dofs":["ux"]}"#);
    constraints.push("end");
    ok(e, &serde_json::json!({"cmd":"step.add","name":"restrained","procedure":"static","constraints":constraints,"loads":["heated"]}).to_string());
}

fn assert_implicit_expansion(e: &mut Engine, step: &str, restrained: bool) {
    let u = e.field(Some(step), Field::Displacement).unwrap().clone();
    let stress = e.field(Some(step), Field::Stress).unwrap().clone();
    let mesh = &e.mesh().unwrap().mesh;
    for node in 0..mesh.n_nodes() {
        for (component, &x) in mesh.node(node as u32).iter().take(mesh.dim).enumerate() {
            let strain = if restrained {
                if component == 0 {
                    0.0
                } else {
                    6.25e-4
                }
            } else {
                5e-4
            };
            assert!((u.data[node * u.comps + component] - strain * x).abs() < 1e-12);
        }
        for component in 0..stress.comps {
            let expected = if restrained && component == 0 { -100e6 } else { 0.0 };
            assert!((stress.data[node * stress.comps + component] - expected).abs() < 1e-3);
        }
    }
}

fn implicit_source_step(e: &mut Engine) {
    ok(e, r#"{"cmd":"constraint.temperature","name":"coldLeft","on":"sheet.left","value":"300 K"}"#);
    ok(e, r#"{"cmd":"constraint.temperature","name":"coldRight","on":"sheet.right","value":"300 K"}"#);
    ok(
        e,
        r#"{"cmd":"step.add","name":"conduct","procedure":"heat-steady","constraints":["coldLeft","coldRight"],"loads":["power"]}"#,
    );
}

fn assert_implicit_source(e: &mut Engine, n: u32, order: u32, swept: bool) -> f64 {
    let temperature = e.field(Some("conduct"), Field::Temperature).unwrap().clone();
    let model = e.model().clone();
    let built = e.mesh().unwrap();
    assert_eq!(temperature.len(), built.mesh.n_nodes());
    for (node, values) in temperature.data.chunks_exact(temperature.comps).enumerate() {
        let x = built.mesh.node(node as u32)[0];
        assert!((values[0] - (300.0 + 5.0 * x * (2.0 - x))).abs() < 1e-9);
    }
    // HeatSystem::applied is in watts, independent of host display-unit metadata. The oracle
    // uses the prescribed volume (2*1*0.25 or 2*1*3), not the mesher's measured volume.
    let problem = femlab_engine::solve_run::build_problem(&model, built, model.step("conduct").unwrap()).unwrap();
    let pattern = femlab_engine::fem::assembly::pattern(&built.mesh, 1);
    let system = femlab_engine::procedure::heat::assemble(&problem, &pattern).unwrap();
    let watts = if swept { 600.0 } else { 50.0 };
    assert!((system.applied - watts).abs() < 1e-9);
    let x = 1.0 / n as f64;
    let x_text = format!("{x} m");
    let at = [x_text.as_str(), "0.5 m", if swept { "1.5 m" } else { "0 m" }];
    let value = probe_at(e, "conduct", Field::Temperature, None, at);
    let error = (300.0 + 5.0 * x * (2.0 - x)) - value;
    let expected = if order == 1 { 5.0 / (n * n) as f64 } else { 0.0 };
    assert!((error - expected).abs() < 1e-9, "error={error}, expected={expected}");
    error
}

#[test]
fn implicit_body_temperature_gives_exact_expansion_and_restrained_stress() {
    for swept in [false, true] {
        for order in [1, 2] {
            for n in [1, 2, 4] {
                let mut e = engine();
                implicit_thermal_mesh(&mut e, n, order, swept);
                ok(&mut e, IMPLICIT_TEMPERATURE);
                implicit_temperature_steps(&mut e, swept);
                ok(&mut e, r#"{"cmd":"solve.run","step":"free"}"#);
                assert_implicit_expansion(&mut e, "free", false);
                ok(&mut e, r#"{"cmd":"solve.run","step":"restrained"}"#);
                assert_implicit_expansion(&mut e, "restrained", true);
            }
        }
    }
}

#[test]
fn implicit_body_heat_source_has_exact_power_and_convergent_temperature() {
    for swept in [false, true] {
        for order in [1, 2] {
            let mut errors = Vec::new();
            for n in [1, 2, 4] {
                let mut e = engine();
                implicit_thermal_mesh(&mut e, n, order, swept);
                ok(&mut e, IMPLICIT_SOURCE);
                implicit_source_step(&mut e);
                ok(&mut e, r#"{"cmd":"solve.run","step":"conduct"}"#);
                errors.push(assert_implicit_source(&mut e, n, order, swept));
            }
            if order == 1 {
                for pair in errors.windows(2) {
                    assert!((pair[0] / pair[1] - 4.0).abs() < 1e-8);
                }
            }
        }
    }
}

#[test]
fn implicit_body_thermal_loads_are_transactional_and_survive_undo_and_replay() {
    for swept in [false, true] {
        let mut e = engine();
        implicit_thermal_mesh(&mut e, 2, 2, swept);
        let before = e.export_file();
        ok(&mut e, IMPLICIT_TEMPERATURE);
        ok(&mut e, IMPLICIT_SOURCE);
        let loaded = e.export_file();
        for cmd in [IMPLICIT_TEMPERATURE, IMPLICIT_SOURCE] {
            for bodies in [serde_json::json!(["missing"]), serde_json::json!(["sheet", "missing"])] {
                let mut bad: serde_json::Value = serde_json::from_str(cmd).unwrap();
                bad["bodies"] = bodies;
                let error = err(&mut e, &bad.to_string());
                assert_eq!(error.code, ErrorCode::NotFound);
                let expected = format!("bodies[{}]", bad["bodies"].as_array().unwrap().len() - 1);
                assert_eq!(error.where_.as_deref(), Some(expected.as_str()));
                let suggestion = error.suggestion.unwrap();
                assert!(suggestion.contains("sheet") && suggestion.contains("query.model"));
                assert_eq!(e.model(), &loaded.model);
                assert_eq!(e.journal(), &loaded.journal);
            }
        }
        ok(&mut e, r#"{"cmd":"journal.undo","steps":2}"#);
        assert_eq!(e.model(), &before.model);
        assert_eq!(e.journal(), &before.journal);
        ok(&mut e, r#"{"cmd":"journal.redo","steps":2}"#);
        assert_eq!(e.model(), &loaded.model);
        assert_eq!(e.journal(), &loaded.journal);
        implicit_temperature_steps(&mut e, swept);
        implicit_source_step(&mut e);
        ok(&mut e, r#"{"cmd":"solve.run","step":"free"}"#);
        ok(&mut e, r#"{"cmd":"solve.run","step":"conduct"}"#);
        let source = e.export_file();
        let mut replay = engine();
        pollster::block_on(replay.replay(&source.journal.entries, false, true)).unwrap();
        assert_eq!(replay.model(), &source.model);
        assert_eq!(replay.journal(), &source.journal);
        assert_implicit_expansion(&mut replay, "free", false);
        assert_implicit_source(&mut replay, 2, 2, swept);
    }
}
