//! Parallelism shim: rayon natively, plain iteration on wasm32 (ADR 0013).
//!
//! Every reduction in the engine goes through these functions or a sequential `for` loop,
//! and every chunk boundary is a function of `n`, never of the thread count, so results are
//! bit-identical at 1 and N threads.

#[cfg(not(target_arch = "wasm32"))]
use rayon::prelude::*;

/// Chunk length used by [`dot`]; a constant so the summation order never depends on threads.
pub const DOT_CHUNK: usize = 4096;

/// `(0..n).map(f)` collected in index order.
pub fn map_collect<T: Send>(n: usize, f: impl Fn(usize) -> T + Sync + Send) -> Vec<T> {
    #[cfg(not(target_arch = "wasm32"))]
    {
        (0..n).into_par_iter().map(f).collect()
    }
    #[cfg(target_arch = "wasm32")]
    {
        (0..n).map(f).collect()
    }
}

/// Disjoint mutable chunks of `out`, `f(chunk_index, chunk)`.
pub fn for_each_chunk_mut<T: Send>(out: &mut [T], chunk: usize, f: impl Fn(usize, &mut [T]) + Sync + Send) {
    let chunk = chunk.max(1);
    #[cfg(not(target_arch = "wasm32"))]
    {
        out.par_chunks_mut(chunk).enumerate().for_each(|(i, c)| f(i, c));
    }
    #[cfg(target_arch = "wasm32")]
    {
        out.chunks_mut(chunk).enumerate().for_each(|(i, c)| f(i, c));
    }
}

/// Σ a·b with a fixed reduction order: chunks of [`DOT_CHUNK`] summed sequentially, then the
/// partials summed in index order.
pub fn dot(a: &[f64], b: &[f64]) -> f64 {
    debug_assert_eq!(a.len(), b.len());
    let n_chunks = a.len().div_ceil(DOT_CHUNK);
    let partials = map_collect(n_chunks, |c| {
        let lo = c * DOT_CHUNK;
        let hi = (lo + DOT_CHUNK).min(a.len());
        let mut s = 0.0;
        for i in lo..hi {
            s += a[i] * b[i];
        }
        s
    });
    let mut total = 0.0;
    for p in partials {
        total += p;
    }
    total
}

/// A private thread pool of `threads` threads (natively); on wasm32 runs inline.
/// The engine holds one pool per instance so tests can compare thread counts.
pub struct Pool {
    #[cfg(not(target_arch = "wasm32"))]
    inner: rayon::ThreadPool,
    threads: usize,
}

impl Pool {
    pub fn new(threads: usize) -> Pool {
        let threads = threads.max(1);
        #[cfg(not(target_arch = "wasm32"))]
        {
            let inner = rayon::ThreadPoolBuilder::new().num_threads(threads).build().expect("rayon pool");
            Pool { inner, threads }
        }
        #[cfg(target_arch = "wasm32")]
        {
            Pool { threads }
        }
    }
    pub fn threads(&self) -> usize {
        self.threads
    }
    pub fn install<T: Send>(&self, f: impl FnOnce() -> T + Send) -> T {
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.inner.install(f)
        }
        #[cfg(target_arch = "wasm32")]
        {
            f()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(n: usize) -> (Vec<f64>, Vec<f64>) {
        let a: Vec<f64> = (0..n).map(|i| libm::sin(i as f64 * 0.37) * 1e3).collect();
        let b: Vec<f64> = (0..n).map(|i| libm::cos(i as f64 * 0.11) + 1e-7 * i as f64).collect();
        (a, b)
    }

    #[test]
    fn dot_bit_identical_at_one_and_four_threads() {
        let (a, b) = data(3 * DOT_CHUNK + 17);
        let one = Pool::new(1).install(|| dot(&a, &b));
        let four = Pool::new(4).install(|| dot(&a, &b));
        assert_eq!(one.to_bits(), four.to_bits());
        let mut seq = 0.0;
        for c in 0..a.len().div_ceil(DOT_CHUNK) {
            let mut s = 0.0;
            for i in c * DOT_CHUNK..((c + 1) * DOT_CHUNK).min(a.len()) {
                s += a[i] * b[i];
            }
            seq += s;
        }
        assert_eq!(one.to_bits(), seq.to_bits());
    }

    #[test]
    fn dot_of_empty_is_zero_and_pool_reports_threads() {
        assert_eq!(dot(&[], &[]), 0.0);
        assert_eq!(Pool::new(0).threads(), 1);
        assert_eq!(Pool::new(3).threads(), 3);
    }

    #[test]
    fn map_collect_preserves_order_and_chunks_are_disjoint() {
        let v = Pool::new(4).install(|| map_collect(1000, |i| i * 2));
        assert_eq!(v[999], 1998);
        assert!(v.windows(2).all(|w| w[0] < w[1]));
        let mut out = vec![0u32; 1003];
        Pool::new(4)
            .install(|| for_each_chunk_mut(&mut out, 100, |c, chunk| chunk.iter_mut().for_each(|x| *x = c as u32)));
        assert_eq!(out[0], 0);
        assert_eq!(out[999], 9);
        assert_eq!(out[1002], 10);
        let mut small = vec![0u8; 3];
        for_each_chunk_mut(&mut small, 0, |_, c| c.fill(7));
        assert_eq!(small, [7, 7, 7]);
    }
}
