//! wasm-bindgen surface of the FEM Lab engine. Thin: JSON strings for control, typed arrays
//! for bulk data (added with the mesh and results). Errors are thrown as the engine's
//! structured `Error` object, never as a bare string.

use femlab_engine::{Command, Host, JournalEntry, ModelFile, Progress, Query};
use wasm_bindgen::prelude::*;

/// The browser's clock.
struct JsHost;

impl Host for JsHost {
    fn now_ms(&self) -> f64 {
        js_sys::Date::now()
    }
}

fn throw(e: &femlab_engine::Error) -> JsValue {
    let json = serde_json::to_string(e).unwrap_or_else(|_| e.to_string());
    js_sys::JSON::parse(&json).unwrap_or_else(|_| JsValue::from_str(&json))
}

fn schema_err(e: serde_json::Error) -> JsValue {
    throw(&femlab_engine::Error::from(e))
}

/// One engine instance.
#[wasm_bindgen]
pub struct Engine {
    inner: femlab_engine::Engine,
}

#[wasm_bindgen]
impl Engine {
    /// A CPU engine. `threads` is recorded for capabilities; the single-threaded wasm build
    /// runs every parallel path sequentially with the same fixed-order reductions.
    #[wasm_bindgen(constructor)]
    pub fn new(threads: u32) -> Engine {
        Engine { inner: femlab_engine::Engine::new(None, Box::new(JsHost), threads.max(1) as usize) }
    }

    /// An engine with a WebGPU device when `opts.gpu` is true and the browser has one;
    /// otherwise a CPU engine (see `query.capabilities`). `opts = { gpu: boolean, threads: number }`.
    pub async fn create(opts: JsValue) -> Result<Engine, JsValue> {
        let want_gpu = js_sys::Reflect::get(&opts, &"gpu".into()).map(|v| v.is_truthy()).unwrap_or(false);
        let threads =
            js_sys::Reflect::get(&opts, &"threads".into()).ok().and_then(|v| v.as_f64()).unwrap_or(1.0).max(1.0)
                as usize;
        let gpu = if want_gpu {
            femlab_engine::Gpu::request(femlab_engine::Gpu::default_backends()).await.ok()
        } else {
            None
        };
        Ok(Engine { inner: femlab_engine::Engine::new(gpu, Box::new(JsHost), threads) })
    }

    /// Run the dot-product kernel on the engine's GPU: Σ i·1 for i in 1..=n, i.e. n(n+1)/2.
    /// Rejects when the engine has no GPU. The CI harness compares it with the native value.
    pub async fn gpu_self_test(&mut self, n: u32) -> Result<f64, JsValue> {
        let a: Vec<f32> = (1..=n).map(|i| i as f32).collect();
        let b = vec![1.0f32; n as usize];
        let gpu = self.inner.gpu_mut().ok_or_else(|| throw(&femlab_engine::Error::unsupported("gpu (no adapter)")))?;
        gpu.dot(&a, &b).await.map(|v| v as f64).map_err(|e| throw(&e))
    }

    /// Apply a Command given as JSON text. Resolves to the Ack as JSON text; rejects with the
    /// structured Error object. `on_progress(phase, fraction, message)` may return `false`
    /// to cancel a long Command.
    pub async fn dispatch(
        &mut self,
        cmd_json: String,
        on_progress: Option<js_sys::Function>,
    ) -> Result<String, JsValue> {
        let cmd: Command = serde_json::from_str(&cmd_json).map_err(schema_err)?;
        let mut cb = |p: Progress| -> bool {
            match &on_progress {
                Some(f) => {
                    let r = f.call3(
                        &JsValue::NULL,
                        &JsValue::from_str(p.phase),
                        &JsValue::from_f64(p.fraction),
                        &JsValue::from_str(&p.message),
                    );
                    !matches!(r, Ok(v) if v.is_falsy() && !v.is_undefined())
                }
                None => true,
            }
        };
        let ack = self.inner.dispatch(cmd, &mut cb).await.map_err(|e| throw(&e))?;
        serde_json::to_string(&ack).map_err(schema_err)
    }

    /// Answer a Query given as JSON text; returns the result as JSON text.
    pub fn query(&mut self, query_json: String) -> Result<String, JsValue> {
        let q: Query = serde_json::from_str(&query_json).map_err(schema_err)?;
        let r = self.inner.query(q).map_err(|e| throw(&e))?;
        serde_json::to_string(&r).map_err(schema_err)
    }

    /// The saved file (`femlab/1`) as JSON text.
    pub fn export_file(&self) -> String {
        serde_json::to_string(&self.inner.export_file()).unwrap_or_default()
    }

    /// Install a saved file as-is (no replay).
    pub fn import_file(&mut self, json: String) -> Result<(), JsValue> {
        let f: ModelFile = serde_json::from_str(&json).map_err(schema_err)?;
        self.inner.import_file(f).map_err(|e| throw(&e))
    }

    pub fn model_hash(&self) -> String {
        self.inner.model_hash()
    }

    pub fn revision(&self) -> u32 {
        self.inner.revision()
    }

    /// Replay a Journal (JSON array of entries) onto a fresh Model; returns the per-entry hash
    /// list as a JSON array. `verify` fails on the first divergence from the recorded hashes.
    pub async fn replay_hashes(
        &mut self,
        journal_json: String,
        skip_solves: bool,
        verify: bool,
    ) -> Result<String, JsValue> {
        let entries: Vec<JournalEntry> = serde_json::from_str(&journal_json).map_err(schema_err)?;
        let hashes = self.inner.replay(&entries, skip_solves, verify).await.map_err(|e| throw(&e))?;
        serde_json::to_string(&hashes).map_err(schema_err)
    }
}

/// The schema document (Commands, Queries, responses) as JSON text.
#[wasm_bindgen]
pub fn schema() -> String {
    serde_json::to_string(&femlab_engine::query::schema_document()).unwrap_or_default()
}

/// Engine version string.
#[wasm_bindgen]
pub fn version() -> String {
    femlab_engine::version().to_string()
}

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}
