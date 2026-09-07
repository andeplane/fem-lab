//! `femlab run` and `femlab schema`.

use std::path::Path;
use std::time::Instant;

use femlab_engine::query::{Query, QueryResult};
use femlab_engine::replacement::Candidate;
use femlab_engine::session::{ExecutionContext, ReadRequest, WriteRequest};
use femlab_engine::session_owner::{DocumentSnapshot, RunLease};
use femlab_engine::{Command, Host, JournalEntry, ModelFile, Progress, SessionOwner};
use std::sync::atomic::{AtomicU64, Ordering};

/// One CLI invocation owns one producer. No mutable core Engine escapes the owner.
pub struct BatchEngine {
    owner: SessionOwner,
    lease: RunLease,
    operation: u64,
    threads: usize,
    cpu: bool,
}
impl BatchEngine {
    fn context(&mut self) -> ExecutionContext {
        self.operation += 1;
        ExecutionContext {
            session: self.lease.stamp.session.clone(),
            run_id: self.lease.run_id.clone(),
            operation_id: self.operation.to_string(),
        }
    }
    fn candidate(
        &mut self,
    ) -> Result<(Candidate, femlab_engine::replacement::ReplacementTicket), femlab_engine::Error> {
        let context = self.context();
        let ticket = self.owner.begin_replacement(context, self.lease.stamp.state_version.clone())?;
        Ok((Candidate::new(ticket.clone(), device(self.cpu), Box::new(SystemClock::default()), self.threads), ticket))
    }
    pub async fn load(&mut self, input: Input, skip: bool, verify: bool) -> Result<Vec<String>, femlab_engine::Error> {
        let (candidate, ticket) = self.candidate()?;
        let built = match input {
            Input::File(file) => candidate.file_with_options(*file, skip, verify).await,
            other => {
                let (entries, has_hashes) = entries_of(other);
                candidate.replay(entries, skip, verify && has_hashes).await
            }
        };
        let prepared = match built.and_then(Candidate::finish) {
            Ok(prepared) => prepared,
            Err(error) => {
                self.owner.abandon_replacement(&ticket)?;
                return Err(error);
            }
        };
        let snapshot = self.owner.commit_replacement(prepared)?;
        self.lease.stamp = snapshot.stamp;
        Ok(snapshot.journal.entries.into_iter().map(|entry| entry.hash_after).collect())
    }
    pub fn query(&mut self, query: Query) -> Result<QueryResult, femlab_engine::Error> {
        let request = ReadRequest { context: self.context(), query };
        let reply = self.owner.query(request)?;
        self.lease.stamp = reply.stamp;
        Ok(reply.value)
    }
    pub fn snapshot(&mut self) -> Result<DocumentSnapshot, femlab_engine::Error> {
        let context = self.context();
        self.owner.snapshot(&context)
    }
    async fn dispatch(&mut self, cmd: Command) -> Result<femlab_engine::Ack, femlab_engine::Error> {
        let mut progress = |_: Progress| true;
        if matches!(cmd, Command::ModelNew { .. }) {
            let (candidate, ticket) = self.candidate()?;
            let prepared = match candidate.commands(vec![cmd], &mut progress).await.and_then(Candidate::finish) {
                Ok(prepared) => prepared,
                Err(error) => {
                    self.owner.abandon_replacement(&ticket)?;
                    return Err(error);
                }
            };
            let snapshot = self.owner.commit_replacement(prepared)?;
            self.lease.stamp = snapshot.stamp;
            return Ok(femlab_engine::Ack {
                seq: 0,
                revision: snapshot.model.revision,
                hash: snapshot.model.hash,
                warnings: vec![],
                output: femlab_engine::Output::None,
            });
        }
        let request = WriteRequest {
            context: self.context(),
            expected_version: self.lease.stamp.state_version.clone(),
            command: cmd,
        };
        let reply = self.owner.dispatch(request, &mut progress).await?;
        self.lease.stamp = reply.stamp;
        Ok(reply.ack)
    }
}

fn device(cpu: bool) -> Option<femlab_engine::Gpu> {
    if cpu {
        None
    } else {
        pollster::block_on(femlab_engine::Gpu::request(femlab_engine::Gpu::default_backends())).ok()
    }
}

/// The CLI's clock.
pub struct SystemClock(Instant);

impl Default for SystemClock {
    fn default() -> Self {
        SystemClock(Instant::now())
    }
}

impl Host for SystemClock {
    fn now_ms(&self) -> f64 {
        self.0.elapsed().as_secs_f64() * 1000.0
    }
}

/// A native engine; `cpu` skips the GPU request. A missing adapter is not an error here:
/// the CPU solvers work without one and `query.capabilities` says so.
pub fn new_engine(threads: Option<usize>, cpu: bool) -> BatchEngine {
    static EPOCH: AtomicU64 = AtomicU64::new(0);
    let n = threads.unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1));
    let epoch = format!("cli-{}-{}", std::process::id(), EPOCH.fetch_add(1, Ordering::Relaxed));
    let mut owner =
        SessionOwner::new(device(cpu), Box::new(SystemClock::default()), n, epoch).expect("nonempty CLI epoch");
    let lease = owner.begin_run(&owner.stamp().session).expect("fresh CLI session");
    BatchEngine { owner, lease, operation: 0, threads: n, cpu }
}

pub struct RunOptions {
    pub hashes: bool,
    pub skip_solves: bool,
    pub verify: bool,
    pub as_script: bool,
    pub journal: bool,
    pub json: bool,
    pub queries: Vec<Query>,
    pub threads: Option<usize>,
    pub cpu: bool,
}

/// What a file may contain.
pub enum Input {
    File(Box<ModelFile>),
    Journal(Vec<JournalEntry>),
    Commands(Vec<Command>),
}

pub fn parse_input(text: &str) -> Result<Input, String> {
    let v: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("not JSON: {e}"))?;
    if v.get("format").is_some() {
        return serde_json::from_value::<ModelFile>(v)
            .map(|f| Input::File(Box::new(f)))
            .map_err(|e| format!("not a femlab/1 file: {e}"));
    }
    let arr = v.as_array().ok_or("expected a femlab/1 file object or a JSON array")?;
    // a Command's `cmd` is its name; a Journal entry's `cmd` is the Command object
    if arr.first().is_some_and(|e| e.get("cmd").is_some_and(serde_json::Value::is_string)) {
        return serde_json::from_value::<Vec<Command>>(v).map(Input::Commands).map_err(|e| format!("bad Command: {e}"));
    }
    serde_json::from_value::<Vec<JournalEntry>>(v).map(Input::Journal).map_err(|e| format!("bad Journal entry: {e}"))
}

pub fn entries_of(input: Input) -> (Vec<JournalEntry>, bool) {
    match input {
        Input::File(f) => (f.journal.entries, true),
        Input::Journal(j) => (j, true),
        Input::Commands(cmds) => (
            cmds.into_iter()
                .enumerate()
                .map(|(i, cmd)| JournalEntry { seq: i as u32, cmd, hash_after: String::new() })
                .collect(),
            false,
        ),
    }
}

/// Read a Model file, Journal or Command list without discarding the supplied Model snapshot.
/// The `Err` is the exit code the caller should return.
pub fn read_input(file: &Path) -> Result<Input, i32> {
    let text = std::fs::read_to_string(file).map_err(|e| {
        eprintln!("cannot read {}: {e}", file.display());
        1
    })?;
    let input = parse_input(&text).map_err(|e| {
        eprintln!("{}: {e}", file.display());
        1
    })?;
    Ok(input)
}

pub fn run(file: &Path, opts: RunOptions) -> i32 {
    let input = match read_input(file) {
        Ok(x) => x,
        Err(code) => return code,
    };
    let mut engine = new_engine(opts.threads, opts.cpu);
    let hashes = match pollster::block_on(engine.load(input, opts.skip_solves, opts.verify)) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("{}", serde_json::to_string(&e).unwrap_or_else(|_| e.to_string()));
            return if e.code == femlab_engine::ErrorCode::Internal { 3 } else { 1 };
        }
    };
    if !opts.queries.is_empty() {
        let mut results = Vec::with_capacity(opts.queries.len());
        for query in opts.queries {
            match engine.query(query) {
                Ok(result) => results.push(result),
                Err(e) => {
                    eprintln!("{}", serde_json::to_string(&e).unwrap_or_else(|_| e.to_string()));
                    return 1;
                }
            }
        }
        println!("{}", serde_json::to_string(&results).unwrap_or_default());
        return 0;
    }
    if opts.hashes {
        for h in hashes {
            println!("{h}");
        }
        return 0;
    }
    if opts.as_script || opts.journal {
        return match engine.snapshot() {
            Ok(snapshot) => {
                if opts.as_script {
                    print!("{}", snapshot.script);
                } else {
                    println!("{}", serde_json::to_string_pretty(&snapshot.journal.entries).unwrap_or_default());
                }
                0
            }
            Err(error) => {
                eprintln!("{error}");
                1
            }
        };
    }
    match engine.query(Query::Model {}) {
        Ok(QueryResult::Model(m)) => {
            if opts.json {
                println!("{}", serde_json::to_string_pretty(&m).unwrap_or_default());
            } else {
                print!("{}", summary_text(&m));
            }
            0
        }
        Ok(_) => 1,
        Err(e) => {
            eprintln!("{}", serde_json::to_string(&e).unwrap_or_else(|_| e.to_string()));
            1
        }
    }
}

pub fn summary_text(m: &femlab_engine::query::ModelSummary) -> String {
    let mut s = format!("Model '{}' (revision {}, hash {})\n", m.name, m.revision, &m.hash[..12]);
    s += &format!("idealisation: {}\n", m.idealisation);
    for b in &m.bodies {
        s += &format!(
            "  body {:<12} {} {}  material {}  faces {}\n",
            b.name,
            femlab_engine::units::fmt_sig(b.measure.value, 5),
            b.measure.unit,
            b.material.as_deref().unwrap_or("-"),
            b.faces.join(", ")
        );
    }
    for mat in &m.materials {
        s += &format!(
            "  material {:<8} E = {} {}, nu = {}  on {}\n",
            mat.name,
            femlab_engine::units::fmt_sig(mat.e.value, 5),
            mat.e.unit,
            mat.nu,
            mat.assigned_to.join(", ")
        );
    }
    for c in &m.constraints {
        s += &format!("  constraint {:<6} on {}: {}\n", c.name, c.on, c.summary);
    }
    for l in &m.loads {
        s += &format!(
            "  load {:<12} {}{}: {}\n",
            l.name,
            l.kind,
            l.on.as_ref().map(|o| format!(" on {o}")).unwrap_or_default(),
            l.summary
        );
    }
    for st in &m.steps {
        s += &format!(
            "  step {:<12} {} constraints [{}] loads [{}]\n",
            st.name,
            st.procedure,
            st.constraints.join(", "),
            st.loads.join(", ")
        );
    }
    for w in &m.warnings {
        s += &format!("  warning {}: {}\n", w.code, w.text);
    }
    s
}

pub fn schema(out: Option<&Path>, check: bool) -> i32 {
    let doc = femlab_engine::query::schema_document();
    let text = serde_json::to_string_pretty(&doc).unwrap_or_default() + "\n";
    match (out, check) {
        (Some(p), true) => match std::fs::read_to_string(p) {
            Ok(existing) if existing == text => 0,
            Ok(_) => {
                eprintln!("{} is out of date: run `femlab schema --out {}`", p.display(), p.display());
                1
            }
            Err(e) => {
                eprintln!("cannot read {}: {e}", p.display());
                1
            }
        },
        (Some(p), false) => match std::fs::write(p, &text) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("cannot write {}: {e}", p.display());
                1
            }
        },
        (None, _) => {
            print!("{text}");
            0
        }
    }
}

/// Dispatch helper shared by run and bench.
pub fn dispatch(engine: &mut BatchEngine, cmd: Command) -> Result<femlab_engine::Ack, femlab_engine::Error> {
    pollster::block_on(engine.dispatch(cmd))
}
