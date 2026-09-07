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
    digest: String,
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
        Ok(DocumentSnapshot {
            stamp: self.stamp(),
            model: self.inner.query_model()?,
            file: self.inner.export_file(),
            objects: self.inner.query_objects(None),
            results: self.inner.query_results(),
            script: self.inner.journal().as_script(crate::version()),
            can_undo: self.inner.can_undo(),
            can_redo: self.inner.can_redo(),
        })
    }

    /// A run uses strictly increasing canonical decimal operation ids, starting at 1.
    /// Identical retries return the captured outcome; evicted outcomes never execute again.
    pub async fn dispatch(&mut self, request: WriteRequest, progress: OnProgress<'_>) -> Result<WriteReply, Error> {
        request.context.validate()?;
        let key =
            (request.context.session.clone(), request.context.run_id.clone(), request.context.operation_id.clone());
        let digest = crate::hash::sha256_hex(&serde_json::to_vec(&request)?);
        if let Some(outcome) = self.outcomes.get(&key) {
            if outcome.digest != digest {
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
        let result = self.execute(request, progress).await;
        self.outcomes.insert(key.clone(), Outcome { digest, result: result.clone() });
        self.outcome_order.push_back(key);
        if self.outcome_order.len() > MAX_OUTCOMES {
            let oldest = self.outcome_order.pop_front().expect("length checked");
            self.outcomes.remove(&oldest);
        }
        result
    }

    async fn execute(&mut self, request: WriteRequest, progress: OnProgress<'_>) -> Result<WriteReply, Error> {
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
