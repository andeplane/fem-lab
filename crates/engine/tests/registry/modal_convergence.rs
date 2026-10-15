//! #633: actual modal convergence controls must gate Result publication.
use super::*;
use serde_json::{json, Value};

fn read(e: &mut Engine, value: Value) -> Value {
    serde_json::to_value(e.query(serde_json::from_value(value).unwrap()).unwrap()).unwrap()
}

#[test]
fn modal_sweep_budget_rejects_unconverged_pairs_without_publishing_a_result() {
    let mut expected = None;
    for threads in [1, 4] {
        let mut e = Engine::new(None, Box::new(NoClock), threads);
        cantilever(&mut e);
        ok(&mut e, r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":4,"ny":2,"nz":2}},"order":1}"#);
        ok(
            &mut e,
            r#"{"cmd":"step.add","name":"modes","procedure":"modal","constraints":["root"],"loads":[],"nModes":2}"#,
        );
        ok(&mut e, r#"{"cmd":"solve.run","step":"static"}"#);
        let file = e.export_file();
        let catalogue = read(&mut e, json!({"query":"query.results"}));
        let previous = read(&mut e, json!({"query":"query.result","resultId":"result-1"}));
        let previous_field = read(&mut e, json!({"query":"query.field","resultId":"result-1","field":"displacement"}));
        let failure = run(&mut e, r#"{"cmd":"solve.run","step":"modes","tolerance":1e-10,"maxIterations":1}"#)
            .expect_err("one genuine subspace sweep cannot converge this beam's bending pairs");
        assert_eq!(failure.code, ErrorCode::SolveStalled);
        assert!(failure.cause.contains("residual"));
        assert!(failure.suggestion.unwrap().contains("solve.run"));
        assert_eq!(e.export_file(), file);
        assert_eq!(read(&mut e, json!({"query":"query.results"})), catalogue);
        assert_eq!(read(&mut e, json!({"query":"query.result","resultId":"result-1"})), previous);
        assert_eq!(
            read(&mut e, json!({"query":"query.field","resultId":"result-1","field":"displacement"})),
            previous_field
        );
        ok(&mut e, r#"{"cmd":"solve.run","step":"modes","tolerance":1e-10,"maxIterations":5000}"#);
        let result = read(&mut e, json!({"query":"query.result","step":"modes"}));
        assert_eq!(result["resultId"], "result-2");
        let residual = result["residual"].as_f64().unwrap();
        assert!(residual > 0.0 && residual <= 1e-10, "actual backward residual: {residual}");
        assert!(result["iterations"].as_u64().unwrap() > 1);
        let shape = read(&mut e, json!({"query":"query.field","resultId":"result-2","field":"mode:1"}));
        let observed = (result, shape);
        if let Some(ref previous) = expected {
            assert_eq!(
                &observed, previous,
                "the actual spectrum, residual and retained shape are thread deterministic"
            );
        }
        expected = Some(observed);
    }
}

#[test]
fn modal_rejects_invalid_public_controls_before_publication() {
    let mut e = engine();
    cantilever(&mut e);
    ok(&mut e, r#"{"cmd":"step.add","name":"modes","procedure":"modal","constraints":["root"],"loads":[],"nModes":2}"#);
    let file = e.export_file();
    let catalogue = read(&mut e, json!({"query":"query.results"}));
    for controls in [json!({"tolerance":0.0}), json!({"tolerance":-1.0}), json!({"maxIterations":0})] {
        let mut cmd = json!({"cmd":"solve.run","step":"modes"});
        cmd.as_object_mut().unwrap().extend(controls.as_object().unwrap().clone());
        let failure = run(&mut e, &cmd.to_string()).unwrap_err();
        assert_eq!(failure.code, ErrorCode::Schema);
        assert!(failure.suggestion.unwrap().contains("solve.run"));
        assert_eq!(e.export_file(), file);
        assert_eq!(read(&mut e, json!({"query":"query.results"})), catalogue);
    }
}
