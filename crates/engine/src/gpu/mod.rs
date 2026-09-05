//! GPU device handle and the first kernels (ADR 0002: f32 on the GPU, f64 around it).
//!
//! The engine never creates a device on its own initiative: hosts call [`Gpu::request`] and
//! pass the result to `Engine::new`. Every function that touches the device is `async`; on
//! native the readback is driven by `device.poll`, in the browser by the event loop.

use std::collections::BTreeMap;

use wgpu::util::DeviceExt;

use crate::error::{Error, ErrorCode};

/// Every WGSL file, once: `(name, source)`. Validated by naga in a test and compiled here.
pub const SHADERS: &[(&str, &str)] = &[("dot.wgsl", include_str!("../../shaders/dot.wgsl"))];

/// Threads per workgroup in every kernel.
pub const WORKGROUP: u32 = 256;
/// Largest workgroup count per dot-product dispatch (bounds the partials buffer).
pub const MAX_WORKGROUPS: u32 = 1024;
/// WebGPU's guaranteed `maxComputeWorkgroupsPerDimension`.
pub const MAX_PER_DIM: u32 = 65535;

/// A device, its queue and its limits (plain data, so tests can shrink them).
pub struct Gpu {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub limits: wgpu::Limits,
    pub adapter: String,
    pipelines: BTreeMap<(&'static str, &'static str), wgpu::ComputePipeline>,
}

impl std::fmt::Debug for Gpu {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Gpu({})", self.adapter)
    }
}

impl Gpu {
    /// Request an adapter and a device with the adapter's full limits (ADR 0002).
    pub async fn request(backends: wgpu::Backends) -> Result<Gpu, Error> {
        Gpu::request_with(backends, wgpu::Features::empty()).await
    }

    /// [`Gpu::request`] with required device features (the tests ask for features no adapter has).
    pub async fn request_with(backends: wgpu::Backends, features: wgpu::Features) -> Result<Gpu, Error> {
        let mut desc = wgpu::InstanceDescriptor::new_without_display_handle();
        desc.backends = backends;
        let instance = wgpu::Instance::new(desc);
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: None,
                force_fallback_adapter: false,
                apply_limit_buckets: false,
            })
            .await
            .map_err(|e| {
                Error::new(ErrorCode::Unsupported, format!("no GPU adapter: {e}")).suggest("the CPU solvers still work")
            })?;
        let info = adapter.get_info();
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("femlab"),
                required_features: features,
                required_limits: adapter.limits(),
                ..Default::default()
            })
            .await
            .map_err(|e| Error::new(ErrorCode::Unsupported, format!("GPU device request failed: {e}")))?;
        let limits = device.limits();
        Ok(Gpu {
            device,
            queue,
            limits,
            adapter: format!("{} ({:?})", info.name, info.backend),
            pipelines: BTreeMap::new(),
        })
    }

    /// The default backends for this platform.
    pub fn default_backends() -> wgpu::Backends {
        #[cfg(target_arch = "wasm32")]
        {
            wgpu::Backends::BROWSER_WEBGPU
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            wgpu::Backends::PRIMARY
        }
    }

    /// Compile (once) and fetch the pipeline for an entry point of a shader in [`SHADERS`].
    /// A shader that fails to compile is reported as `gpu.shader` with the compiler's message;
    /// an adapter whose workgroup limit is below [`WORKGROUP`] as `gpu.too-large`.
    pub async fn pipeline(
        &mut self,
        shader: &'static str,
        entry: &'static str,
    ) -> Result<&wgpu::ComputePipeline, Error> {
        if self.limits.max_compute_invocations_per_workgroup < WORKGROUP {
            return Err(Error::new(
                ErrorCode::GpuTooLarge,
                format!(
                    "kernels use {WORKGROUP} threads per workgroup but this adapter allows {}",
                    self.limits.max_compute_invocations_per_workgroup
                ),
            )
            .suggest("use solver: 'cpu-direct'"));
        }
        if !self.pipelines.contains_key(&(shader, entry)) {
            let src = SHADERS
                .iter()
                .find(|(n, _)| *n == shader)
                .map(|(_, s)| *s)
                .ok_or_else(|| Error::internal(format!("unknown shader {shader}")))?;
            let p = self.compile(shader, src, entry).await?;
            self.pipelines.insert((shader, entry), p);
        }
        Ok(&self.pipelines[&(shader, entry)])
    }

    /// [`Gpu::pipeline`] for several entry points at once (one error path for a kernel's set).
    pub async fn pipelines(
        &mut self,
        keys: &[(&'static str, &'static str)],
    ) -> Result<Vec<wgpu::ComputePipeline>, Error> {
        let mut out = Vec::with_capacity(keys.len());
        for (shader, entry) in keys {
            out.push(self.pipeline(shader, entry).await?.clone());
        }
        Ok(out)
    }

    /// Compile any WGSL text (used by the tests to push a broken shader through the device).
    pub async fn compile(&self, label: &str, src: &str, entry: &str) -> Result<wgpu::ComputePipeline, Error> {
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let module = self.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some(label),
            source: wgpu::ShaderSource::Wgsl(src.into()),
        });
        let pipeline = self.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some(label),
            layout: None,
            module: &module,
            entry_point: Some(entry),
            compilation_options: Default::default(),
            cache: None,
        });
        match scope.pop().await {
            None => Ok(pipeline),
            Some(e) => Err(Error::new(ErrorCode::GpuShader, format!("{label}: {e}")).at(format!("shader {label}"))),
        }
    }

    pub fn buffer_f32(&self, label: &str, data: &[f32], usage: wgpu::BufferUsages) -> wgpu::Buffer {
        self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some(label),
            contents: bytemuck::cast_slice(data),
            usage,
        })
    }

    pub fn buffer_u32(&self, label: &str, data: &[u32], usage: wgpu::BufferUsages) -> wgpu::Buffer {
        self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some(label),
            contents: bytemuck::cast_slice(data),
            usage,
        })
    }

    /// Copy `bytes` of `src` into a staging buffer, submit, await the mapping, return the bytes.
    /// A validation error (`bytes` beyond `src`, a source without `COPY_SRC`), a lost device or a
    /// failed mapping all surface as one `internal` error: they are programming errors, not user ones.
    pub async fn read_back(&self, src: &wgpu::Buffer, bytes: u64) -> Result<Vec<u8>, Error> {
        let scope = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let staging = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("staging"),
            size: bytes,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut enc = self.device.create_command_encoder(&Default::default());
        enc.copy_buffer_to_buffer(src, 0, &staging, 0, bytes);
        self.queue.submit([enc.finish()]);
        let slice = staging.slice(..);
        let (tx, rx) = futures_channel::oneshot::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        #[cfg(not(target_arch = "wasm32"))]
        let polled = self.device.poll(wgpu::PollType::wait_indefinitely()).is_ok();
        #[cfg(target_arch = "wasm32")]
        let polled = true;
        let ok = scope.pop().await.is_none() && polled && rx.await.is_ok_and(|r| r.is_ok());
        let view = if ok { slice.get_mapped_range().ok() } else { None };
        let data = view
            .ok_or_else(|| {
                Error::internal(format!(
                    "gpu readback of {bytes} bytes failed (validation error, lost device or unmapped buffer)"
                ))
            })?
            .to_vec();
        staging.unmap();
        Ok(data)
    }

    /// Bytes a buffer may have on this device.
    pub fn max_buffer_bytes(&self) -> u64 {
        self.limits.max_buffer_size.min(self.limits.max_storage_buffer_binding_size)
    }

    /// Check a buffer fits; `gpu.too-large` names the size and the limit.
    pub fn check_size(&self, what: &str, bytes: u64) -> Result<(), Error> {
        if bytes > self.max_buffer_bytes() {
            return Err(Error::new(
                ErrorCode::GpuTooLarge,
                format!("{what} needs {bytes} bytes but this adapter allows {} per buffer", self.max_buffer_bytes()),
            )
            .suggest("use solver: 'cpu-direct' or a coarser mesh"));
        }
        Ok(())
    }

    /// Workgroup count for `n` items, capped, and the always-2D grid for it.
    pub fn grid(n: usize) -> (u32, [u32; 2]) {
        let n_wg = ((n as u32).div_ceil(WORKGROUP)).clamp(1, MAX_WORKGROUPS);
        (n_wg, [n_wg.min(MAX_PER_DIM), n_wg.div_ceil(MAX_PER_DIM)])
    }

    /// Σ a·b in f32 on the device, bit-identical across runs on one adapter.
    pub async fn dot(&mut self, a: &[f32], b: &[f32]) -> Result<f32, Error> {
        if a.len() != b.len() {
            return Err(Error::internal(format!("dot: lengths differ ({} vs {})", a.len(), b.len())));
        }
        if a.is_empty() {
            return Ok(0.0);
        }
        self.check_size("dot operands", (a.len() * 4) as u64)?;
        let (n_wg, grid) = Gpu::grid(a.len());
        let ba = self.buffer_f32("a", a, wgpu::BufferUsages::STORAGE);
        let bb = self.buffer_f32("b", b, wgpu::BufferUsages::STORAGE);
        let partials = self.buffer_f32(
            "partials",
            &vec![0.0; n_wg as usize],
            wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        );
        let params = self.buffer_u32("params", &[a.len() as u32, n_wg], wgpu::BufferUsages::UNIFORM);
        let ps = self.pipelines(&[("dot.wgsl", "dot_partial"), ("dot.wgsl", "dot_final")]).await?;
        let (p_partial, p_final) = (&ps[0], &ps[1]);
        // Auto layouts hold only the bindings an entry point uses: dot_final reads 2 and 3 alone.
        let bind = |pipeline: &wgpu::ComputePipeline, first: usize| {
            let all = [
                wgpu::BindGroupEntry { binding: 0, resource: ba.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: bb.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: partials.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: params.as_entire_binding() },
            ];
            self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("dot"),
                layout: &pipeline.get_bind_group_layout(0),
                entries: &all[first..],
            })
        };
        let bg_partial = bind(p_partial, 0);
        let bg_final = bind(p_final, 2);
        let mut enc = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_compute_pass(&Default::default());
            pass.set_pipeline(p_partial);
            pass.set_bind_group(0, &bg_partial, &[]);
            pass.dispatch_workgroups(grid[0], grid[1], 1);
            pass.set_pipeline(p_final);
            pass.set_bind_group(0, &bg_final, &[]);
            pass.dispatch_workgroups(1, 1, 1);
        }
        self.queue.submit([enc.finish()]);
        self.read_back(&partials, 4).await.map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }
}
