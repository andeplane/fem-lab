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

fn put(o: &js_sys::Object, key: &str, value: JsValue) {
    let _ = js_sys::Reflect::set(o, &JsValue::from_str(key), &value);
}

fn strings(v: &[String]) -> JsValue {
    v.iter().map(|s| JsValue::from_str(s)).collect::<js_sys::Array>().into()
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

    /// What the viewer draws, as fresh typed arrays: the Mesh skin once the Model has mesh
    /// settings, otherwise the Bodies' geometry triangles and tagged Sheet outlines.
    /// `edges` contains vertex-index pairs, with `edgeSet`/`edgeBody` identifying each edge.
    /// `triSet` indexes `setNames`
    /// (`u32::MAX` for a triangle in no Set) and `triBody` indexes `bodyNames`.
    pub fn surface(&mut self) -> Result<JsValue, JsValue> {
        let mut positions: Vec<f32> = Vec::new();
        let mut indices: Vec<u32> = Vec::new();
        let mut tri_set: Vec<u32> = Vec::new();
        let mut tri_body: Vec<u32> = Vec::new();
        let mut edges: Vec<u32> = Vec::new();
        let mut edge_set: Vec<u32> = Vec::new();
        let mut edge_body: Vec<u32> = Vec::new();
        let mut set_names: Vec<String> = Vec::new();
        let mut body_names: Vec<String> = Vec::new();
        let source = if self.inner.model().mesh.is_some() {
            let built = self.inner.mesh().map_err(|e| throw(&e))?;
            let s = built.mesh.surface();
            positions.extend(s.positions.iter().flat_map(|p| [p[0] as f32, p[1] as f32, p[2] as f32]));
            indices.extend(s.triangles.iter().flatten().copied());
            tri_set.extend(s.tri_face.iter().map(|f| f.and_then(|i| s.set_of_face[i as usize]).unwrap_or(u32::MAX)));
            tri_body.extend(s.tri_elem.iter().map(|&e| built.mesh.block_of(e).0 as u32));
            set_names = s.set_names;
            body_names = built.body_of_block.clone();
            "mesh"
        } else {
            for preview in self.inner.geometry_surface().map_err(|e| throw(&e))? {
                let tri = preview.triangles;
                let offset = (positions.len() / 3) as u32;
                positions.extend(tri.positions.iter().flat_map(|p| [p[0] as f32, p[1] as f32, p[2] as f32]));
                for (t, v) in tri.triangles.iter().enumerate() {
                    indices.extend([v[0] + offset, v[1] + offset, v[2] + offset]);
                    let tag = tri.tag_of(t);
                    let at = set_names.iter().position(|n| n == tag).unwrap_or_else(|| {
                        set_names.push(tag.to_string());
                        set_names.len() - 1
                    });
                    tri_set.push(at as u32);
                    tri_body.push(body_names.len() as u32);
                }
                for outline in preview.outlines {
                    let start = (positions.len() / 3) as u32;
                    positions.extend(outline.pts.iter().flat_map(|p| [p[0] as f32, p[1] as f32, 0.0]));
                    for (i, tag) in outline.tags.iter().enumerate() {
                        edges.extend([start + i as u32, start + ((i + 1) % outline.pts.len()) as u32]);
                        let at = set_names.iter().position(|n| n == tag).unwrap_or_else(|| {
                            set_names.push(tag.clone());
                            set_names.len() - 1
                        });
                        edge_set.push(at as u32);
                        edge_body.push(body_names.len() as u32);
                    }
                }
                body_names.push(preview.body);
            }
            "geometry"
        };
        let out = js_sys::Object::new();
        put(&out, "positions", js_sys::Float32Array::from(&positions[..]).into());
        put(&out, "indices", js_sys::Uint32Array::from(&indices[..]).into());
        put(&out, "triSet", js_sys::Uint32Array::from(&tri_set[..]).into());
        put(&out, "triBody", js_sys::Uint32Array::from(&tri_body[..]).into());
        put(&out, "edges", js_sys::Uint32Array::from(&edges[..]).into());
        put(&out, "edgeSet", js_sys::Uint32Array::from(&edge_set[..]).into());
        put(&out, "edgeBody", js_sys::Uint32Array::from(&edge_body[..]).into());
        put(&out, "setNames", strings(&set_names));
        put(&out, "bodyNames", strings(&body_names));
        put(&out, "source", JsValue::from_str(source));
        Ok(out.into())
    }

    /// One Result field as a fresh `Float32Array`: the whole thing component-fastest, or one
    /// component when `component` is given. `step` defaults to the last solved Step and
    /// `field` is the Query's own spelling (`displacement`, `stress`, `vonMises`, ...), or
    /// `mode:k` for the k-th mode shape of a modal Step.
    pub fn field(
        &self,
        step: Option<String>,
        field: String,
        component: Option<u8>,
    ) -> Result<js_sys::Float32Array, JsValue> {
        let data = self.inner.field_named(step.as_deref(), &field).map_err(|e| throw(&e))?;
        let values = match component {
            Some(c) => data.component(c as usize),
            None => data.data.clone(),
        };
        let out: Vec<f32> = values.iter().map(|v| *v as f32).collect();
        Ok(js_sys::Float32Array::from(&out[..]))
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
