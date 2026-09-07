//! wasm-bindgen surface of the FEM Lab engine. Thin: JSON strings for control, typed arrays
//! for bulk data (added with the mesh and results). Errors are thrown as the engine's
//! structured `Error` object, never as a bare string.

use std::collections::HashMap;
use std::hash::Hash;

use femlab_engine::{Host, Progress};
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

/** CSR face-Set memberships for surface triangles. A triangle may keep every overlapping alias. */
fn face_memberships<T: Copy + Eq + Hash>(
    tri_faces: &[Option<u32>],
    faces: &[T],
    sets: &[(&str, &[T])],
) -> (Vec<u32>, Vec<u32>) {
    // Resolve each Set face once. Looking up a surface triangle is then proportional to that
    // face's actual overlapping memberships, rather than to every face in every Set.
    let mut by_face: HashMap<T, Vec<u32>> = HashMap::new();
    for (set_index, (_, set_faces)) in sets.iter().enumerate() {
        for &face in *set_faces {
            let memberships = by_face.entry(face).or_default();
            if memberships.last() != Some(&(set_index as u32)) {
                memberships.push(set_index as u32);
            }
        }
    }
    let mut offsets = vec![0];
    let mut members = Vec::new();
    for face in tri_faces {
        if let Some(face) = face.map(|index| faces[index as usize]) {
            members.extend(by_face.get(&face).into_iter().flatten().copied());
        }
        offsets.push(members.len() as u32);
    }
    (offsets, members)
}

#[cfg(test)]
mod tests {
    use std::hash::{Hash, Hasher};
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::face_memberships;

    static COMPARISONS: AtomicUsize = AtomicUsize::new(0);

    #[derive(Clone, Copy, Eq)]
    struct Counted(u32);

    impl PartialEq for Counted {
        fn eq(&self, other: &Self) -> bool {
            COMPARISONS.fetch_add(1, Ordering::Relaxed);
            self.0 == other.0
        }
    }

    impl Hash for Counted {
        fn hash<H: Hasher>(&self, state: &mut H) {
            self.0.hash(state);
        }
    }

    #[test]
    fn surface_memberships_keep_overlapping_aliases_and_empty_triangles() {
        // Faces 10 and 30 stand for faces on different Bodies. `span` deliberately includes
        // both: the CSR does not assume one Body per Set or one Set per face.
        let faces = [10, 20, 30];
        let canonical = [10, 20];
        let alias_a = [10];
        let alias_b = [10];
        let span = [10, 30];
        let sets = [
            ("canonical", canonical.as_slice()),
            ("alias-a", alias_a.as_slice()),
            ("alias-b", alias_b.as_slice()),
            ("span", span.as_slice()),
        ];
        let (offsets, members) = face_memberships(&[Some(0), Some(1), None, Some(2)], &faces, &sets);
        assert_eq!(offsets, [0, 4, 5, 5, 6]);
        assert_eq!(members, [0, 1, 2, 3, 0, 3]);

        let (empty_offsets, empty_members) = face_memberships(&[Some(0), None], &faces, &[]);
        assert_eq!(empty_offsets, [0, 0, 0]);
        assert!(empty_members.is_empty());
    }

    #[test]
    fn surface_memberships_index_many_faces_before_triangle_lookup() {
        let faces: Vec<Counted> = (0..10_000).map(Counted).collect();
        let all = faces.clone();
        let thirds: Vec<Counted> = faces.iter().step_by(3).copied().collect();
        let tri_faces: Vec<Option<u32>> = (0..faces.len() as u32).map(Some).collect();
        COMPARISONS.store(0, Ordering::Relaxed);

        let (offsets, members) =
            face_memberships(&tri_faces, &faces, &[("all", all.as_slice()), ("thirds", thirds.as_slice())]);

        assert_eq!(offsets.len(), 10_001);
        assert_eq!(offsets[1], 2);
        assert_eq!(offsets[2], 3);
        assert_eq!(offsets[10_000], 13_334);
        assert_eq!(&members[..5], [0, 1, 0, 0, 0]);
        // The comparison count is a deterministic algorithmic bound, not a machine-timing
        // assertion. A triangle × Set × face scan performs tens of millions here.
        assert!(COMPARISONS.load(Ordering::Relaxed) < 100_000);
    }
}

/// The schema document (Commands, Queries, responses) as JSON text.
#[wasm_bindgen]
pub fn schema() -> String {
    // The native CLI owns schema generation and CI checks this committed document is fresh.
    // Embedding that same document keeps the wasm API while avoiding a second runtime copy of
    // every `schemars::JsonSchema` implementation in the browser binary.
    include_str!(concat!(env!("OUT_DIR"), "/engine.schema.json")).to_owned()
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

/// Checked session surface. Hosts must capture a RunLease and send its context on every call.
/// There is no unchecked live-engine export. Replay is confined to private candidates.
#[wasm_bindgen]
pub struct SessionEngine {
    inner: femlab_engine::session_owner::SessionOwner,
}

#[wasm_bindgen]
impl SessionEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(threads: u32, backend_epoch: String) -> Result<SessionEngine, JsValue> {
        let inner = femlab_engine::session_owner::SessionOwner::new(
            None,
            Box::new(JsHost),
            threads.max(1) as usize,
            backend_epoch,
        )
        .map_err(|e| throw(&e))?;
        Ok(Self { inner })
    }

    pub async fn create(opts: JsValue, backend_epoch: String) -> Result<SessionEngine, JsValue> {
        let (gpu, threads) = session_device(opts).await?;
        let inner = femlab_engine::session_owner::SessionOwner::new(gpu, Box::new(JsHost), threads, backend_epoch)
            .map_err(|e| throw(&e))?;
        Ok(Self { inner })
    }

    pub fn stamp(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner.stamp()).map_err(schema_err)
    }

    pub fn begin_run(&mut self, session_json: String) -> Result<String, JsValue> {
        let session = serde_json::from_str(&session_json).map_err(schema_err)?;
        let lease = self.inner.begin_run(&session).map_err(|e| throw(&e))?;
        serde_json::to_string(&lease).map_err(schema_err)
    }

    pub fn fork_run(&mut self, context_json: String) -> Result<String, JsValue> {
        let context = serde_json::from_str(&context_json).map_err(schema_err)?;
        let lease = self.inner.fork_run(&context).map_err(|e| throw(&e))?;
        serde_json::to_string(&lease).map_err(schema_err)
    }

    pub fn cancel_run(&mut self, session_json: String, run_id: String) -> Result<(), JsValue> {
        let session = serde_json::from_str(&session_json).map_err(schema_err)?;
        self.inner.cancel_run(&session, &run_id).map_err(|e| throw(&e))
    }

    pub async fn dispatch(
        &mut self,
        request_json: String,
        on_progress: Option<js_sys::Function>,
    ) -> Result<String, JsValue> {
        let request = serde_json::from_str(&request_json).map_err(schema_err)?;
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
        let reply = self.inner.dispatch(request, &mut cb).await.map_err(|e| throw(&e))?;
        serde_json::to_string(&reply).map_err(schema_err)
    }

    pub fn query(&mut self, request_json: String) -> Result<String, JsValue> {
        let request = serde_json::from_str(&request_json).map_err(schema_err)?;
        let reply = self.inner.query(request).map_err(|e| throw(&e))?;
        serde_json::to_string(&reply).map_err(schema_err)
    }

    pub fn surface(&mut self, context_json: String) -> Result<JsValue, JsValue> {
        let context = serde_json::from_str(&context_json).map_err(schema_err)?;
        let (stamp, view) = self.inner.render_view(&context).map_err(|e| throw(&e))?;
        let out = render_surface(view)?;
        js_sys::Reflect::set(
            &out,
            &"stamp".into(),
            &js_sys::JSON::parse(&serde_json::to_string(&stamp).map_err(schema_err)?)?,
        )?;
        Ok(out)
    }

    pub async fn gpu_self_test(&mut self, context_json: String, n: u32) -> Result<f64, JsValue> {
        let context = serde_json::from_str(&context_json).map_err(schema_err)?;
        self.inner.gpu_self_test(&context, n).await.map_err(|e| throw(&e))
    }

    pub fn query_transfer(&mut self, request_json: String) -> Result<JsValue, JsValue> {
        let request = serde_json::from_str(&request_json).map_err(schema_err)?;
        let mut reply = self.inner.query(request).map_err(|e| throw(&e))?;
        let values = match &mut reply.value {
            femlab_engine::query::QueryResult::Frame(frame) => Some(std::mem::take(&mut frame.values)),
            femlab_engine::query::QueryResult::Field(field) => Some(std::mem::take(&mut field.values)),
            _ => None,
        };
        let out = js_sys::JSON::parse(&serde_json::to_string(&reply).map_err(schema_err)?)?;
        if let Some(values) = values {
            let value = js_sys::Reflect::get(&out, &"value".into())?;
            js_sys::Reflect::set(&value, &"values".into(), &js_sys::Float64Array::from(&values[..]))?;
        }
        Ok(out)
    }

    pub fn snapshot(&mut self, context_json: String) -> Result<String, JsValue> {
        let context = serde_json::from_str(&context_json).map_err(schema_err)?;
        let snapshot = self.inner.snapshot(&context).map_err(|e| throw(&e))?;
        serde_json::to_string(&snapshot).map_err(schema_err)
    }
}

/// A replacement builder has exactly one state; failed preparation cannot leave a committable
/// partial engine. Hosts must still abandon the owner's ticket in their failure/cancel cleanup.
enum CandidateState {
    Building(Box<femlab_engine::replacement::Candidate>),
    Ready(Box<femlab_engine::replacement::PreparedCandidate>),
    Consumed,
}

#[wasm_bindgen]
pub struct PreparedEngine {
    state: CandidateState,
}
impl PreparedEngine {
    fn take_building(&mut self) -> Result<femlab_engine::replacement::Candidate, JsValue> {
        match std::mem::replace(&mut self.state, CandidateState::Consumed) {
            CandidateState::Building(candidate) => Ok(*candidate),
            _ => Err(throw(&femlab_engine::Error::schema("candidate is no longer being prepared"))),
        }
    }
}

#[wasm_bindgen]
impl PreparedEngine {
    pub async fn create(ticket_json: String, opts: JsValue) -> Result<Self, JsValue> {
        let ticket = serde_json::from_str(&ticket_json).map_err(schema_err)?;
        let (gpu, threads) = session_device(opts).await?;
        let candidate = femlab_engine::replacement::Candidate::new(ticket, gpu, Box::new(JsHost), threads);
        Ok(Self { state: CandidateState::Building(Box::new(candidate)) })
    }

    pub async fn commands(&mut self, commands_json: String) -> Result<(), JsValue> {
        let candidate = self.take_building()?;
        let commands = serde_json::from_str(&commands_json).map_err(schema_err)?;
        let prepared = candidate.commands(commands, &mut |_| true).await.map_err(|e| throw(&e))?;
        self.state = CandidateState::Building(Box::new(prepared));
        Ok(())
    }

    pub async fn journal(
        &mut self,
        entries_json: String,
        skip_solves: bool,
        verify: Option<bool>,
    ) -> Result<(), JsValue> {
        let candidate = self.take_building()?;
        let entries = serde_json::from_str(&entries_json).map_err(schema_err)?;
        let prepared = candidate.replay(entries, skip_solves, verify.unwrap_or(true)).await.map_err(|e| throw(&e))?;
        self.state = CandidateState::Building(Box::new(prepared));
        Ok(())
    }

    pub async fn file(&mut self, file_json: String) -> Result<(), JsValue> {
        let candidate = self.take_building()?;
        let file = serde_json::from_str(&file_json).map_err(schema_err)?;
        let prepared = candidate.file(file).await.map_err(|e| throw(&e))?;
        self.state = CandidateState::Building(Box::new(prepared));
        Ok(())
    }

    pub fn finish(&mut self) -> Result<String, JsValue> {
        let ready = self.take_building()?.finish().map_err(|e| throw(&e))?;
        let json = serde_json::to_string(ready.snapshot()).map_err(schema_err)?;
        self.state = CandidateState::Ready(Box::new(ready));
        Ok(json)
    }
}

#[wasm_bindgen]
impl SessionEngine {
    pub fn begin_replacement(&mut self, context_json: String, expected_version: String) -> Result<String, JsValue> {
        let context = serde_json::from_str(&context_json).map_err(schema_err)?;
        let version = femlab_engine::session::StateVersion::try_from(expected_version)
            .map_err(|e| throw(&femlab_engine::Error::schema(e)))?;
        let ticket = self.inner.begin_replacement(context, version).map_err(|e| throw(&e))?;
        serde_json::to_string(&ticket).map_err(schema_err)
    }

    pub fn abandon_replacement(&mut self, ticket_json: String) -> Result<(), JsValue> {
        let ticket = serde_json::from_str(&ticket_json).map_err(schema_err)?;
        self.inner.abandon_replacement(&ticket).map_err(|e| throw(&e))
    }

    pub fn retire_replacement(&mut self, ticket_json: String) -> Result<(), JsValue> {
        let ticket = serde_json::from_str(&ticket_json).map_err(schema_err)?;
        self.inner.retire_replacement(&ticket).map_err(|e| throw(&e))
    }

    pub fn commit_candidate(&mut self, candidate: PreparedEngine) -> Result<String, JsValue> {
        let CandidateState::Ready(prepared) = candidate.state else {
            return Err(throw(&femlab_engine::Error::schema("candidate has not finished validation")));
        };
        let snapshot = self.inner.commit_replacement(*prepared).map_err(|e| throw(&e))?;
        serde_json::to_string(&snapshot).map_err(schema_err)
    }
}

/// A requested device failure aborts preparation; it never silently changes the backend.
async fn session_device(opts: JsValue) -> Result<(Option<femlab_engine::Gpu>, usize), JsValue> {
    let want_gpu = js_sys::Reflect::get(&opts, &"gpu".into()).map(|v| v.is_truthy()).unwrap_or(false);
    let threads =
        js_sys::Reflect::get(&opts, &"threads".into()).ok().and_then(|v| v.as_f64()).unwrap_or(1.0).max(1.0) as usize;
    let gpu = if want_gpu {
        Some(femlab_engine::Gpu::request(femlab_engine::Gpu::default_backends()).await.map_err(|e| throw(&e))?)
    } else {
        None
    };
    Ok((gpu, threads))
}

fn render_surface(view: femlab_engine::RenderView<'_>) -> Result<JsValue, JsValue> {
    let mut positions: Vec<f32> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut tri_set: Vec<u32> = Vec::new();
    let mut tri_set_offsets: Vec<u32> = Vec::new();
    let mut tri_sets: Vec<u32> = Vec::new();
    let mut tri_body: Vec<u32> = Vec::new();
    let mut edges: Vec<u32> = Vec::new();
    let mut edge_set: Vec<u32> = Vec::new();
    let mut edge_body: Vec<u32> = Vec::new();
    let mut set_names: Vec<String> = Vec::new();
    let mut membership_names: Vec<String> = Vec::new();
    let mut body_names: Vec<String> = Vec::new();
    let source = match view {
        femlab_engine::RenderView::Mesh(built) => {
            let s = built.mesh.surface();
            positions.extend(s.positions.iter().flat_map(|p| [p[0] as f32, p[1] as f32, p[2] as f32]));
            indices.extend(s.triangles.iter().flatten().copied());
            tri_set.extend(s.tri_face.iter().map(|f| f.and_then(|i| s.set_of_face[i as usize]).unwrap_or(u32::MAX)));
            membership_names = built.sets.keys().cloned().collect();
            let memberships: Vec<(&str, &[_])> =
                membership_names.iter().map(|name| (name.as_str(), built.sets[name].faces.as_slice())).collect();
            (tri_set_offsets, tri_sets) = face_memberships(&s.tri_face, &s.faces, &memberships);
            tri_body.extend(s.tri_elem.iter().map(|&e| built.mesh.block_of(e).0 as u32));
            if !s.edges.is_empty() {
                edges.extend(s.edges.iter().flatten().copied());
                edge_set.extend(s.set_of_face.iter().map(|set| set.unwrap_or(u32::MAX)));
                edge_body.extend(s.faces.iter().map(|face| built.mesh.block_of(face.elem).0 as u32));
            }
            set_names = s.set_names;
            body_names = built.body_of_block.clone();
            "mesh"
        }
        femlab_engine::RenderView::Geometry(previews) => {
            // CSR always has one more offset than triangles, including an empty surface.
            tri_set_offsets.push(0);
            for preview in previews {
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
                    tri_sets.push(at as u32);
                    tri_set_offsets.push(tri_sets.len() as u32);
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
            membership_names.clone_from(&set_names);
            "geometry"
        }
    };
    let out = js_sys::Object::new();
    put(&out, "positions", js_sys::Float32Array::from(&positions[..]).into());
    put(&out, "indices", js_sys::Uint32Array::from(&indices[..]).into());
    put(&out, "triSet", js_sys::Uint32Array::from(&tri_set[..]).into());
    put(&out, "triSetOffsets", js_sys::Uint32Array::from(&tri_set_offsets[..]).into());
    put(&out, "triSets", js_sys::Uint32Array::from(&tri_sets[..]).into());
    put(&out, "triBody", js_sys::Uint32Array::from(&tri_body[..]).into());
    put(&out, "edges", js_sys::Uint32Array::from(&edges[..]).into());
    put(&out, "edgeSet", js_sys::Uint32Array::from(&edge_set[..]).into());
    put(&out, "edgeBody", js_sys::Uint32Array::from(&edge_body[..]).into());
    put(&out, "setNames", strings(&set_names));
    put(&out, "membershipNames", strings(&membership_names));
    put(&out, "bodyNames", strings(&body_names));
    put(&out, "source", JsValue::from_str(source));
    Ok(out.into())
}
