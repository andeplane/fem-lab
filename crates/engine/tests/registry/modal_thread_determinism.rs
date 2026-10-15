//! #640: the actual FV52-sized sparse inverse solve must keep its arithmetic at 1/2/4 workers.
use super::*;
use serde_json::{json, Value};

#[test]
fn full_hex20_modal_results_and_all_retained_shapes_are_exact_at_one_two_four_threads() {
    // Preserve the admitted #639 counterexample, including its ten requested modes and
    // four bottom-edge UZ supports. This is a determinism oracle, not a choice between
    // the conflicting published FV52 reference tables tracked by #7.
    let commands: Vec<Value> =
        serde_json::from_str(include_str!("../fixtures/modal-fv52-thread-counterexample.json")).unwrap();
    let mut queries = vec![
        json!({"query":"query.document"}),
        json!({"query":"query.mesh"}),
        json!({"query":"query.result","step":"modes"}),
        json!({"query":"query.surface","resultId":"result-1"}),
    ];
    for name in ["x0", "x10", "y0", "y10"] {
        queries.push(json!({"query":"query.set","name":name}));
    }
    for mode in 1..=10 {
        queries.push(json!({"query":"query.field","resultId":"result-1","field":format!("mode:{mode}")}));
    }
    let mut expected = None;
    for threads in [1, 2, 4] {
        let mut e = Engine::new(None, Box::new(NoClock), threads);
        for command in &commands {
            ok(&mut e, &command.to_string());
        }
        let mut actual = Vec::new();
        for query in &queries {
            let query = serde_json::from_value(query.clone()).unwrap();
            actual.push(serde_json::to_value(e.query(query).unwrap()).unwrap());
        }
        // The full Hex20 grid has corner nodes and the three families of edge midpoints:
        // 17*17*5 + 16*17*5 + 17*16*5 + 17*17*4 = 5321, with 16*16*4 elements.
        assert_eq!(actual[1]["nodes"], 5321);
        assert_eq!(actual[1]["elements"], 1024);
        assert_eq!(actual[1]["dofs"], 15963);
        assert_eq!(actual[1]["elementKind"], "hex20");
        let result = &actual[2];
        assert_eq!(result["resultId"], "result-1");
        assert_eq!(result["modeCount"], 10);
        assert_eq!(result["stale"], false);
        assert_eq!(result["timeMs"], 0.0); // NoClock makes the entire DTO an exact oracle.
        let residual = result["residual"].as_f64().unwrap();
        assert!(residual > 0.0 && residual <= 1e-10);
        assert!(result["iterations"].as_u64().unwrap() > 1);
        let frequencies = result["frequencies"].as_array().unwrap();
        assert_eq!(frequencies.len(), 10);
        let first_elastic = frequencies[3]["value"].as_f64().unwrap();
        assert!(first_elastic > 0.0);
        for frequency in &frequencies[..3] {
            assert!(frequency["value"].as_f64().unwrap() < 1e-4 * first_elastic);
        }
        for set in &actual[4..8] {
            assert_eq!(set["count"], 33); // Sixteen quadratic segments on each supported edge.
        }
        for (mode, field) in actual[8..].iter().enumerate() {
            assert_eq!(field["field"], format!("mode:{}", mode + 1));
            assert_eq!(field["entityCount"], 5321);
            assert_eq!(field["components"], 3);
            assert_eq!(field["unit"], "m");
            let values = field["values"].as_array().unwrap();
            assert_eq!(values.len(), 3 * 5321);
            assert!(values.iter().all(|v| v.as_f64().unwrap().is_finite()));
            assert!(values.iter().any(|v| v.as_f64().unwrap() != 0.0));
        }
        // Lossless canonical JSON also distinguishes -0.0 from +0.0, unlike Value equality.
        let serialized = serde_json::to_string(&actual).unwrap();
        if let Some(ref previous) = expected {
            assert!(&serialized == previous, "all eighteen public payloads must be exact at threads={threads}");
        }
        expected = Some(serialized);
    }
}
