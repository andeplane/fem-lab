use femlab_engine::replacement::{Candidate, ModelFileEncoder};
use femlab_engine::session::{ExecutionContext, WriteRequest};
use femlab_engine::session_owner::{RunLease, SessionOwner};
use femlab_engine::{Command, ErrorCode, NoClock, Progress};

struct JsonEncoder;
impl ModelFileEncoder for JsonEncoder {
    fn encode(&mut self, file: &femlab_engine::ModelFile) -> Result<String, femlab_engine::Error> {
        let mut text = serde_json::to_string_pretty(file).unwrap();
        text.push('\n');
        Ok(text)
    }
}

struct CountEncoder {
    calls: usize,
}
impl ModelFileEncoder for CountEncoder {
    fn encode(&mut self, file: &femlab_engine::ModelFile) -> Result<String, femlab_engine::Error> {
        self.calls += 1;
        JsonEncoder.encode(file)
    }
}
struct FailedEncoder;
impl ModelFileEncoder for FailedEncoder {
    fn encode(&mut self, _: &femlab_engine::ModelFile) -> Result<String, femlab_engine::Error> {
        Err(femlab_engine::Error::schema("injected encoder failure").at("file"))
    }
}

fn proceed(_: Progress) -> bool {
    true
}
fn command(text: &str) -> Command {
    serde_json::from_str(text).unwrap()
}
const NEW: &str = r#"{"cmd":"model.new","name":"replacement"}"#;
const ADD: &str = r#"{"cmd":"geometry.addBox","name":"shared","size":["1 m","1 m","1 m"]}"#;
const BAD: &str = r#"{"cmd":"geometry.remove","name":"missing"}"#;
fn setup() -> (SessionOwner, RunLease) {
    let mut owner = SessionOwner::new(None, Box::new(NoClock), 1, "runtime".into()).unwrap();
    let mut lease = owner.begin_run(&owner.stamp().session).unwrap();
    let reply = pollster::block_on(owner.dispatch(
        WriteRequest {
            context: context(&lease, "1"),
            expected_version: lease.stamp.state_version.clone(),
            command: command(ADD),
        },
        &mut proceed,
    ))
    .unwrap();
    lease.stamp = reply.stamp;
    (owner, lease)
}
fn context(lease: &RunLease, op: &str) -> ExecutionContext {
    ExecutionContext { session: lease.stamp.session.clone(), run_id: lease.run_id.clone(), operation_id: op.into() }
}

#[test]
fn actual_prepared_utf8_file_is_checked_once_at_under_equal_and_over_limits() {
    for margin in [-1_isize, 0, 1] {
        let (mut owner, mut lease) = setup();
        let reply = pollster::block_on(
            owner.dispatch(
                WriteRequest {
                    context: context(&lease, "2"),
                    expected_version: lease.stamp.state_version.clone(),
                    command: serde_json::from_value(serde_json::json!({
                        "cmd": "model.setName", "name": "quote \" slash \\ snow ☃ rocket 🚀"
                    }))
                    .unwrap(),
                },
                &mut proceed,
            ),
        )
        .unwrap();
        lease.stamp = reply.stamp;
        let reply = pollster::block_on(owner.dispatch(
            WriteRequest {
                context: context(&lease, "3"),
                expected_version: lease.stamp.state_version.clone(),
                command: command(r#"{"cmd":"material.add","name":"large_modulus","E":"1e20 Pa","nu":0.3}"#),
            },
            &mut proceed,
        ))
        .unwrap();
        lease.stamp = reply.stamp;
        let before = owner.snapshot(&context(&lease, "read")).unwrap();
        let actual_text = JsonEncoder.encode(&before.file).unwrap();
        assert!(actual_text.len() > actual_text.chars().count());
        assert!(actual_text.ends_with('\n'));
        let max_bytes = actual_text.len().checked_add_signed(margin).unwrap();
        let ticket = owner.begin_replacement(context(&lease, "4"), lease.stamp.state_version.clone()).unwrap();
        let candidate =
            pollster::block_on(Candidate::new(ticket.clone(), None, Box::new(NoClock), 1).file(before.file.clone()))
                .unwrap();
        let mut encoder = CountEncoder { calls: 0 };
        let finished = candidate.finish(&mut encoder, max_bytes);
        assert_eq!(encoder.calls, 1);
        if margin < 0 {
            let error = finished.err().unwrap();
            assert_eq!(error.code, ErrorCode::Schema);
            assert_eq!(error.where_, Some("file".into()));
            assert_eq!(owner.snapshot(&context(&lease, "read")).unwrap().file, before.file);
            owner.abandon_replacement(&ticket).unwrap();
            let reply = pollster::block_on(owner.dispatch(
                WriteRequest {
                    context: context(&lease, "5"),
                    expected_version: lease.stamp.state_version.clone(),
                    command: command(r#"{"cmd":"geometry.addBox","name":"still-active","size":["1 m","1 m","1 m"]}"#),
                },
                &mut proceed,
            ))
            .unwrap();
            assert_eq!(reply.ack.revision, before.model.revision + 1);
        } else {
            let prepared = finished.unwrap();
            assert_eq!(prepared.file_bytes(), actual_text.as_bytes());
            let reopened: femlab_engine::ModelFile = serde_json::from_slice(prepared.file_bytes()).unwrap();
            assert_eq!(reopened, before.file);
            let published = owner.commit_replacement(prepared).unwrap();
            lease.stamp = published.stamp;
            let ticket = owner.begin_replacement(context(&lease, "5"), lease.stamp.state_version.clone()).unwrap();
            let replayed = pollster::block_on(Candidate::new(ticket, None, Box::new(NoClock), 1).file(reopened))
                .unwrap()
                .finish(&mut JsonEncoder, max_bytes)
                .unwrap();
            assert_eq!(replayed.file_bytes(), actual_text.as_bytes());
            assert_eq!(owner.commit_replacement(replayed).unwrap().file, before.file);
        }
    }
}

#[test]
fn encoder_failure_never_produces_a_publication_or_io_payload_and_preserves_owner() {
    let (mut owner, lease) = setup();
    let before = owner.snapshot(&context(&lease, "read")).unwrap();
    let ticket = owner.begin_replacement(context(&lease, "2"), lease.stamp.state_version.clone()).unwrap();
    let candidate = pollster::block_on(
        Candidate::new(ticket.clone(), None, Box::new(NoClock), 1).commands(vec![command(NEW)], &mut proceed),
    )
    .unwrap();
    let mut fake_io_calls = 0;
    let result = candidate.finish(&mut FailedEncoder, 16 * 1024 * 1024).map(|prepared| {
        fake_io_calls += 1;
        prepared.file_bytes().to_vec()
    });
    assert_eq!(result.unwrap_err().cause, "injected encoder failure");
    assert_eq!(fake_io_calls, 0);
    assert_eq!(owner.snapshot(&context(&lease, "read")).unwrap().file, before.file);
    assert_eq!(owner.snapshot(&context(&lease, "read")).unwrap().stamp, before.stamp);
    owner.abandon_replacement(&ticket).unwrap();
    assert_eq!(owner.snapshot(&context(&lease, "read")).unwrap().journal.entries, before.journal.entries);
}

#[test]
fn commands_under_the_input_budget_can_produce_an_oversized_real_model_file() {
    const LIMIT: usize = 16 * 1024 * 1024;
    let (mut owner, lease) = setup();
    let before = owner.snapshot(&context(&lease, "read")).unwrap();
    let ticket = owner.begin_replacement(context(&lease, "2"), lease.stamp.state_version.clone()).unwrap();
    // Each name appears in both the real Model and its replayable Journal, without padding
    // or a synthetic estimator. Unicode and JSON escaping also differ from character count.
    let commands: Vec<Command> = serde_json::from_value(serde_json::json!([{
        "cmd": "model.new", "name": format!("☃🚀\"\\{}", "x".repeat(LIMIT / 2))
    }]))
    .unwrap();
    assert!(serde_json::to_vec(&commands).unwrap().len() < LIMIT);
    let candidate =
        pollster::block_on(Candidate::new(ticket.clone(), None, Box::new(NoClock), 1).commands(commands, &mut proceed))
            .unwrap();
    let mut fake_io_calls = 0;
    let error = candidate
        .finish(&mut JsonEncoder, LIMIT)
        .map(|prepared| {
            fake_io_calls += 1;
            prepared.file_bytes().to_vec()
        })
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Schema);
    assert_eq!(error.where_, Some("file".into()));
    assert!(error.cause.contains("16777216-byte host limit"));
    assert_eq!(fake_io_calls, 0);
    assert_eq!(owner.snapshot(&context(&lease, "read")).unwrap().file, before.file);
    owner.abandon_replacement(&ticket).unwrap();
    assert_eq!(owner.snapshot(&context(&lease, "read")).unwrap().stamp, before.stamp);
}

#[test]
fn partial_replay_failure_drops_candidate_and_preserves_active_engine() {
    let (mut owner, lease) = setup();
    let before = owner.snapshot(&context(&lease, "read")).unwrap();
    let ticket = owner.begin_replacement(context(&lease, "2"), lease.stamp.state_version.clone()).unwrap();
    let error = pollster::block_on(
        Candidate::new(ticket.clone(), None, Box::new(NoClock), 1)
            .commands(vec![command(NEW), command(ADD), command(BAD)], &mut proceed),
    )
    .err()
    .unwrap();
    assert_eq!(error.code, ErrorCode::NotFound);
    // Old reads remain coherent during preparation, and new writes cannot enter it.
    assert_eq!(owner.snapshot(&context(&lease, "read")).unwrap().file, before.file);
    let error = pollster::block_on(owner.dispatch(
        WriteRequest {
            context: context(&lease, "3"),
            expected_version: lease.stamp.state_version.clone(),
            command: command(BAD),
        },
        &mut proceed,
    ))
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::SessionTransitioning);
    assert_eq!(
        owner.begin_replacement(context(&lease, "4"), lease.stamp.state_version.clone()).unwrap_err().code,
        ErrorCode::SessionTransitioning
    );
    owner.abandon_replacement(&ticket).unwrap();
    assert_eq!(owner.snapshot(&context(&lease, "read")).unwrap().stamp, before.stamp);
    assert_eq!(owner.abandon_replacement(&ticket).unwrap_err().code, ErrorCode::SessionConflict);
}

#[test]
fn activation_publishes_only_the_prepared_snapshot_and_revokes_other_runs() {
    let (mut owner, lease) = setup();
    let old = owner.begin_run(&owner.stamp().session).unwrap();
    let ticket = owner.begin_replacement(context(&lease, "2"), lease.stamp.state_version.clone()).unwrap();
    let candidate = pollster::block_on(
        Candidate::new(ticket, None, Box::new(NoClock), 1).commands(vec![command(NEW)], &mut proceed),
    )
    .unwrap()
    .finish(&mut JsonEncoder, usize::MAX)
    .unwrap();
    let published = candidate.snapshot().clone();
    let snapshot = owner.commit_replacement(candidate).unwrap();
    assert_eq!(snapshot.file, published.file);
    assert_eq!(snapshot.stamp, published.stamp);
    assert_eq!(snapshot.file.model.name, "replacement");
    assert!(snapshot.file.model.bodies.is_empty());
    assert_eq!(owner.snapshot(&context(&old, "read")).unwrap_err().code, ErrorCode::SessionExpired);
    let mut advanced = lease;
    advanced.stamp = snapshot.stamp;
    assert_eq!(owner.snapshot(&context(&advanced, "read")).unwrap().file, snapshot.file);
    let stale = owner.begin_replacement(context(&advanced, "3"), Default::default()).unwrap_err();
    assert_eq!(stale.code, ErrorCode::SessionConflict);
    let repeated = owner.begin_replacement(context(&advanced, "2"), advanced.stamp.state_version.clone()).unwrap_err();
    assert_eq!(repeated.code, ErrorCode::OperationUnknown);
}

#[test]
fn abandoned_cancelled_and_forged_candidates_cannot_commit_later() {
    for mode in ["abandon", "cancel", "forge"] {
        let (mut owner, lease) = setup();
        let before = owner.snapshot(&context(&lease, "read")).unwrap();
        let ticket = owner.begin_replacement(context(&lease, "2"), lease.stamp.state_version.clone()).unwrap();
        let mut wire = serde_json::to_value(&ticket).unwrap();
        if mode == "forge" {
            wire["target"]["session"]["sessionId"] = "forged".into();
        }
        let copy = serde_json::from_value(wire).unwrap();
        let candidate = pollster::block_on(
            Candidate::new(copy, None, Box::new(NoClock), 1).commands(vec![command(NEW)], &mut proceed),
        )
        .unwrap()
        .finish(&mut JsonEncoder, usize::MAX)
        .unwrap();
        if mode == "abandon" {
            owner.abandon_replacement(&ticket).unwrap();
        }
        if mode == "cancel" {
            owner.cancel_run(&lease.stamp.session, &lease.run_id).unwrap();
        }
        assert_eq!(owner.commit_replacement(candidate).unwrap_err().code, ErrorCode::SessionConflict);
        let reader = owner.begin_run(&owner.stamp().session).unwrap();
        let after = owner.snapshot(&context(&reader, "read")).unwrap();
        assert_eq!(before.file, after.file);
        assert_eq!(before.stamp, after.stamp);
    }
}

#[test]
fn file_snapshot_must_match_a_well_formed_replayable_journal() {
    let (mut owner, lease) = setup();
    let valid = owner.snapshot(&context(&lease, "read")).unwrap().file;
    let mut sequence = 1;
    for bad in ["format", "model", "hash", "sequence", "reset", "command"] {
        sequence += 1;
        let ticket =
            owner.begin_replacement(context(&lease, &sequence.to_string()), lease.stamp.state_version.clone()).unwrap();
        let mut file = valid.clone();
        match bad {
            "format" => file.format = "wrong".into(),
            "model" => file.model.name = "snapshot-without-history".into(),
            "hash" => file.journal.entries[0].hash_after = "wrong".into(),
            "sequence" => file.journal.entries[0].seq = 3,
            "reset" => {
                let mut entry = file.journal.entries[0].clone();
                entry.seq = 1;
                entry.cmd = command(NEW);
                file.journal.entries.push(entry);
            }
            _ => file.journal.entries[0].cmd = command(BAD),
        }
        assert!(pollster::block_on(Candidate::new(ticket.clone(), None, Box::new(NoClock), 1).file(file)).is_err());
        owner.abandon_replacement(&ticket).unwrap();
        assert_eq!(owner.snapshot(&context(&lease, "read")).unwrap().file, valid);
    }
    sequence += 1;
    let ticket =
        owner.begin_replacement(context(&lease, &sequence.to_string()), lease.stamp.state_version.clone()).unwrap();
    let ready = pollster::block_on(Candidate::new(ticket, None, Box::new(NoClock), 1).file(valid.clone()))
        .unwrap()
        .finish(&mut JsonEncoder, usize::MAX)
        .unwrap();
    assert_eq!(owner.commit_replacement(ready).unwrap().file, valid);
}

#[test]
fn journal_and_command_builders_reject_midstream_resets() {
    let (mut owner, lease) = setup();
    let file = owner.snapshot(&context(&lease, "read")).unwrap().file;
    let ticket = owner.begin_replacement(context(&lease, "2"), lease.stamp.state_version.clone()).unwrap();
    let invalid = pollster::block_on(
        Candidate::new(ticket.clone(), None, Box::new(NoClock), 1)
            .commands(vec![command(ADD), command(NEW)], &mut proceed),
    );
    assert_eq!(invalid.err().unwrap().code, ErrorCode::Schema);
    let valid = pollster::block_on(
        Candidate::new(ticket.clone(), None, Box::new(NoClock), 1).journal(file.journal.entries.clone(), true),
    )
    .unwrap()
    .finish(&mut JsonEncoder, usize::MAX)
    .unwrap();
    assert_eq!(valid.snapshot().file, file);
    let mut entries = file.journal.entries;
    entries[0].seq = 10;
    assert!(pollster::block_on(Candidate::new(ticket, None, Box::new(NoClock), 1).journal(entries, true)).is_err());
}

struct TrackedHost(std::rc::Rc<std::cell::Cell<usize>>);
impl femlab_engine::Host for TrackedHost {
    fn now_ms(&self) -> f64 {
        0.0
    }
}
impl Drop for TrackedHost {
    fn drop(&mut self) {
        self.0.set(self.0.get() + 1);
    }
}
fn stop(_: Progress) -> bool {
    false
}

#[test]
fn failed_cancelled_and_abandoned_candidates_release_their_resources() {
    let (mut owner, lease) = setup();
    let before = owner.snapshot(&context(&lease, "read")).unwrap();
    let ticket = owner.begin_replacement(context(&lease, "2"), lease.stamp.state_version.clone()).unwrap();
    let drops = std::rc::Rc::new(std::cell::Cell::new(0));
    let candidate = Candidate::new(ticket.clone(), None, Box::new(TrackedHost(drops.clone())), 1);
    assert_eq!(
        pollster::block_on(candidate.commands(vec![command(NEW)], &mut stop)).err().unwrap().code,
        ErrorCode::Cancelled
    );
    assert_eq!(drops.get(), 1);
    let candidate = Candidate::new(ticket.clone(), None, Box::new(TrackedHost(drops.clone())), 1);
    let candidate = pollster::block_on(candidate.commands(vec![command(ADD)], &mut proceed)).unwrap();
    assert_eq!(
        pollster::block_on(candidate.commands(vec![command(NEW)], &mut proceed)).err().unwrap().code,
        ErrorCode::Schema
    );
    assert_eq!(drops.get(), 2);
    let candidate = Candidate::new(ticket.clone(), None, Box::new(TrackedHost(drops.clone())), 1);
    let mut entries = before.file.journal.entries.clone();
    entries[0].hash_after = "wrong".into();
    assert!(pollster::block_on(candidate.journal(entries, true)).is_err());
    assert_eq!(drops.get(), 3);
    // Geometry validation rejects a poisoned candidate before it can acquire the prepared type (#389).
    let candidate = Candidate::new(ticket.clone(), None, Box::new(TrackedHost(drops.clone())), 1);
    let error = pollster::block_on(candidate.commands(vec![
        command(r#"{"cmd":"geometry.addBox","name":"body","size":["2 m","2 m","2 m"]}"#),
        command(r#"{"cmd":"geometry.subtractBox","name":"cut","from":"body","size":["1.5 m","1.5 m","1.5 m"],"at":["0 m","0 m","0 m"]}"#),
        command(r#"{"cmd":"geometry.addBox","name":"body","size":["1 m","1 m","1 m"]}"#),
    ], &mut proceed)).err().unwrap();
    assert!(error.cause.contains("empty solid"));
    assert_eq!(drops.get(), 4);
    let candidate = Candidate::new(ticket.clone(), None, Box::new(TrackedHost(drops.clone())), 1);
    assert_eq!(candidate.finish(&mut FailedEncoder, usize::MAX).err().unwrap().code, ErrorCode::Schema);
    assert_eq!(drops.get(), 5);
    let candidate = Candidate::new(ticket.clone(), None, Box::new(TrackedHost(drops.clone())), 1);
    assert_eq!(candidate.finish(&mut JsonEncoder, 0).err().unwrap().code, ErrorCode::Schema);
    assert_eq!(drops.get(), 6);
    let prepared = Candidate::new(ticket.clone(), None, Box::new(TrackedHost(drops.clone())), 1)
        .finish(&mut JsonEncoder, usize::MAX)
        .unwrap();
    owner.abandon_replacement(&ticket).unwrap();
    assert_eq!(owner.commit_replacement(prepared).unwrap_err().code, ErrorCode::SessionConflict);
    assert_eq!(drops.get(), 7);
    assert_eq!(owner.snapshot(&context(&lease, "read")).unwrap().file, before.file);
}

#[test]
fn saved_result_exports_replay_without_requiring_the_skipped_results() {
    let mut engine = super::engine();
    super::solved_cantilever(
        &mut engine,
        r#"{"cmd":"mesh.set","mesher":{"kind":"lattice","size":{"nx":2,"ny":1,"nz":1}}}"#,
    );
    super::ok(&mut engine, r#"{"cmd":"mesh.export","format":"vtu","step":"static"}"#);
    let file = engine.export_file();
    let (mut owner, lease) = setup();
    let ticket = owner.begin_replacement(context(&lease, "2"), lease.stamp.state_version.clone()).unwrap();
    let candidate = pollster::block_on(Candidate::new(ticket, None, Box::new(NoClock), 1).file(file.clone()))
        .unwrap()
        .finish(&mut JsonEncoder, usize::MAX)
        .unwrap();
    assert_eq!(owner.commit_replacement(candidate).unwrap().file, file);
}

#[test]
fn replacement_admission_rejects_unbound_or_malformed_requests() {
    let (mut owner, lease) = setup();
    let mut wrong = context(&lease, "2");
    wrong.session.session_id = "old".into();
    assert_eq!(
        owner.begin_replacement(wrong, lease.stamp.state_version.clone()).unwrap_err().code,
        ErrorCode::SessionExpired
    );
    assert_eq!(
        owner.begin_replacement(context(&lease, "invalid"), lease.stamp.state_version.clone()).unwrap_err().code,
        ErrorCode::Schema
    );
    assert!(owner.begin_replacement(context(&lease, "2"), lease.stamp.state_version).is_ok());
}

#[test]
fn cross_worker_retirement_checks_the_reservation_and_revokes_posted_work() {
    let (mut owner, lease) = setup();
    let ticket = owner.begin_replacement(context(&lease, "2"), lease.stamp.state_version.clone()).unwrap();
    owner.cancel_run(&lease.stamp.session, &lease.run_id).unwrap();
    assert_eq!(owner.retire_replacement(&ticket).unwrap_err().code, ErrorCode::SessionConflict);
    let mut lease = owner.begin_run(&owner.stamp().session).unwrap();
    let ticket = owner.begin_replacement(context(&lease, "1"), lease.stamp.state_version.clone()).unwrap();
    owner.retire_replacement(&ticket).unwrap();
    assert_eq!(owner.begin_run(&lease.stamp.session).unwrap_err().code, ErrorCode::SessionExpired);
    assert_eq!(owner.snapshot(&context(&lease, "read")).unwrap_err().code, ErrorCode::SessionExpired);
    lease.stamp = owner.stamp(); // Explicit acquisition cannot revive a retired endpoint either.
    assert_eq!(owner.begin_run(&lease.stamp.session).unwrap_err().code, ErrorCode::SessionExpired);
}

#[test]
fn batch_replay_without_recorded_hashes_still_requires_a_consistent_file() {
    let (mut owner, lease) = setup();
    let before = owner.snapshot(&context(&lease, "read")).unwrap();
    let ticket = owner.begin_replacement(context(&lease, "2"), lease.stamp.state_version.clone()).unwrap();
    let mut entries = before.file.journal.entries.clone();
    for entry in &mut entries {
        entry.hash_after.clear();
    }
    let candidate =
        pollster::block_on(Candidate::new(ticket.clone(), None, Box::new(NoClock), 1).replay(entries, true, false))
            .unwrap();
    assert_eq!(candidate.finish(&mut JsonEncoder, usize::MAX).unwrap().snapshot().file.model, before.file.model);
    let mut inconsistent = before.file.clone();
    inconsistent.model.name = "different".into();
    let error = pollster::block_on(Candidate::new(ticket.clone(), None, Box::new(NoClock), 1).file_with_options(
        inconsistent,
        true,
        false,
    ))
    .err()
    .unwrap();
    assert_eq!(error.code, ErrorCode::Schema);
    assert_eq!(owner.snapshot(&context(&lease, "read")).unwrap().file, before.file);
    owner.abandon_replacement(&ticket).unwrap();
}

#[test]
fn imported_recorded_studies_cannot_publish_during_skipped_replay() {
    let (mut owner, lease) = setup();
    let before = owner.snapshot(&context(&lease, "read")).unwrap();
    let mut source = super::engine();
    super::ok(&mut source, super::IMPORTED_TET);
    super::ok(&mut source, r#"{"cmd":"step.add","name":"static","procedure":"static","constraints":[],"loads":[]}"#);
    let original = source.export_file().journal.entries;
    // No trusted hashes are required. Empty choices and restoring convergence still
    // request an unsupported study; a nonempty choice must reject before mutation.
    for (i, text) in [
        r#"{"cmd":"study.adapt","step":"static","targetError":0.1,"refinements":[[]]}"#,
        r#"{"cmd":"study.adapt","step":"static","targetError":0.1,"refinements":[]}"#,
        r#"{"cmd":"study.converge","step":"static","sizes":["1 m","0.5 m"],"quantity":{"kind":"max","field":"vonMises"},"restore":true}"#,
        r#"{"cmd":"study.converge","step":"static","sizes":["1 m","0.5 m"],"quantity":{"kind":"max","field":"vonMises"}}"#,
        r#"{"cmd":"study.converge","step":"static","sizes":["1 m","0.5 m"],"quantity":{"kind":"max","field":"vonMises"},"restore":false}"#,
    ].iter().enumerate() {
        let mut entries = original.clone();
        let mut recorded = entries.last().unwrap().clone();
        recorded.seq += 1;
        recorded.hash_after.clear();
        recorded.cmd = command(text);
        entries.push(recorded);
        let ticket = owner.begin_replacement(context(&lease, &(i+2).to_string()), lease.stamp.state_version.clone()).unwrap();
        let error = pollster::block_on(Candidate::new(ticket.clone(), None, Box::new(NoClock), 1).replay(entries, true, false)).err().unwrap();
        assert_eq!(error.code, ErrorCode::Unsupported);
        assert_eq!(error.where_.as_deref(), Some("mesher"));
        assert!(error.cause.contains("imported source cannot be remeshed or refined"));
        let during = owner.snapshot(&context(&lease, "read")).unwrap();
        assert_eq!(during.file, before.file);
        assert_eq!(during.stamp, before.stamp);
        owner.abandon_replacement(&ticket).unwrap();
        let after = owner.snapshot(&context(&lease, "read")).unwrap();
        assert_eq!(after.file, before.file);
        assert_eq!(after.stamp, before.stamp);
    }
}
