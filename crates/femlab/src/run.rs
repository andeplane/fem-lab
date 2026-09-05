//! `femlab run` and `femlab schema`.

use std::path::Path;
use std::time::Instant;

use femlab_engine::query::{Query, QueryResult};
use femlab_engine::{Command, Engine, Host, JournalEntry, ModelFile, Progress};

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

pub fn new_engine(threads: Option<usize>) -> Engine {
    let n = threads.unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1));
    Engine::new(Box::new(SystemClock::default()), n)
}

pub struct RunOptions {
    pub hashes: bool,
    pub skip_solves: bool,
    pub verify: bool,
    pub as_script: bool,
    pub journal: bool,
    pub json: bool,
    pub threads: Option<usize>,
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

pub fn run(file: &Path, opts: RunOptions) -> i32 {
    let text = match std::fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("cannot read {}: {e}", file.display());
            return 1;
        }
    };
    let input = match parse_input(&text) {
        Ok(i) => i,
        Err(e) => {
            eprintln!("{}: {e}", file.display());
            return 1;
        }
    };
    let (entries, has_hashes) = entries_of(input);
    let verify = opts.verify && has_hashes;
    let mut engine = new_engine(opts.threads);
    let hashes = match pollster::block_on(engine.replay(&entries, opts.skip_solves, verify)) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("{}", serde_json::to_string(&e).unwrap_or_else(|_| e.to_string()));
            return if e.code == femlab_engine::ErrorCode::Internal { 3 } else { 1 };
        }
    };
    if opts.hashes {
        for h in hashes {
            println!("{h}");
        }
        return 0;
    }
    if opts.as_script {
        print!("{}", engine.journal().as_script(femlab_engine::version()));
        return 0;
    }
    if opts.journal {
        println!("{}", serde_json::to_string_pretty(&engine.journal().entries).unwrap_or_default());
        return 0;
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
pub fn dispatch(engine: &mut Engine, cmd: Command) -> Result<femlab_engine::Ack, femlab_engine::Error> {
    let mut nop = |_: Progress| true;
    pollster::block_on(engine.dispatch(cmd, &mut nop))
}
