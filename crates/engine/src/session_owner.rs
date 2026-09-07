//! Session admission and engine execution share the same exclusive borrow. No caller can
//! obtain the inner Engine, and a stale producer cannot follow an active-model pointer.

use crate::session::{ExecutionContext, ReadRequest, SessionRef, Stamp, StateVersion, WriteRequest};
use crate::{Ack, Command, Engine, Error, ErrorCode, Gpu, Host, ModelFile, OnProgress, QueryResult};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};

/// Replies carry the request identity even when a successful replacement issues a fresh stamp.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WriteReply {
    pub context: ExecutionContext,
    pub stamp: Stamp,
    pub ack: Ack,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReadReply {
    pub context: ExecutionContext,
    pub stamp: Stamp,
    pub value: QueryResult,
}

/// A producer's initial binding. It advances only from its own replies or an explicit read.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunLease {
    pub stamp: Stamp,
    pub run_id: String,
}

/// One coherent publication; no await or mutator can interleave its constituent reads.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSnapshot {
    pub stamp: Stamp,
    pub model: crate::query::ModelSummary,
    pub file: ModelFile,
    pub objects: crate::query::ObjectList,
    pub results: crate::query::RetainedResults,
    pub script: String,
    pub can_undo: bool,
    pub can_redo: bool,
}

const MAX_RUNS: usize = 256;
const MAX_OUTCOMES: usize = 128;
type OperationKey = (SessionRef, String, String);
struct Outcome {
    command: Command,
    expected_version: StateVersion,
    result: Result<WriteReply, Error>,
}

pub struct SessionOwner {
    inner: Engine,
    stamp: Stamp,
    next_session: StateVersion,
    next_run: StateVersion,
    /// Revocation removes a run. Its highest admitted operation prevents replay after eviction.
    runs: BTreeMap<String, StateVersion>,
    outcomes: BTreeMap<OperationKey, Outcome>,
    outcome_order: VecDeque<OperationKey>,
    pending: Option<crate::replacement::ReplacementTicket>,
    next_ticket: StateVersion,
}

impl SessionOwner {
    /// The host injects a globally fresh runtime epoch, device and clock. No I/O is performed.
    pub fn new(gpu: Option<Gpu>, host: Box<dyn Host>, threads: usize, backend_epoch: String) -> Result<Self, Error> {
        let session = SessionRef { backend_epoch, session_id: "0".into() };
        ExecutionContext { session: session.clone(), run_id: "0".into(), operation_id: "0".into() }.validate()?;
        Ok(Self {
            inner: Engine::new(gpu, host, threads),
            stamp: Stamp { session, state_version: StateVersion::default() },
            next_session: StateVersion::default(),
            next_run: StateVersion::default(),
            runs: BTreeMap::new(),
            outcomes: BTreeMap::new(),
            outcome_order: VecDeque::new(),
            pending: None,
            next_ticket: StateVersion::default(),
        })
    }

    /// Explicit acquisition, never a fallback for an expired request.
    pub fn stamp(&self) -> Stamp {
        self.stamp.clone()
    }

    pub fn begin_run(&mut self, expected: &SessionRef) -> Result<RunLease, Error> {
        self.check_session(expected)?;
        if self.runs.len() >= MAX_RUNS {
            return Err(Error::new(ErrorCode::InUse, "too many active producers; finish or cancel a run").at("runId"));
        }
        self.next_run.advance();
        let run_id = String::from(self.next_run.clone());
        self.runs.insert(run_id.clone(), StateVersion::default());
        Ok(RunLease { stamp: self.stamp(), run_id })
    }

    /// Revoke before returning to the host; a message posted earlier is checked when executed.
    pub fn cancel_run(&mut self, session: &SessionRef, run_id: &str) -> Result<(), Error> {
        self.check_session(session)?;
        self.runs.remove(run_id);
        if self.pending.as_ref().is_some_and(|ticket| ticket.context.run_id == run_id) {
            self.pending = None;
        }
        Ok(())
    }

    fn check_session(&self, session: &SessionRef) -> Result<(), Error> {
        if session != &self.stamp.session {
            return Err(Error::new(
                ErrorCode::SessionExpired,
                "this operation belongs to a different model activation",
            )
            .at("context.session")
            .suggest("explicitly acquire the intended session before starting new work"));
        }
        Ok(())
    }

    fn check_context(&self, context: &ExecutionContext) -> Result<(), Error> {
        context.validate()?;
        self.check_session(&context.session)?;
        if !self.runs.contains_key(&context.run_id) {
            return Err(Error::cancelled().at("context.runId"));
        }
        Ok(())
    }

    pub fn query(&mut self, request: ReadRequest) -> Result<ReadReply, Error> {
        self.check_context(&request.context)?;
        let value = self.inner.query(request.query)?;
        Ok(ReadReply { context: request.context, stamp: self.stamp(), value })
    }

    pub fn snapshot(&mut self, context: &ExecutionContext) -> Result<DocumentSnapshot, Error> {
        self.check_context(context)?;
        document_snapshot(&mut self.inner, self.stamp.clone())
    }

    /// Reserve one replacement against the captured active stamp. Old reads remain available.
    pub fn begin_replacement(
        &mut self,
        context: ExecutionContext,
        expected_version: StateVersion,
    ) -> Result<crate::replacement::ReplacementTicket, Error> {
        self.check_context(&context)?;
        if self.pending.is_some() {
            return Err(transitioning());
        }
        if expected_version != self.stamp.state_version {
            return Err(Error::new(ErrorCode::SessionConflict, "model changed before replacement preparation")
                .at("expectedVersion"));
        }
        let sequence = StateVersion::try_from(context.operation_id.clone()).map_err(Error::schema)?;
        let last = self.runs.get_mut(&context.run_id).expect("validated run");
        if !sequence.is_after(last) {
            return Err(Error::new(
                ErrorCode::OperationUnknown,
                "replacement operation already admitted; inspect its outcome",
            )
            .at("operationId"));
        }
        *last = sequence;
        self.next_ticket.advance();
        self.next_session.advance();
        let mut target = self.stamp.clone();
        target.session.session_id = String::from(self.next_session.clone());
        target.state_version.advance();
        let ticket = crate::replacement::ReplacementTicket {
            context,
            expected: self.stamp(),
            target,
            nonce: self.next_ticket.clone(),
        };
        self.pending = Some(ticket.clone());
        Ok(ticket)
    }

    pub fn abandon_replacement(&mut self, ticket: &crate::replacement::ReplacementTicket) -> Result<(), Error> {
        if self.pending.as_ref() != Some(ticket) {
            return Err(
                Error::new(ErrorCode::SessionConflict, "replacement no longer owns preparation").at("replacement")
            );
        }
        self.pending = None;
        Ok(())
    }

    /// Synchronous activation: there is no await between compare, swap, revocation and snapshot.
    pub fn commit_replacement(
        &mut self,
        prepared: crate::replacement::PreparedCandidate,
    ) -> Result<DocumentSnapshot, Error> {
        if self.pending.as_ref() != Some(&prepared.ticket) || prepared.ticket.expected != self.stamp {
            return Err(Error::new(ErrorCode::SessionConflict, "prepared candidate no longer owns activation")
                .at("replacement"));
        }
        // A matching private ticket proves admission: cancelling its run clears pending.
        let run_id = prepared.ticket.context.run_id;
        let sequence = self.runs.remove(&run_id).expect("admitted run");
        self.inner = prepared.engine;
        self.stamp = prepared.ticket.target;
        self.runs.clear();
        self.runs.insert(run_id, sequence);
        self.pending = None;
        Ok(prepared.snapshot)
    }

    /// A run uses strictly increasing canonical decimal operation ids, starting at 1.
    /// Identical retries return the captured outcome; evicted outcomes never execute again.
    pub async fn dispatch(&mut self, request: WriteRequest, progress: OnProgress<'_>) -> Result<WriteReply, Error> {
        request.context.validate()?;
        let key =
            (request.context.session.clone(), request.context.run_id.clone(), request.context.operation_id.clone());
        if let Some(outcome) = self.outcomes.get(&key) {
            if outcome.expected_version != request.expected_version || outcome.command != request.command {
                return Err(Error::new(
                    ErrorCode::OperationReused,
                    "operation id was already used for a different request",
                )
                .at("context.operationId"));
            }
            return outcome.result.clone();
        }
        self.check_context(&request.context)?;
        let sequence = StateVersion::try_from(request.context.operation_id.clone()).map_err(Error::schema)?;
        let last = self.runs.get_mut(&request.context.run_id).expect("checked run under exclusive ownership");
        if !sequence.is_after(last) {
            return Err(Error::new(
                ErrorCode::OperationUnknown,
                "operation outcome is no longer retained; it will not be repeated",
            )
            .at("context.operationId"));
        }
        *last = sequence;
        // Compare the complete typed payload, not a fallible serialization or a lossy hash.
        // Large inputs/results are not retained; their operation high-water mark still prevents
        // reexecution if the acknowledgement is lost. The bounded formatter never allocates text.
        let captured =
            small_enough(&request.command).then(|| (request.command.clone(), request.expected_version.clone()));
        let result = self.execute(request, progress).await;
        if let Some((command, expected_version)) = captured {
            if small_enough(&result) {
                self.outcomes.insert(key.clone(), Outcome { command, expected_version, result: result.clone() });
                self.outcome_order.push_back(key);
                if self.outcome_order.len() > MAX_OUTCOMES {
                    let oldest = self.outcome_order.pop_front().expect("length checked");
                    self.outcomes.remove(&oldest);
                }
            }
        }
        result
    }

    async fn execute(&mut self, request: WriteRequest, progress: OnProgress<'_>) -> Result<WriteReply, Error> {
        if self.pending.is_some() {
            return Err(transitioning());
        }
        if request.expected_version != self.stamp.state_version {
            return Err(Error::new(
                ErrorCode::SessionConflict,
                "model state changed after this operation was prepared",
            )
            .at("expectedVersion")
            .suggest("read the intended session again before preparing a new operation"));
        }
        let replacement = matches!(request.command, Command::ModelNew { .. });
        let ack = self.inner.dispatch(request.command, progress).await?;
        self.stamp.state_version.advance();
        if replacement {
            self.next_session.advance();
            self.stamp.session.session_id = String::from(self.next_session.clone());
            let sequence = self.runs.remove(&request.context.run_id).expect("admitted producer");
            self.runs.clear();
            self.runs.insert(request.context.run_id.clone(), sequence);
        }
        Ok(WriteReply { context: request.context, stamp: self.stamp(), ack })
    }
}

// A conservative retention budget supplements the entry count. Debug formatting is used only
// to bound retention, never for identity; exact typed equality above decides duplicate requests.
struct RetentionBudget(usize);
impl std::fmt::Write for RetentionBudget {
    fn write_str(&mut self, text: &str) -> std::fmt::Result {
        if text.len() > self.0 {
            return Err(std::fmt::Error);
        }
        self.0 -= text.len();
        Ok(())
    }
}
fn small_enough(value: &dyn std::fmt::Debug) -> bool {
    std::fmt::write(&mut RetentionBudget(64 * 1024), format_args!("{value:?}")).is_ok()
}

fn transitioning() -> Error {
    Error::new(ErrorCode::SessionTransitioning, "a replacement is being prepared; wait or cancel it").at("session")
}

pub(crate) fn document_snapshot(inner: &mut Engine, stamp: Stamp) -> Result<DocumentSnapshot, Error> {
    Ok(DocumentSnapshot {
        stamp,
        model: inner.query_model()?,
        file: inner.export_file(),
        objects: inner.query_objects(None),
        results: inner.query_results(),
        script: inner.journal().as_script(crate::version()),
        can_undo: inner.can_undo(),
        can_redo: inner.can_redo(),
    })
}
