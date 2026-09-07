use femlab_engine::session::{ExecutionContext, ReadRequest, WriteRequest};
use femlab_engine::session_owner::{DocumentSnapshot, RunLease, SessionOwner, WriteReply};
use femlab_engine::{Error, ErrorCode, NoClock, Progress, Query};
use proptest::prelude::*;

struct Client {
    lease: RunLease,
    sequence: u64,
}
impl Client {
    fn acquire(owner: &mut SessionOwner) -> Self {
        Self { lease: owner.begin_run(&owner.stamp().session).unwrap(), sequence: 0 }
    }
    fn context(&self) -> ExecutionContext {
        ExecutionContext {
            session: self.lease.stamp.session.clone(),
            run_id: self.lease.run_id.clone(),
            operation_id: self.sequence.to_string(),
        }
    }
    fn prepare(&mut self, command: &str) -> WriteRequest {
        self.sequence += 1;
        WriteRequest {
            context: self.context(),
            expected_version: self.lease.stamp.state_version.clone(),
            command: serde_json::from_str(command).unwrap(),
        }
    }
    fn write(&mut self, owner: &mut SessionOwner, command: &str) -> Result<WriteReply, Error> {
        let request = self.prepare(command);
        let reply = dispatch(owner, request)?;
        self.lease.stamp = reply.stamp.clone();
        Ok(reply)
    }
    fn snapshot(&self, owner: &mut SessionOwner) -> DocumentSnapshot {
        owner.snapshot(&self.context()).unwrap()
    }
}
fn owner(epoch: &str) -> SessionOwner {
    SessionOwner::new(None, Box::new(NoClock), 1, epoch.into()).unwrap()
}
fn proceed(_: Progress) -> bool {
    true
}
fn dispatch(owner: &mut SessionOwner, request: WriteRequest) -> Result<WriteReply, Error> {
    pollster::block_on(owner.dispatch(request, &mut proceed))
}
const NEW: &str = r#"{"cmd":"model.new","name":"same"}"#;
const ADD: &str = r#"{"cmd":"geometry.addBox","name":"shared","size":["1 m","1 m","1 m"]}"#;
const REMOVE: &str = r#"{"cmd":"geometry.remove","name":"shared"}"#;

#[test]
fn queued_same_name_delete_cannot_follow_a_project_switch() {
    let mut owner = owner("browser-1");
    let mut ui = Client::acquire(&mut owner);
    ui.write(&mut owner, NEW).unwrap();
    ui.write(&mut owner, ADD).unwrap();
    let mut old = Client::acquire(&mut owner);
    let paused = old.prepare(REMOVE);
    // No sleeps: dequeue the prepared old request only after B exists with the same name.
    ui.write(&mut owner, NEW).unwrap();
    ui.write(&mut owner, ADD).unwrap();
    let before = ui.snapshot(&mut owner);
    assert_eq!(dispatch(&mut owner, paused).unwrap_err().code, ErrorCode::SessionExpired);
    let after = ui.snapshot(&mut owner);
    assert_eq!(before.file, after.file);
    assert_eq!(before.stamp, after.stamp);
    assert_eq!(after.file.journal.entries.len(), 2);
    assert_eq!(after.objects.objects.len(), before.objects.objects.len());
    let error = owner.query(ReadRequest { context: old.context(), query: Query::Model {} }).unwrap_err();
    assert_eq!(error.code, ErrorCode::SessionExpired);
    assert_eq!(owner.snapshot(&old.context()).unwrap_err().code, ErrorCode::SessionExpired);
    assert_eq!(
        owner.cancel_run(&old.lease.stamp.session, &old.lease.run_id).unwrap_err().code,
        ErrorCode::SessionExpired
    );
}

#[test]
fn initiating_run_advances_only_through_its_reply_and_undo_never_reuses_version() {
    let mut owner = owner("native");
    let mut script = Client::acquire(&mut owner);
    let retained = script.lease.clone();
    script.write(&mut owner, NEW).unwrap();
    script.write(&mut owner, ADD).unwrap();
    let before = script.snapshot(&mut owner);
    script.write(&mut owner, r#"{"cmd":"journal.undo"}"#).unwrap();
    script.write(&mut owner, r#"{"cmd":"journal.redo"}"#).unwrap();
    let after = script.snapshot(&mut owner);
    assert_eq!(before.file, after.file);
    assert!(after.stamp.state_version.is_after(&before.stamp.state_version));
    let old = Client { lease: retained, sequence: 0 };
    assert_eq!(owner.snapshot(&old.context()).unwrap_err().code, ErrorCode::SessionExpired);
    assert!(after.can_undo);
    assert!(!after.can_redo);
    assert!(after.script.contains("geometry.addBox"));
    let query = owner.query(ReadRequest { context: script.context(), query: Query::Model {} }).unwrap();
    assert_eq!(query.stamp, after.stamp);
    assert_ne!(
        after.model.hash,
        script.write(&mut owner, r#"{"cmd":"model.setName","name":"changed"}"#).unwrap().ack.hash
    );
}

#[test]
fn state_conflicts_and_engine_errors_are_nonmutating_and_retryable_outcomes_are_exact() {
    let mut owner = owner("native");
    let mut a = Client::acquire(&mut owner);
    let mut b = Client::acquire(&mut owner);
    let stale = b.prepare(ADD);
    let request = a.prepare(ADD);
    let reply = dispatch(&mut owner, request.clone()).unwrap();
    a.lease.stamp = reply.stamp.clone();
    let before = a.snapshot(&mut owner);
    assert_eq!(dispatch(&mut owner, stale.clone()).unwrap_err().code, ErrorCode::SessionConflict);
    assert_eq!(dispatch(&mut owner, stale).unwrap_err().code, ErrorCode::SessionConflict);
    assert_eq!(dispatch(&mut owner, request.clone()).unwrap().stamp, reply.stamp);
    let mut reused = request;
    reused.command = serde_json::from_str(REMOVE).unwrap();
    assert_eq!(dispatch(&mut owner, reused).unwrap_err().code, ErrorCode::OperationReused);
    let missing = a.prepare(r#"{"cmd":"geometry.remove","name":"missing"}"#);
    assert_eq!(dispatch(&mut owner, missing.clone()).unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(dispatch(&mut owner, missing).unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(a.snapshot(&mut owner).file, before.file);
    assert_eq!(a.snapshot(&mut owner).stamp, before.stamp);
}

#[test]
fn revoked_posted_work_and_old_backend_messages_are_rejected() {
    let mut owner = owner("native");
    let mut client = Client::acquire(&mut owner);
    let posted = client.prepare(ADD);
    owner.cancel_run(&client.lease.stamp.session, &client.lease.run_id).unwrap();
    assert_eq!(dispatch(&mut owner, posted.clone()).unwrap_err().code, ErrorCode::Cancelled);
    assert_eq!(
        owner.query(ReadRequest { context: client.context(), query: Query::Model {} }).unwrap_err().code,
        ErrorCode::Cancelled
    );
    let mut replacement = super_owner("restarted");
    assert_eq!(dispatch(&mut replacement, posted).unwrap_err().code, ErrorCode::SessionExpired);
    let mut current = Client::acquire(&mut owner);
    let mut malformed = current.prepare(ADD);
    malformed.context.operation_id.clear();
    assert_eq!(dispatch(&mut owner, malformed).unwrap_err().code, ErrorCode::Schema);
    let mut malformed = current.prepare(ADD);
    malformed.context.operation_id = "not-decimal".into();
    assert_eq!(dispatch(&mut owner, malformed).unwrap_err().code, ErrorCode::Schema);
    assert!(current.snapshot(&mut owner).file.journal.entries.is_empty());
}
fn super_owner(epoch: &str) -> SessionOwner {
    owner(epoch)
}

#[test]
fn evicted_outcomes_cannot_be_blindly_reexecuted_and_run_memory_is_bounded() {
    let mut owner = owner("native");
    let mut client = Client::acquire(&mut owner);
    let first = client.prepare(ADD);
    let reply = dispatch(&mut owner, first.clone()).unwrap();
    client.lease.stamp = reply.stamp;
    for n in 0..130 {
        client.write(&mut owner, &format!(r#"{{"cmd":"model.setName","name":"model-{n}"}}"#)).unwrap();
    }
    let before = client.snapshot(&mut owner);
    assert_eq!(dispatch(&mut owner, first).unwrap_err().code, ErrorCode::OperationUnknown);
    assert_eq!(client.snapshot(&mut owner).file, before.file);
    for _ in 1..256 {
        Client::acquire(&mut owner);
    }
    assert_eq!(owner.begin_run(&owner.stamp().session).unwrap_err().code, ErrorCode::InUse);
    owner.cancel_run(&client.lease.stamp.session, &client.lease.run_id).unwrap();
    Client::acquire(&mut owner);
    assert!(SessionOwner::new(None, Box::new(NoClock), 1, String::new()).is_err());
}

proptest! {
    #[test]
    fn identical_model_reopens_reject_all_previous_leases(releases in prop::collection::vec(0usize..32, 1..64)) {
        let mut owner = owner("property");
        let mut ui = Client::acquire(&mut owner);
        let mut queued = Vec::new();
        for _ in 0..32 {
            ui.write(&mut owner, NEW).unwrap();
            ui.write(&mut owner, ADD).unwrap();
            queued.push(Client::acquire(&mut owner).prepare(REMOVE));
        }
        ui.write(&mut owner, NEW).unwrap();
        ui.write(&mut owner, ADD).unwrap();
        let before = ui.snapshot(&mut owner);
        for index in releases {
            prop_assert_eq!(dispatch(&mut owner, queued[index].clone()).unwrap_err().code, ErrorCode::SessionExpired);
            prop_assert_eq!(ui.snapshot(&mut owner).file, before.file.clone());
        }
    }
}

#[test]
fn acquisition_query_errors_and_oversized_operations_do_not_bypass_admission() {
    let mut owner = owner("runtime");
    let mut client = Client::acquire(&mut owner);
    let old = client.lease.stamp.session.clone();
    client.write(&mut owner, NEW).unwrap();
    assert_eq!(owner.begin_run(&old).unwrap_err().code, ErrorCode::SessionExpired);
    let mut malformed = client.context();
    malformed.run_id.clear();
    assert_eq!(
        owner.query(ReadRequest { context: malformed, query: Query::Model {} }).unwrap_err().code,
        ErrorCode::Schema
    );
    assert_eq!(
        owner
            .query(ReadRequest {
                context: client.context(),
                query: Query::Definition { kind: femlab_engine::command::ObjectKind::Body, name: "missing".into() }
            })
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    let request = client.prepare(ADD);
    let reply = dispatch(&mut owner, request.clone()).unwrap();
    client.lease.stamp = reply.stamp.clone();
    let mut reused = request;
    reused.expected_version = reply.stamp.state_version;
    assert_eq!(dispatch(&mut owner, reused).unwrap_err().code, ErrorCode::OperationReused);
    let large = client.prepare(&format!(r#"{{"cmd":"model.setName","name":"{}"}}"#, "x".repeat(70_000)));
    let reply = dispatch(&mut owner, large.clone()).unwrap();
    client.lease.stamp = reply.stamp;
    assert_eq!(dispatch(&mut owner, large).unwrap_err().code, ErrorCode::OperationUnknown);
    // A tiny request can have an oversized error (known-name suggestions); neither is retained.
    let huge_body =
        format!(r#"{{"cmd":"geometry.addBox","name":"{}","size":["1 m","1 m","1 m"]}}"#, "b".repeat(70_000));
    client.write(&mut owner, &huge_body).unwrap();
    let missing = client.prepare(BAD_REMOVE);
    assert_eq!(dispatch(&mut owner, missing.clone()).unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(dispatch(&mut owner, missing).unwrap_err().code, ErrorCode::OperationUnknown);
}
const BAD_REMOVE: &str = r#"{"cmd":"geometry.remove","name":"missing"}"#;

#[test]
fn a_failed_model_snapshot_is_reported_with_no_fabricated_snapshot() {
    let mut owner = owner("runtime");
    let mut client = Client::acquire(&mut owner);
    client.write(&mut owner, r#"{"cmd":"geometry.addBox","name":"body","size":["2 m","2 m","2 m"]}"#).unwrap();
    client.write(&mut owner, r#"{"cmd":"geometry.subtractBox","name":"cut","from":"body","size":["1.5 m","1.5 m","1.5 m"],"at":["0 m","0 m","0 m"]}"#).unwrap();
    client.write(&mut owner, r#"{"cmd":"geometry.addBox","name":"body","size":["1 m","1 m","1 m"]}"#).unwrap();
    let error = owner.snapshot(&client.context()).unwrap_err();
    assert!(error.cause.contains("empty solid"));
}
