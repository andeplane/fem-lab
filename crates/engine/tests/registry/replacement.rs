use femlab_engine::replacement::Candidate;
use femlab_engine::session::{ExecutionContext, WriteRequest};
use femlab_engine::session_owner::{RunLease, SessionOwner};
use femlab_engine::{Command, ErrorCode, NoClock, Progress};

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
    .finish()
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
        .finish()
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
        .finish()
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
    .finish()
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
    let prepared = Candidate::new(ticket.clone(), None, Box::new(TrackedHost(drops.clone())), 1).finish().unwrap();
    owner.abandon_replacement(&ticket).unwrap();
    assert_eq!(owner.commit_replacement(prepared).unwrap_err().code, ErrorCode::SessionConflict);
    assert_eq!(drops.get(), 5);
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
        .finish()
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
    assert_eq!(candidate.finish().unwrap().snapshot().file.model, before.file.model);
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
