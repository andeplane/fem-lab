//! Deterministic f64 setup for the GPU's fixed symmetric aggregation V-cycle.
//!
//! The root operator is borrowed. Only coarse operators, prolongation/restriction and the
//! small inverse Cholesky factor are retained. The caller supplies every resource limit;
//! this module chooses neither a host memory budget nor a fallback solver.

pub(crate) mod physical;

use std::collections::BTreeMap;
use std::mem::size_of;

use crate::error::{Error, ErrorCode};
use crate::fem::assembly::Csr;
use crate::par;

const COARSE_ROWS: usize = 96;
const GROUPS_PER_AGGREGATE: usize = 8;
const MAX_MODES: usize = 7;
const RANK_TOL: f64 = 1e-10;
// Conservative admission for one live BTreeMap entry, including its partially filled node.
const MAP_ENTRY_BYTES: usize = 512;
const ROW_PARTITIONS: usize = 4;

/// Only Fine roots construct tentative candidate columns. A bounded coarse solve
/// uses its factor directly, regardless of unused physical geometry metadata.
pub(crate) fn uses_candidates(rows: usize) -> bool {
    rows > COARSE_ROWS
}

/// Exact diagonal systems already have an identity operator after Jacobi scaling. Stored
/// zero off-diagonal entries do not change that optimal strategy.
pub(crate) fn needs_aggregation(k: &Csr) -> bool {
    (0..k.n).any(|row| {
        (k.row_ptr[row] as usize..k.row_ptr[row + 1] as usize)
            .any(|entry| k.col_idx[entry] as usize != row && k.vals[entry] != 0.0)
    })
}

/// Physical, unscaled reduced displacement candidates and explicit retained-row node groups.
/// A slave is absent and a partially constrained node may have fewer than three rows.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct NearSpace {
    pub node_of_row: Vec<u32>,
    pub modes: Vec<Vec<f64>>,
}

/// Explicit setup bounds. Entry counters are cumulative across generated matrices, including
/// setup products. Requested Vec storage is charged cumulatively rather than as an RSS/peak
/// estimate; temporary map entries reserve their conservative live storage until released.
/// Caller-owned root CSR, scaled values, scaling and NearSpace are excluded.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Limits {
    pub max_levels: usize,
    pub max_bytes: usize,
    pub max_interpolation_nnz: usize,
    pub max_operator_nnz: usize,
}

/// Rectangular CSR, with ascending columns and no stored exact zero entries.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RectCsr {
    pub n_rows: usize,
    pub n_cols: usize,
    pub row_ptr: Vec<u32>,
    pub col_idx: Vec<u32>,
    pub vals: Vec<f64>,
}

/// A zero-initialized, fixed V-cycle. Smoothing runs `weights` before the coarse correction
/// and in reverse order afterwards, using the same diagonal and operator both times.
// Every Fine node needs these fields; only the single coarse leaf pays the enum's
// padding. Boxing Fine would add an allocation per level to save that one leaf.
// At most Limits.max_levels nodes exist, and Budget charges each complete Plan.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, PartialEq)]
pub(crate) enum Plan {
    Coarse {
        n: usize,
        /// Row-major lower triangular C = L^-1, where A = L L^T. Apply C, then C^T.
        c: Vec<f64>,
    },
    Fine {
        n: usize,
        diag: Vec<f64>,
        weights: [f64; 4],
        p: RectCsr,
        pt: RectCsr,
        coarse_operator: Csr,
        next: Box<Plan>,
    },
}

#[derive(Clone, Copy)]
struct Matrix<'a> {
    n_rows: usize,
    row_ptr: &'a [u32],
    col_idx: &'a [u32],
    vals: &'a [f64],
}

impl<'a> Matrix<'a> {
    fn square(k: &'a Csr, vals: &'a [f64]) -> Self {
        Self { n_rows: k.n, row_ptr: &k.row_ptr, col_idx: &k.col_idx, vals }
    }
    fn rect(k: &'a RectCsr) -> Self {
        Self { n_rows: k.n_rows, row_ptr: &k.row_ptr, col_idx: &k.col_idx, vals: &k.vals }
    }
    fn row(self, row: usize) -> std::ops::Range<usize> {
        self.row_ptr[row] as usize..self.row_ptr[row + 1] as usize
    }
}

#[derive(Clone, Copy)]
enum Entries {
    Interpolation,
    Operator,
}

/// Finite diagnostic metadata for an actual requested output; it never affects admission.
#[derive(Clone, Copy)]
struct AdmissionContext {
    operation: &'static str,
    stage: &'static str,
    rows: usize,
    cols: usize,
    nnz: Option<usize>,
}

struct Budget {
    limits: Limits,
    bytes: u128,
    interpolation_nnz: usize,
    operator_nnz: usize,
}

fn too_large(what: &str) -> Error {
    Error::new(ErrorCode::SolveTooLarge, format!("aggregation setup exceeds its {what} limit"))
        .at("solve/aggregation")
        .suggest("solve.run { solver: 'cpu-direct' }, or a host with a larger admitted solve budget")
}

fn requested_limit(what: &str, requested: u128, admitted: u128) -> Error {
    Error::new(
        ErrorCode::SolveTooLarge,
        format!("aggregation setup requested {requested} {what}; admitted limit {admitted}"),
    )
    .at("solve/aggregation")
    .suggest("solve.run { solver: 'cpu-direct' }, or a host with a larger admitted solve budget")
}

fn requested_limit_in(
    what: &str,
    requested: u128,
    admitted: u128,
    context: Option<AdmissionContext>,
    vectors: &[u128],
    scratch: u128,
    previous: u128,
) -> Error {
    let mut error = requested_limit(what, requested, admitted);
    if let Some(context) = context {
        error.cause.push_str(&format!(
            "; admission operation={} stage={} rows={} cols={} nnz={:?} previous_bytes={} vector_bytes={vectors:?} scratch_bytes={scratch}",
            context.operation, context.stage, context.rows, context.cols, context.nnz, previous,
        ));
    }
    error
}

fn stalled(what: &str) -> Error {
    Error::new(ErrorCode::SolveStalled, format!("aggregation setup: {what}"))
        .at("solve/aggregation")
        .suggest("solve.run { solver: 'cpu-direct' }")
}

fn invalid(what: &str) -> Error {
    Error::schema(format!("aggregation setup: {what}")).at("solve/aggregation")
}

impl Budget {
    /// Each slice entry bounds a Vec or a group of disjoint output Vec payloads;
    /// bounding a combined payload also bounds every constituent allocation. Scratch
    /// describes live ordered-map envelopes. All source lists have <=8 entries,
    /// dimensions/NNZ are bounded by u32 and all concrete element types are <=512 bytes.
    /// Exact u128 accounting therefore cannot overflow on either supported pointer width.
    fn allocations(&mut self, vectors: &[u128], scratch: u128) -> Result<(), Error> {
        self.allocations_in(None, vectors, scratch)
    }
    fn allocations_in(
        &mut self,
        context: Option<AdmissionContext>,
        vectors: &[u128],
        scratch: u128,
    ) -> Result<(), Error> {
        let next = self.bytes + vectors.iter().sum::<u128>() + scratch;
        if next > self.limits.max_bytes as u128 {
            return Err(requested_limit_in(
                "setup bytes",
                next,
                self.limits.max_bytes as u128,
                context,
                vectors,
                scratch,
                self.bytes,
            ));
        }
        let largest = vectors.iter().copied().max().unwrap_or(0);
        if largest > isize::MAX as u128 {
            return Err(requested_limit_in(
                "allocation bytes",
                largest,
                isize::MAX as u128,
                context,
                vectors,
                scratch,
                self.bytes,
            ));
        }
        self.bytes = next;
        Ok(())
    }
    fn bytes(&mut self, bytes: u128) -> Result<(), Error> {
        self.allocations(&[], bytes)
    }
    fn vector<T>(&mut self, len: usize) -> Result<(), Error> {
        self.allocations(&[vector_bytes::<T>(len)], 0)
    }
    fn entries(&mut self, entries: u128, kind: Entries) -> Result<usize, Error> {
        let (used, limit, name) = match kind {
            Entries::Interpolation => {
                (&mut self.interpolation_nnz, self.limits.max_interpolation_nnz, "interpolation fill")
            }
            Entries::Operator => (&mut self.operator_nnz, self.limits.max_operator_nnz, "operator fill"),
        };
        // Each row has <=u32MAX unique columns and <=u32MAX rows. Its exact count
        // plus a previously admitted u32 total fits u128 before either cap is checked.
        let next = *used as u128 + entries;
        let admitted = (limit as u128).min(u32::MAX as u128);
        if next > admitted {
            return Err(requested_limit(name, next, admitted));
        }
        *used = next as usize;
        Ok(entries as usize)
    }
    fn room<T>(&mut self, out: &mut Vec<T>, additional: usize) -> Result<(), Error> {
        // Only u32/f64/triplet Vecs grow here, by <=7/<=7/1 elements. Native lengths
        // are bounded by u32 admission; wasm non-ZST Vec lengths by isizeMAX/size_of.
        // Both len+additional and its next power of two therefore fit usize. Their
        // actual allocation bytes still pass vector()'s separate isize/caller caps.
        let needed = out.len() + additional;
        if needed > out.capacity() {
            let cap = needed.next_power_of_two();
            // Charge the complete replacement buffer, so growth also admits the old/new overlap.
            self.vector::<T>(cap)?;
            out.reserve_exact(cap - out.len());
        }
        Ok(())
    }
    fn add(&mut self, row: &mut BTreeMap<u32, f64>, col: u32, value: f64) -> Result<(), Error> {
        if value != 0.0 && !row.contains_key(&col) {
            self.bytes(MAP_ENTRY_BYTES as u128)?;
        }
        add_value(row, col, value);
        Ok(())
    }
    fn map(&mut self) -> Result<BTreeMap<u32, f64>, Error> {
        // An emptied BTreeMap can retain its root allocation until it is dropped.
        self.bytes(MAP_ENTRY_BYTES as u128)?;
        Ok(BTreeMap::new())
    }
    fn release_map(&mut self, row: BTreeMap<u32, f64>) {
        self.bytes -= (row.len() as u128 + 1) * MAP_ENTRY_BYTES as u128;
    }
}

// A usize element count times a usize element size fits u128 exactly. Allocation
// and cumulative caller caps are checked together before any Vec construction.
fn vector_bytes<T>(len: usize) -> u128 {
    len as u128 * size_of::<T>() as u128
}

/// Accumulate admitted internal setup arithmetic in its original fixed order.
/// Root scaling/validation and bounded coarse factorisation remain fallible.
///
/// Finiteness proof (ordinary IEEE f64, including gradual underflow):
/// - Seven candidates and eight-group aggregation give next_n<=7*ceil(n/8). Fine
///   levels have n>96: n>=98 contracts by<=15/16, while97 immediately reaches91.
///   Since (15/16)^11<1/2 and root n<2^32, there are fewer than288 Fine levels.
/// - Robust normalization's scaled square sum contains1, so computed norm>=max|v|
///   and every retained |Tij|<=1. Its gamma_n<2^-20 for n<=u32MAX; even a subnormal
///   norm product rounds to>=2/3 of its unrounded positive value. Thus ||q||2<2,
///   without assuming exact orthogonality or that relative rank pruning is perfect.
/// - Use envelopes G>=1 to include absolute subnormal dot/update errors (<2^52*eta,
///   eta the least subnormal), rather than an invalid purely relative error bound.
///   Propagating QᵀB grows G by<8 per level; at most12 GS projections grow it by
///   <8^12. Root G<=2^16, so residuals stay<2^916; even absolute partial sums stay
///   <2^948 and robust norm products<2^932. This closes the finite-QR induction.
/// - Before each Fine level diagonal() proves |Aij|<2^128 and a normal positive
///   f32 reciprocal; high>=1, hence |omega/d|<2^129. With |Tij|<=1 and at most2^32
///   terms per unique output key, conservative rounded bounds are |Pij|<2^292,
///   |APij|<2^453 and |PT*AP|<2^778. Every product and absolute partial sum fits.
/// - Symmetrization adds at most two half-scaled finite entries. Raw aggregate
///   strengths sum at most u32MAX squared admitted entries, bounded by2^288.
///
/// Arbitrary unadmitted Matrix inputs are outside this private kernel's contract.
/// Never use these bounds to relax physical input, representability or coarse guards.
fn add_value(row: &mut BTreeMap<u32, f64>, col: u32, value: f64) {
    if value != 0.0 {
        *row.entry(col).or_default() += value;
    }
}

fn validate(k: &Csr, vals: &[f64], scale: &[f64], space: Option<&NearSpace>) -> Result<(), Error> {
    if k.n > u32::MAX as usize
        || k.row_ptr.len() != k.n.saturating_add(1)
        || vals.len() != k.col_idx.len()
        || k.row_ptr.first() != Some(&0)
        || k.row_ptr.last().copied().map(|n| n as usize) != Some(vals.len())
        || scale.len() != k.n
    {
        return Err(invalid("operator or scaling dimensions do not agree"));
    }
    for row in 0..k.n {
        let lo = k.row_ptr[row] as usize;
        let hi = k.row_ptr[row + 1] as usize;
        if hi < lo
            || hi > vals.len()
            || k.col_idx[lo..hi].iter().any(|&c| c as usize >= k.n)
            || k.col_idx[lo..hi].windows(2).any(|w| w[0] >= w[1])
        {
            return Err(invalid("operator rows must have valid ascending unique columns"));
        }
    }
    if vals.iter().any(|v| !v.is_finite()) || scale.iter().any(|s| !s.is_finite() || *s <= 0.0) {
        return Err(invalid("operator values must be finite and scaling must be finite and positive"));
    }
    if let Some(space) = space {
        if space.node_of_row.len() != k.n
            || space.modes.len() >= MAX_MODES
            || space.modes.iter().any(|v| v.len() != k.n || v.iter().any(|x| !x.is_finite()))
        {
            return Err(invalid("near space needs one node group per row and at most six finite candidate columns"));
        }
    }
    Ok(())
}

/// Build from the borrowed scaled operator A = S K S. Physical candidates R, including a
/// constant, are converted once to S^-1 R. The root is never copied into the returned plan.
pub(crate) fn build(
    k: &Csr,
    vals: &[f64],
    scale: &[f64],
    space: Option<&NearSpace>,
    limits: Limits,
) -> Result<Plan, Error> {
    validate(k, vals, scale, space)?;
    if limits.max_levels == 0 {
        return Err(too_large("level"));
    }
    let mut budget = Budget { limits, bytes: 0, interpolation_nnz: 0, operator_nnz: 0 };
    let a = Matrix::square(k, vals);
    if !uses_candidates(k.n) {
        return level(a, &[], &[], 0, &mut budget);
    }
    let count = space.map_or(1, |s| s.modes.len() + 1);
    let mut storage = [vector_bytes::<f64>(k.n); MAX_MODES + 1];
    storage[0] = vector_bytes::<Vec<f64>>(count);
    budget.allocations(&storage[..=count], 0)?;
    let mut basis = Vec::with_capacity(count);
    for col in 0..count {
        let mut vector = Vec::with_capacity(k.n);
        for (row, &s) in scale.iter().enumerate() {
            let value = if col == 0 {
                1.0
            } else {
                space.expect("a nonconstant candidate has a near space").modes[col - 1][row]
            } / s;
            if !value.is_finite() {
                return Err(stalled("a scaled near-space candidate is nonfinite"));
            }
            vector.push(value);
        }
        normalize(&mut vector);
        basis.push(vector);
    }
    let default_groups;
    let groups = if let Some(space) = space {
        &space.node_of_row
    } else {
        budget.vector::<u32>(k.n)?;
        default_groups = (0..k.n as u32).collect::<Vec<_>>();
        &default_groups
    };
    level(a, &basis, groups, 0, &mut budget)
}

// Max scaling keeps normalization usable when squaring the raw candidate would overflow.
fn normalize(v: &mut [f64]) {
    let max = v.iter().fold(0.0f64, |m, x| m.max(x.abs()));
    if max > 0.0 {
        let norm = v.iter().map(|x| (x / max) * (x / max)).sum::<f64>().sqrt();
        for x in v {
            *x = (*x / max) / norm;
        }
    }
}

fn norm(v: &[f64]) -> f64 {
    let max = v.iter().fold(0.0f64, |m, x| m.max(x.abs()));
    if max == 0.0 {
        0.0
    } else {
        max * v.iter().map(|x| (x / max) * (x / max)).sum::<f64>().sqrt()
    }
}

fn diagonal(a: Matrix<'_>, budget: &mut Budget) -> Result<(Vec<f64>, f64, f64), Error> {
    budget.vector::<f64>(a.n_rows)?;
    let mut diag = vec![0.0; a.n_rows];
    let mut high = 0.0f64;
    let mut uploaded_high = 0.0f64;
    for (row, d) in diag.iter_mut().enumerate() {
        let mut sum = 0.0;
        let mut uploaded_sum = 0.0;
        for e in a.row(row) {
            if a.col_idx[e] as usize == row {
                *d = a.vals[e];
            }
            sum = (sum + a.vals[e].abs()).next_up();
            uploaded_sum = (uploaded_sum + (a.vals[e] as f32 as f64).abs()).next_up();
        }
        if *d <= 0.0 || !(sum / *d).is_finite() {
            return Err(stalled("a level has a nonpositive diagonal or nonfinite row bound"));
        }
        high = high.max((sum / *d).next_up());
        let uploaded_inverse = (1.0 / *d) as f32;
        let uploaded_bound = (uploaded_sum * f64::from(uploaded_inverse)).next_up();
        // d is positive above. A normal reciprocal stays positive even on WGSL devices
        // that flush subnormals, preserving the fixed smoother's positive diagonal.
        if !uploaded_inverse.is_normal() || !uploaded_bound.is_finite() {
            return Err(stalled("a level needs a finite uploaded operator and positive normal f32 inverse diagonal"));
        }
        uploaded_high = uploaded_high.max(uploaded_bound);
    }
    Ok((diag, high, uploaded_high.max(high)))
}

struct Groups {
    group_of_row: Vec<u32>,
    row_order: Vec<usize>,
    offsets: Vec<usize>,
}

fn groups(node_of_row: &[u32], budget: &mut Budget) -> Result<Groups, Error> {
    let n = node_of_row.len();
    budget.vector::<usize>(n)?;
    let mut row_order = (0..n).collect::<Vec<_>>();
    row_order.sort_unstable_by_key(|&row| (node_of_row[row], row));
    let count = row_order
        .iter()
        .enumerate()
        .filter(|&(i, &row)| i == 0 || node_of_row[row] != node_of_row[row_order[i - 1]])
        .count();
    budget.allocations(&[vector_bytes::<u32>(n), vector_bytes::<usize>(count + 1)], 0)?;
    let mut group_of_row = vec![0; n];
    let mut offsets = Vec::with_capacity(count + 1);
    for (i, &row) in row_order.iter().enumerate() {
        if i == 0 || node_of_row[row] != node_of_row[row_order[i - 1]] {
            offsets.push(i);
        }
        group_of_row[row] = (offsets.len() - 1) as u32;
    }
    offsets.push(n);
    Ok(Groups { group_of_row, row_order, offsets })
}

fn add_frontier(
    a: Matrix<'_>,
    groups: &Groups,
    group: usize,
    assigned: &[bool],
    frontier: &mut BTreeMap<u32, f64>,
    budget: &mut Budget,
) -> Result<(), Error> {
    let mut strengths = budget.map()?;
    for &row in &groups.row_order[groups.offsets[group]..groups.offsets[group + 1]] {
        for e in a.row(row) {
            let neighbor = groups.group_of_row[a.col_idx[e] as usize];
            if !assigned[neighbor as usize] {
                budget.add(&mut strengths, neighbor, a.vals[e] * a.vals[e])?;
            }
        }
    }
    for (&neighbor, &strength) in &strengths {
        budget.add(frontier, neighbor, strength)?;
    }
    budget.release_map(strengths);
    Ok(())
}

fn aggregates(a: Matrix<'_>, groups: &Groups, budget: &mut Budget) -> Result<Vec<Vec<usize>>, Error> {
    let n_groups = groups.offsets.len() - 1;
    let count = n_groups.div_ceil(GROUPS_PER_AGGREGATE);
    // Assigned groups partition all a.n_rows exactly once. Their output index Vecs
    // therefore request n_rows*sizeof(usize) bytes in total, admitted before any
    // aggregate allocation. Each constituent is bounded by this combined payload;
    // validated u32 rows/native or existing wasm f64 row storage bound its size.
    budget.allocations(
        &[vector_bytes::<bool>(n_groups), vector_bytes::<Vec<usize>>(count), vector_bytes::<usize>(a.n_rows)],
        0,
    )?;
    let mut assigned = vec![false; n_groups];
    let mut out = Vec::with_capacity(count);
    let mut first = 0;
    while first < n_groups {
        budget.vector::<usize>(GROUPS_PER_AGGREGATE)?;
        let mut members = Vec::with_capacity(GROUPS_PER_AGGREGATE);
        let mut frontier = budget.map()?;
        let mut next = first;
        loop {
            assigned[next] = true;
            members.push(next);
            if frontier.remove(&(next as u32)).is_some() {
                budget.bytes -= MAP_ENTRY_BYTES as u128;
            }
            while first < n_groups && assigned[first] {
                first += 1;
            }
            if members.len() == GROUPS_PER_AGGREGATE || first == n_groups {
                break;
            }
            add_frontier(a, groups, next, &assigned, &mut frontier, budget)?;
            let mut strongest = None;
            let mut weight = -1.0;
            for (&neighbor, &strength) in &frontier {
                if strength > weight {
                    strongest = Some(neighbor as usize);
                    weight = strength;
                }
            }
            next = strongest.unwrap_or(first);
        }
        budget.release_map(frontier);
        let rows = members.iter().map(|&g| groups.offsets[g + 1] - groups.offsets[g]).sum();
        let mut indices = Vec::with_capacity(rows);
        for group in members {
            indices.extend_from_slice(&groups.row_order[groups.offsets[group]..groups.offsets[group + 1]]);
        }
        out.push(indices);
    }
    Ok(out)
}

fn local_basis(indices: &[usize], basis: &[Vec<f64>], budget: &mut Budget) -> Result<Vec<Vec<f64>>, Error> {
    // At most seven candidate residual Vecs are requested, cumulatively, even when
    // local rank pruning discards one. Check each actual allocation separately.
    let mut storage = [vector_bytes::<f64>(indices.len()); MAX_MODES + 1];
    storage[0] = vector_bytes::<Vec<f64>>(basis.len());
    budget.allocations(&storage[..=basis.len()], 0)?;
    let mut q: Vec<Vec<f64>> = Vec::with_capacity(basis.len());
    for vector in basis {
        let mut v = indices.iter().map(|&i| vector[i]).collect::<Vec<_>>();
        let original = norm(&v);
        for _ in 0..2 {
            for col in &q {
                let dot = v.iter().zip(col).map(|(v, q)| v * q).sum::<f64>();
                for (v, q) in v.iter_mut().zip(col) {
                    *v -= dot * q;
                }
            }
        }
        let remaining = norm(&v);
        if original > 0.0 && remaining > RANK_TOL * original {
            for v in &mut v {
                *v /= remaining;
            }
            q.push(v);
        }
    }
    if q.is_empty() {
        return Err(stalled("an aggregate has no representable near-space candidate"));
    }
    Ok(q)
}

struct Tentative {
    matrix: RectCsr,
    coarse_basis: Vec<Vec<f64>>,
    coarse_groups: Vec<u32>,
}

/// The caller owns and admits the empty output-column headers with level metadata;
/// all growing column payloads remain admitted here before each allocation.
fn tentative(
    n: usize,
    aggregates: &[Vec<usize>],
    basis: &[Vec<f64>],
    mut coarse_basis: Vec<Vec<f64>>,
    budget: &mut Budget,
) -> Result<Tentative, Error> {
    let mut coarse_groups = Vec::new();
    let mut triplets: Vec<(u32, u32, f64)> = Vec::new();
    let mut coarse_n = 0;
    for (group, indices) in aggregates.iter().enumerate() {
        let q = local_basis(indices, basis, budget)?;
        budget.room(&mut coarse_groups, q.len())?;
        for column in &mut coarse_basis {
            budget.room(column, q.len())?;
        }
        for (j, col) in q.iter().enumerate() {
            coarse_groups.push(group as u32);
            for (out, original) in coarse_basis.iter_mut().zip(basis) {
                out.push(indices.iter().zip(col).map(|(&row, q)| q * original[row]).sum());
            }
            for (&row, &value) in indices.iter().zip(col) {
                if value != 0.0 {
                    budget.entries(1, Entries::Interpolation)?;
                    budget.room(&mut triplets, 1)?;
                    triplets.push((row as u32, (coarse_n + j) as u32, value));
                }
            }
        }
        coarse_n += q.len();
    }
    triplets.sort_unstable_by_key(|&(row, col, _)| (row, col));
    budget.allocations(
        &[vector_bytes::<u32>(n + 1), vector_bytes::<u32>(triplets.len()), vector_bytes::<f64>(triplets.len())],
        0,
    )?;
    let mut t = RectCsr {
        n_rows: n,
        n_cols: coarse_n,
        row_ptr: vec![0; n + 1],
        col_idx: Vec::with_capacity(triplets.len()),
        vals: Vec::with_capacity(triplets.len()),
    };
    for (row, col, value) in triplets {
        t.row_ptr[row as usize + 1] += 1;
        t.col_idx.push(col);
        t.vals.push(value);
    }
    for row in 0..n {
        t.row_ptr[row + 1] += t.row_ptr[row];
        if t.row_ptr[row + 1] == t.row_ptr[row] {
            return Err(stalled("near-space scaling lost a row of tentative interpolation"));
        }
    }
    Ok(Tentative { matrix: t, coarse_basis, coarse_groups })
}

/// Only the three sparse row operations used during setup. Each numerical row always sums
/// the same source entries in the same order, independent of which worker evaluates it.
#[derive(Clone, Copy)]
enum RowOp<'a> {
    Product { a: Matrix<'a>, b: &'a RectCsr },
    Smooth { a: Matrix<'a>, t: &'a RectCsr, diag: &'a [f64], omega: f64 },
    Symmetric { a: &'a RectCsr, transpose: &'a RectCsr },
}

impl RowOp<'_> {
    fn operation(self) -> &'static str {
        match self {
            Self::Product { .. } => "product",
            Self::Smooth { .. } => "smooth-interpolation",
            Self::Symmetric { .. } => "symmetrize",
        }
    }
    fn shape(self) -> (usize, usize) {
        match self {
            Self::Product { a, b } => (a.n_rows, b.n_cols),
            Self::Smooth { a, t, .. } => (a.n_rows, t.n_cols),
            Self::Symmetric { a, .. } => (a.n_rows, a.n_cols),
        }
    }
    /// Symbolic upper bound on distinct map keys, capped before summation can overflow.
    fn row_bound(self, row: usize) -> usize {
        match self {
            Self::Product { a, b } | Self::Smooth { a, t: b, .. } => {
                let mut count = match self {
                    Self::Smooth { .. } => (b.row_ptr[row + 1] - b.row_ptr[row]) as usize,
                    _ => 0,
                };
                for e in a.row(row) {
                    let middle = a.col_idx[e] as usize;
                    count = count.saturating_add((b.row_ptr[middle + 1] - b.row_ptr[middle]) as usize).min(b.n_cols);
                }
                count
            }
            Self::Symmetric { a, transpose } => ((a.row_ptr[row + 1] - a.row_ptr[row]) as usize)
                .saturating_add((transpose.row_ptr[row + 1] - transpose.row_ptr[row]) as usize)
                .min(a.n_cols),
        }
    }
    fn row(self, row: usize) -> BTreeMap<u32, f64> {
        let mut out = BTreeMap::new();
        match self {
            Self::Product { a, b } => {
                for e in a.row(row) {
                    let middle = a.col_idx[e] as usize;
                    for f in b.row_ptr[middle] as usize..b.row_ptr[middle + 1] as usize {
                        add_value(&mut out, b.col_idx[f], a.vals[e] * b.vals[f]);
                    }
                }
            }
            Self::Smooth { a, t, diag, omega } => {
                for e in t.row_ptr[row] as usize..t.row_ptr[row + 1] as usize {
                    add_value(&mut out, t.col_idx[e], t.vals[e]);
                }
                let factor = -(omega / diag[row]);
                for e in a.row(row) {
                    let middle = a.col_idx[e] as usize;
                    let coefficient = factor * a.vals[e];
                    for f in t.row_ptr[middle] as usize..t.row_ptr[middle + 1] as usize {
                        add_value(&mut out, t.col_idx[f], coefficient * t.vals[f]);
                    }
                }
            }
            Self::Symmetric { a, transpose } => {
                for matrix in [a, transpose] {
                    for e in matrix.row_ptr[row] as usize..matrix.row_ptr[row + 1] as usize {
                        add_value(&mut out, matrix.col_idx[e], 0.5 * matrix.vals[e]);
                    }
                }
            }
        }
        out
    }
}

// Equivalent to n*slot/4, without overflowing usize on wasm32.
fn rows(n: usize, slot: usize) -> std::ops::Range<usize> {
    let at = |index| n / ROW_PARTITIONS * index + (n % ROW_PARTITIONS) * index / ROW_PARTITIONS;
    at(slot)..at(slot + 1)
}

struct OutputSpan<'a> {
    op: &'a RowOp<'a>,
    row_ptr: &'a [u32],
    first_row: usize,
    global_nnz_offset: usize,
    col_idx: &'a mut [u32],
    vals: &'a mut [f64],
}

fn fill_sparse_span(_: usize, spans: &mut [OutputSpan<'_>]) {
    for span in spans {
        for (local_row, pair) in span.row_ptr.windows(2).enumerate() {
            let mut slot = pair[0] as usize - span.global_nnz_offset;
            for (col, value) in span.op.row(span.first_row + local_row) {
                if value != 0.0 {
                    span.col_idx[slot] = col;
                    span.vals[slot] = value;
                    slot += 1;
                }
            }
        }
    }
}

/// Four fixed partitions, with a count pass followed by exactly the same numerical fill.
/// Every map envelope and count array is admitted before parallel work. Exact output fill,
/// one final CSR and four disjoint borrowed spans are admitted before the second pass.
fn sparse_rows(op: RowOp<'_>, kind: Entries, budget: &mut Budget) -> Result<RectCsr, Error> {
    let (n_rows, n_cols) = op.shape();
    let mut scratch = 0u128;
    for slot in 0..ROW_PARTITIONS {
        let bound = rows(n_rows, slot).map(|row| op.row_bound(row)).max().unwrap_or(0);
        scratch += (bound as u128 + 1) * MAP_ENTRY_BYTES as u128;
    }
    let context =
        AdmissionContext { operation: op.operation(), stage: "symbolic-count", rows: n_rows, cols: n_cols, nnz: None };
    budget.allocations_in(
        Some(context),
        &[vector_bytes::<usize>(n_rows), vector_bytes::<Vec<usize>>(ROW_PARTITIONS)],
        scratch,
    )?;
    let counts = par::map_collect(ROW_PARTITIONS, |slot| {
        let range = rows(n_rows, slot);
        let mut out = Vec::with_capacity(range.len());
        for row in range {
            let values = op.row(row);
            out.push(values.values().filter(|&&v| v != 0.0).count());
        }
        out
    });
    let nnz = counts.iter().flatten().map(|&count| count as u128).sum();
    let nnz = budget.entries(nnz, kind)?;
    // All dimensions are <=root n. Native n<=u32MAX; wasm scale:&[f64] gives
    // n<=isizeMAX/8, so n_rows+4 and n_rows+1 fit usize without a second overflow arm.
    // OutputSpan has the same nine pointer words as the former three-Vec blocks.
    // Borrowing the final output avoids their duplicate row/index/value payloads.
    budget.allocations_in(
        Some(AdmissionContext { stage: "final-csr", nnz: Some(nnz), ..context }),
        &[
            vector_bytes::<OutputSpan<'_>>(ROW_PARTITIONS),
            vector_bytes::<u32>(n_rows + 1),
            vector_bytes::<u32>(nnz),
            vector_bytes::<f64>(nnz),
        ],
        0,
    )?;
    let mut out = RectCsr {
        n_rows,
        n_cols,
        row_ptr: Vec::with_capacity(n_rows + 1),
        col_idx: vec![0; nnz],
        vals: vec![0.0; nnz],
    };
    out.row_ptr.push(0);
    let mut offset = 0u32;
    for &count in counts.iter().flatten() {
        offset += count as u32;
        out.row_ptr.push(offset);
    }
    let mut spans = Vec::with_capacity(ROW_PARTITIONS);
    let mut col_tail = out.col_idx.as_mut_slice();
    let mut value_tail = out.vals.as_mut_slice();
    for (slot, partition_counts) in counts.iter().enumerate() {
        let range = rows(n_rows, slot);
        let partition_nnz = partition_counts.iter().sum();
        let (col_idx, rest) = std::mem::take(&mut col_tail).split_at_mut(partition_nnz);
        col_tail = rest;
        let (vals, rest) = std::mem::take(&mut value_tail).split_at_mut(partition_nnz);
        value_tail = rest;
        spans.push(OutputSpan {
            op: &op,
            // Keep global offsets but limit iteration to this partition plus its
            // sentinel. An empty partition has one offset and no writable values.
            row_ptr: &out.row_ptr[range.start..=range.end],
            first_row: range.start,
            global_nnz_offset: out.row_ptr[range.start] as usize,
            col_idx,
            vals,
        });
    }
    // Count and fill use identical pure row arithmetic on immutable operands, so
    // every prefix interval is filled exactly once. Safe splits establish that
    // workers cannot overlap; fixed partitions preserve the original row order.
    par::for_each_chunk_mut(&mut spans, 1, fill_sparse_span as fn(usize, &mut [OutputSpan<'_>]));
    drop(spans);
    budget.bytes -= scratch;
    Ok(out)
}

fn multiply(a: Matrix<'_>, b: &RectCsr, kind: Entries, budget: &mut Budget) -> Result<RectCsr, Error> {
    // Only galerkin calls this: A(n,n)*P(n,m), then PT(m,n)*AP(n,m). Dimensions
    // originate together from tentative interpolation and its actual transpose.
    sparse_rows(RowOp::Product { a, b }, kind, budget)
}

fn smooth_interpolation(
    a: Matrix<'_>,
    t: &RectCsr,
    diag: &[f64],
    omega: f64,
    budget: &mut Budget,
) -> Result<RectCsr, Error> {
    sparse_rows(RowOp::Smooth { a, t, diag, omega }, Entries::Interpolation, budget)
}

/// A consumed AP is no longer an input after raw=PT*AP. Its current Vec lengths
/// are the exact originally charged requests, not allocator capacity. Reusing their
/// prefixes avoids genuinely new allocations; every old charge remains in Budget.
fn transpose(a: &RectCsr, kind: Entries, budget: &mut Budget, retired_ap: Option<RectCsr>) -> Result<RectCsr, Error> {
    budget.entries(a.vals.len() as u128, kind)?;
    let mut out = match retired_ap {
        Some(ap) => ap,
        None => RectCsr { n_rows: 0, n_cols: 0, row_ptr: Vec::new(), col_idx: Vec::new(), vals: Vec::new() },
    };
    let reuse_rows = out.row_ptr.len() > a.n_cols;
    let reuse_columns = out.col_idx.len() >= a.col_idx.len();
    let reuse_values = out.vals.len() >= a.vals.len();
    budget.allocations_in(
        Some(AdmissionContext {
            operation: "transpose",
            stage: "output-and-cursor",
            rows: a.n_cols,
            cols: a.n_rows,
            nnz: Some(a.vals.len()),
        }),
        &[
            if reuse_rows { 0 } else { vector_bytes::<u32>(a.n_cols + 1) },
            if reuse_columns { 0 } else { vector_bytes::<u32>(a.col_idx.len()) },
            if reuse_values { 0 } else { vector_bytes::<f64>(a.vals.len()) },
            vector_bytes::<u32>(a.n_cols),
        ],
        0,
    )?;
    // Admission covers all new buffers before any mutation/allocation. On a miss,
    // RHS allocation completes before assignment drops the old buffer: full old/new
    // overlap stays charged. Never use reserve's growth delta or Vec.capacity().
    if reuse_rows {
        out.row_ptr.truncate(a.n_cols + 1);
        out.row_ptr.fill(0);
    } else {
        out.row_ptr = vec![0; a.n_cols + 1];
    }
    if reuse_columns {
        out.col_idx.truncate(a.col_idx.len());
    } else {
        out.col_idx = vec![0; a.col_idx.len()];
    }
    if reuse_values {
        out.vals.truncate(a.vals.len());
    } else {
        out.vals = vec![0.0; a.vals.len()];
    }
    out.n_rows = a.n_cols;
    out.n_cols = a.n_rows;
    for &col in &a.col_idx {
        out.row_ptr[col as usize + 1] += 1;
    }
    for row in 0..out.n_rows {
        out.row_ptr[row + 1] += out.row_ptr[row];
    }
    let mut cursor = out.row_ptr[..out.n_rows].to_vec();
    for row in 0..a.n_rows {
        for e in a.row_ptr[row] as usize..a.row_ptr[row + 1] as usize {
            let col = a.col_idx[e] as usize;
            let slot = cursor[col] as usize;
            out.col_idx[slot] = row as u32;
            out.vals[slot] = a.vals[e];
            cursor[col] += 1;
        }
    }
    Ok(out)
}

fn galerkin(a: Matrix<'_>, p: &RectCsr, pt: &RectCsr, budget: &mut Budget) -> Result<Csr, Error> {
    let ap = multiply(a, p, Entries::Operator, budget)?;
    let raw = multiply(Matrix::rect(pt), &ap, Entries::Operator, budget)?;
    let transposed = transpose(&raw, Entries::Operator, budget, Some(ap))?;
    let symmetric = sparse_rows(RowOp::Symmetric { a: &raw, transpose: &transposed }, Entries::Operator, budget)?;
    Ok(Csr { n: symmetric.n_rows, row_ptr: symmetric.row_ptr, col_idx: symmetric.col_idx, vals: symmetric.vals })
}

fn coarse(a: Matrix<'_>, budget: &mut Budget) -> Result<Plan, Error> {
    let n = a.n_rows;
    // level() reaches this factorization only for n <= COARSE_ROWS (96).
    let count = n * n;
    budget.allocations(&[vector_bytes::<f64>(count), vector_bytes::<f64>(count)], 0)?;
    let mut l = vec![0.0; count];
    let mut c = vec![0.0; count];
    for row in 0..n {
        for e in a.row(row) {
            l[row * n + a.col_idx[e] as usize] = a.vals[e];
        }
    }
    for i in 0..n {
        for j in 0..=i {
            let mut value = l[i * n + j];
            for k in 0..j {
                value -= l[i * n + k] * l[j * n + k];
            }
            l[i * n + j] = if i == j {
                if !value.is_finite() || value <= 0.0 {
                    return Err(stalled("the bounded coarse Cholesky factor has a nonpositive or nonfinite pivot"));
                }
                value.sqrt()
            } else {
                value / l[j * n + j]
            };
        }
    }
    for col in 0..n {
        for row in col..n {
            let mut value = if row == col { 1.0 } else { 0.0 };
            for k in col..row {
                value -= l[row * n + k] * c[k * n + col];
            }
            let value = value / l[row * n + row];
            if !value.is_finite() {
                return Err(stalled("the bounded inverse Cholesky factor is nonfinite"));
            }
            c[row * n + col] = value;
        }
    }
    Ok(Plan::Coarse { n, c })
}

fn level(
    a: Matrix<'_>,
    basis: &[Vec<f64>],
    node_of_row: &[u32],
    depth: usize,
    budget: &mut Budget,
) -> Result<Plan, Error> {
    if depth >= budget.limits.max_levels {
        return Err(too_large("level"));
    }
    let fine = uses_candidates(a.n_rows);
    let columns = if fine { basis.len() } else { 0 };
    // Fine levels own these output headers even before constructing their values.
    // A direct coarse leaf neither admits nor allocates unused candidate columns.
    budget.allocations(&[vector_bytes::<Plan>(1), vector_bytes::<Vec<f64>>(columns)], 0)?;
    if !fine {
        return coarse(a, budget);
    }
    let (diag, high, uploaded_high) = diagonal(a, budget)?;
    let groups = groups(node_of_row, budget)?;
    let aggregates = aggregates(a, &groups, budget)?;
    let Tentative { matrix: t, coarse_basis, coarse_groups } =
        tentative(a.n_rows, &aggregates, basis, vec![Vec::new(); columns], budget)?;
    let p = smooth_interpolation(a, &t, &diag, 0.8 / high, budget)?;
    let pt = transpose(&p, Entries::Interpolation, budget, None)?;
    let coarse_operator = galerkin(a, &p, &pt, budget)?;
    let next = level(
        Matrix::square(&coarse_operator, &coarse_operator.vals),
        &coarse_basis,
        &coarse_groups,
        depth + 1,
        budget,
    )?;
    let low = 0.1 * uploaded_high;
    let mut weights = [0.0; 4];
    for (j, weight) in weights.iter_mut().enumerate() {
        let root = 0.5 * uploaded_high
            + 0.5 * low
            + 0.5 * (uploaded_high - low) * libm::cos(std::f64::consts::PI * (2 * j + 1) as f64 / 8.0);
        *weight = 1.0 / root;
    }
    Ok(Plan::Fine { n: a.n_rows, diag, weights, p, pt, coarse_operator, next: Box::new(next) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits() -> Limits {
        Limits { max_levels: 10, max_bytes: 64 << 20, max_interpolation_nnz: 100_000, max_operator_nnz: 1_000_000 }
    }

    fn poisson(n: usize) -> Csr {
        let mut row_ptr = vec![0];
        let mut col_idx = Vec::new();
        let mut vals = Vec::new();
        for row in 0..n {
            for col in row.saturating_sub(1)..=(row + 1).min(n - 1) {
                col_idx.push(col as u32);
                vals.push(if row == col { 2.0 } else { -1.0 });
            }
            row_ptr.push(vals.len() as u32);
        }
        Csr { n, row_ptr, col_idx, vals }
    }

    fn rect_mv(a: &RectCsr, x: &[f64]) -> Vec<f64> {
        (0..a.n_rows)
            .map(|r| {
                (a.row_ptr[r] as usize..a.row_ptr[r + 1] as usize).map(|e| a.vals[e] * x[a.col_idx[e] as usize]).sum()
            })
            .collect()
    }

    #[test]
    fn coarse_factor_and_fine_galerkin_match_independent_oracles() {
        // Both variants arise from real setup. Exhaustive matching exercises both
        // analytical checks without an impossible opposite-variant test branch.
        for rows in [2, 127] {
            let a = poisson(rows);
            let plan = build(&a, &a.vals, &vec![1.0; rows], None, limits()).unwrap();
            match plan {
                Plan::Coarse { n, c } => {
                    assert_eq!(n, 2);
                    let x = [c[0] * c[0] + c[2] * c[2], c[3] * c[2]];
                    assert!((x[0] - 2.0 / 3.0).abs() < 1e-15);
                    assert!((x[1] - 1.0 / 3.0).abs() < 1e-15);
                    assert_eq!(c[1], 0.0);
                }
                Plan::Fine { n, diag, weights, p, pt, coarse_operator, .. } => {
                    assert_eq!(n, a.n);
                    assert!(coarse_operator.n < a.n);
                    assert_eq!(diag, vec![2.0; a.n]);
                    assert!(weights.iter().all(|w| w.is_finite() && *w > 0.0));
                    let y = (0..p.n_cols).map(|i| libm::sin((i + 1) as f64)).collect::<Vec<_>>();
                    let py = rect_mv(&p, &y);
                    let mut apy = vec![0.0; a.n];
                    a.spmv(&py, &mut apy);
                    let ptapy = rect_mv(&pt, &apy);
                    let mut acy = vec![0.0; y.len()];
                    coarse_operator.spmv(&y, &mut acy);
                    for (&left, &right) in ptapy.iter().zip(&acy) {
                        assert!((left - right).abs() < 1e-13);
                    }
                    let fine_energy = py.iter().zip(&apy).map(|(x, y)| x * y).sum::<f64>();
                    let coarse_energy = y.iter().zip(&acy).map(|(x, y)| x * y).sum::<f64>();
                    assert!(fine_energy > 0.0);
                    assert!((fine_energy - coarse_energy).abs() < 1e-13);
                }
            }
        }
    }

    #[test]
    fn aggregate_local_qr_prunes_dependencies_and_reproduces_affine_candidates() {
        let basis = vec![vec![1.0; 8], vec![2.0; 8], (0..8).map(|i| i as f64).collect()];
        let mut budget = Budget { limits: limits(), bytes: 0, interpolation_nnz: 0, operator_nnz: 0 };
        budget.vector::<Vec<f64>>(basis.len()).unwrap();
        let columns = vec![Vec::new(); basis.len()];
        let Tentative { matrix: t, coarse_basis: coarse, .. } =
            tentative(8, &[vec![7, 2, 0, 6, 1, 3, 5, 4]], &basis, columns, &mut budget).unwrap();
        assert_eq!(t.n_cols, 2);
        for (original, reduced) in basis.iter().zip(&coarse) {
            let reproduced = rect_mv(&t, reduced);
            for (&left, &right) in reproduced.iter().zip(original) {
                assert!((left - right).abs() < 1e-13);
            }
        }
    }

    #[test]
    fn each_explicit_admission_bound_refuses_setup() {
        let a = poisson(127);
        let controls = [
            Limits { max_levels: 0, ..limits() },
            Limits { max_levels: 1, ..limits() },
            Limits { max_bytes: 0, ..limits() },
            Limits { max_interpolation_nnz: 0, ..limits() },
            Limits { max_operator_nnz: 0, ..limits() },
        ];
        for limit in controls {
            assert_eq!(build(&a, &a.vals, &vec![1.0; a.n], None, limit).unwrap_err().code, ErrorCode::SolveTooLarge);
        }
    }

    #[test]
    fn physical_candidates_keep_partial_node_groups_and_global_scaling_is_irrelevant() {
        let a = poisson(257);
        let scale = (0..a.n).map(|row| 2.0f64.powi((row % 3) as i32)).collect::<Vec<_>>();
        let node_of_row = (0..a.n)
            .map(|row| {
                if row < 2 {
                    10
                } else if row == 2 {
                    20
                } else {
                    30 + ((row - 3) / 3) as u32
                }
            })
            .collect();
        let mode = (0..a.n).map(|row| row as f64 / a.n as f64).collect::<Vec<_>>();
        let space = NearSpace {
            node_of_row,
            modes: vec![mode.clone(), mode.iter().map(|v| 2.0 * v).collect(), vec![0.0; a.n]],
        };
        let first = build(&a, &a.vals, &scale, Some(&space), limits()).unwrap();
        let second =
            build(&a, &a.vals, &scale.iter().map(|s| 2.0 * s).collect::<Vec<_>>(), Some(&space), limits()).unwrap();
        assert_eq!(first, second);
        let renamed = NearSpace {
            node_of_row: space.node_of_row.iter().map(|node| node * 7 + 3).collect(),
            modes: space.modes.clone(),
        };
        assert_eq!(first, build(&a, &a.vals, &scale, Some(&renamed), limits()).unwrap());
    }

    #[test]
    fn raw_block_strength_selects_the_strongest_frontier_and_disconnected_ids_are_stable() {
        let n = 12;
        for strong in [11, 1] {
            let weak = 12 - strong;
            let mut a = Csr { n, row_ptr: vec![0], col_idx: Vec::new(), vals: Vec::new() };
            // Symmetric strict diagonal dominance (8 > 2 + 0.5) proves SPD.
            // Store the zero 0<->5 edge explicitly: it must never seed a frontier.
            for row in 0..n {
                for col in 0..n {
                    let value = if row == col {
                        8.0
                    } else if (row == 0 && col == strong) || (row == strong && col == 0) {
                        2.0
                    } else if (row == 0 && col == weak) || (row == weak && col == 0) {
                        0.5
                    } else {
                        0.0
                    };
                    if value != 0.0 || (row == 0 && col == 5) || (row == 5 && col == 0) {
                        a.col_idx.push(col as u32);
                        a.vals.push(value);
                    }
                }
                a.row_ptr.push(a.vals.len() as u32);
            }
            let mut budget = Budget { limits: limits(), bytes: 0, interpolation_nnz: 0, operator_nnz: 0 };
            let grouping = groups(&(0..n as u32).collect::<Vec<_>>(), &mut budget).unwrap();
            let actual = aggregates(Matrix::square(&a, &a.vals), &grouping, &mut budget).unwrap();
            // Positive strength wins, then the remaining positive neighbor. Zero
            // strength cannot move node5 before the stable disconnected node2.
            assert_eq!(actual, [vec![0, strong, weak, 2, 3, 4, 5, 6], vec![7, 8, 9, 10]]);
        }
    }

    #[test]
    fn chebyshev_bound_covers_the_actual_rounded_matrix_and_inverse_diagonal() {
        let a = Csr { n: 2, row_ptr: vec![0, 2, 4], col_idx: vec![0, 1, 0, 1], vals: vec![1.0, 0.6, 0.6, 1.0] };
        let mut budget = Budget { limits: limits(), bytes: 0, interpolation_nnz: 0, operator_nnz: 0 };
        let (diag, original, uploaded) = diagonal(Matrix::square(&a, &a.vals), &mut budget).unwrap();
        assert_eq!(diag, [1.0, 1.0]);
        assert!(original >= 1.6);
        assert!(uploaded >= 1.0 + 0.6f32 as f64);
        assert!(uploaded > original);
    }

    #[test]
    fn a_subnormal_uploaded_inverse_diagonal_is_refused_before_device_smoothing() {
        let d = 1e38;
        let inverse = (1.0 / d) as f32;
        assert!(inverse > 0.0 && inverse.is_subnormal());
        let a = Csr { n: 1, row_ptr: vec![0, 1], col_idx: vec![0], vals: vec![d] };
        let mut budget = Budget { limits: limits(), bytes: 0, interpolation_nnz: 0, operator_nnz: 0 };
        let error = diagonal(Matrix::square(&a, &a.vals), &mut budget).unwrap_err();
        assert_eq!(error.code, ErrorCode::SolveStalled);
        assert!(error.cause.contains("positive normal f32 inverse diagonal"));
    }

    #[test]
    fn diagonal_strategy_ignores_stored_signed_zeros_but_detects_either_triangle() {
        let mut a = Csr { n: 2, row_ptr: vec![0, 2, 4], col_idx: vec![0, 1, 0, 1], vals: vec![2.0, 0.0, -0.0, 8.0] };
        assert!(!needs_aggregation(&a));
        a.vals[1] = 0.25;
        assert!(needs_aggregation(&a));
        a.vals[1] = 0.0;
        a.vals[2] = -0.25;
        assert!(needs_aggregation(&a));
        let diagonal_only = Csr { n: 2, row_ptr: vec![0, 1, 2], col_idx: vec![0, 1], vals: vec![2.0, 8.0] };
        assert!(!needs_aggregation(&diagonal_only));
    }

    #[test]
    fn numerical_failures_do_not_claim_the_original_model_is_indefinite() {
        let indefinite =
            Csr { n: 2, row_ptr: vec![0, 2, 4], col_idx: vec![0, 1, 0, 1], vals: vec![1.0, 2.0, 2.0, 1.0] };
        assert_eq!(
            build(&indefinite, &indefinite.vals, &[1.0; 2], None, limits()).unwrap_err().code,
            ErrorCode::SolveStalled
        );
        let a = poisson(127);
        let mut overflow = vec![1.0; a.n];
        overflow[0] = f64::MIN_POSITIVE / 8.0;
        assert_eq!(build(&a, &a.vals, &overflow, None, limits()).unwrap_err().code, ErrorCode::SolveStalled);
        let mut lost_row = vec![1e-308; a.n];
        lost_row[0] = 1e308;
        assert_eq!(build(&a, &a.vals, &lost_row, None, limits()).unwrap_err().code, ErrorCode::SolveStalled);
    }

    #[test]
    fn candidate_underflow_and_missing_positive_diagonal_fail_before_upload() {
        let a = poisson(127);
        let mut scale = vec![1e-308; a.n];
        scale[..8].fill(1e308);
        // The first full eight-row aggregate becomes exactly zero when the root
        // candidates are normalized against the rest, rather than losing one T row.
        let error = build(&a, &a.vals, &scale, None, limits()).unwrap_err();
        assert_eq!(error.code, ErrorCode::SolveStalled);
        assert!(error.cause.contains("no representable near-space candidate"));
        let mut zero_diagonal = a.clone();
        zero_diagonal.vals[0] = 0.0;
        let error = build(&zero_diagonal, &zero_diagonal.vals, &vec![1.0; a.n], None, limits()).unwrap_err();
        assert_eq!(error.code, ErrorCode::SolveStalled);
        assert!(error.cause.contains("nonpositive diagonal"));
    }

    #[test]
    fn an_exact_positive_cholesky_can_have_an_unrepresentable_inverse_factor() {
        // A=L Lᵀ exactly, where L has diagonal2^-26 and first subdiagonal1.
        // Every pivot is positive2^-52, proving SPD independently of the setup.
        // C[row,0]=(-1)^row 2^(26(row+1)): row38 is finite; row39 overflows.
        let eps = 2.0f64.powi(-26);
        let mut a = poisson(40);
        for row in 0..a.n {
            for e in a.row_ptr[row] as usize..a.row_ptr[row + 1] as usize {
                a.vals[e] = if a.col_idx[e] as usize == row {
                    if row == 0 {
                        eps * eps
                    } else {
                        1.0 + eps * eps
                    }
                } else {
                    eps
                };
            }
        }
        assert!(2.0f64.powi(26 * 39).is_finite());
        assert!(2.0f64.powi(26 * 40).is_infinite());
        let error = build(&a, &a.vals, &vec![1.0; a.n], None, limits()).unwrap_err();
        assert_eq!(error.code, ErrorCode::SolveStalled);
        assert!(error.cause.contains("inverse Cholesky factor is nonfinite"));
    }

    #[test]
    fn malformed_input_is_rejected_before_indexing_or_candidate_allocation() {
        let a = poisson(2);
        assert_eq!(build(&a, &a.vals, &[1.0], None, limits()).unwrap_err().code, ErrorCode::Schema);
        let space = NearSpace { node_of_row: vec![0, 1], modes: vec![vec![0.0]] };
        assert_eq!(build(&a, &a.vals, &[1.0; 2], Some(&space), limits()).unwrap_err().code, ErrorCode::Schema);
        let malformed = Csr { n: 2, row_ptr: vec![0, 3, 2], col_idx: vec![0, 1], vals: vec![1.0, 1.0] };
        assert_eq!(build(&malformed, &malformed.vals, &[1.0; 2], None, limits()).unwrap_err().code, ErrorCode::Schema);
        assert_eq!(build(&a, &[f64::NAN; 4], &[1.0; 2], None, limits()).unwrap_err().code, ErrorCode::Schema);
    }

    #[test]
    fn four_fixed_sparse_partitions_keep_the_entire_plan_exact_at_one_and_four_workers() {
        let a = poisson(511);
        let scale = vec![1.0; a.n];
        let one = par::Pool::new(1).install(|| build(&a, &a.vals, &scale, None, limits()).unwrap());
        let four = par::Pool::new(4).install(|| build(&a, &a.vals, &scale, None, limits()).unwrap());
        assert_eq!(one, four);
    }

    #[test]
    fn parallel_sparse_products_preserve_exact_dot_products_and_cancellation() {
        let a = Matrix { n_rows: 1, row_ptr: &[0, 2], col_idx: &[0, 1], vals: &[2.0, 3.0] };
        let b = RectCsr { n_rows: 2, n_cols: 1, row_ptr: vec![0, 1, 2], col_idx: vec![0, 0], vals: vec![5.0, 7.0] };
        let mut budget = Budget { limits: limits(), bytes: 0, interpolation_nnz: 0, operator_nnz: 0 };
        let product = multiply(a, &b, Entries::Operator, &mut budget).unwrap();
        assert_eq!(product.row_ptr, [0, 1]);
        assert_eq!(product.col_idx, [0]);
        assert_eq!(product.vals, [31.0]);
        let stored_zero = Matrix { vals: &[0.0, 3.0], ..a };
        let product = multiply(stored_zero, &b, Entries::Operator, &mut budget).unwrap();
        assert_eq!(product.vals, [21.0]);
        let opposite = RectCsr { vals: vec![3.0, -2.0], ..b };
        let zero = multiply(a, &opposite, Entries::Operator, &mut budget).unwrap();
        assert_eq!(zero.row_ptr, [0, 0]);
        assert!(zero.vals.is_empty());
    }

    #[test]
    fn final_sparse_output_fits_its_exact_storage_bound_with_empty_partitions() {
        // The single output row belongs to the last fixed partition. Three empty
        // partitions retain only their prefix sentinel. Independent scalar answers
        // are 2*5+3*7=31 and 2*3+3*(-2)=0, requiring one and zero stored entries.
        let a = Matrix { n_rows: 1, row_ptr: &[0, 2], col_idx: &[0, 1], vals: &[2.0, 3.0] };
        for (values, expected) in [([5.0, 7.0], &[31.0][..]), ([3.0, -2.0], &[][..])] {
            let b =
                RectCsr { n_rows: 2, n_cols: 1, row_ptr: vec![0, 1, 2], col_idx: vec![0, 0], vals: values.to_vec() };
            // Each of three empty partitions reserves one map root, and the
            // active partition reserves a root plus its single possible column.
            // Admit counts, four borrowed span headers and exactly one final CSR.
            let exact = 5 * MAP_ENTRY_BYTES
                + size_of::<usize>()
                + ROW_PARTITIONS * size_of::<Vec<usize>>()
                + ROW_PARTITIONS * size_of::<OutputSpan<'_>>()
                + 2 * size_of::<u32>()
                + expected.len() * (size_of::<u32>() + size_of::<f64>());
            let mut admitted = Budget {
                limits: Limits { max_bytes: exact, ..limits() },
                bytes: 0,
                interpolation_nnz: 0,
                operator_nnz: 0,
            };
            let product = multiply(a, &b, Entries::Operator, &mut admitted).unwrap();
            assert_eq!(product.row_ptr, [0, expected.len() as u32]);
            assert_eq!(product.vals, expected);
            assert_eq!(product.col_idx, vec![0; expected.len()]);
            let mut refused = Budget {
                limits: Limits { max_bytes: exact - 1, ..limits() },
                bytes: 0,
                interpolation_nnz: 0,
                operator_nnz: 0,
            };
            let error = multiply(a, &b, Entries::Operator, &mut refused).unwrap_err();
            assert_eq!(error.code, ErrorCode::SolveTooLarge);
            assert_eq!(error.where_.as_deref(), Some("solve/aggregation"));
            assert_eq!(requested_count(&error, Quota::Bytes, exact - 1), exact);
            let symbolic = 5 * MAP_ENTRY_BYTES + size_of::<usize>() + ROW_PARTITIONS * size_of::<Vec<usize>>();
            assert_eq!(refused.bytes, symbolic as u128);
            assert_eq!(
                error.cause.split_once("; admission ").unwrap().1,
                format!(
                    "operation=product stage=final-csr rows=1 cols=1 nnz=Some({}) previous_bytes={symbolic} vector_bytes={:?} scratch_bytes=0",
                    expected.len(),
                    [ROW_PARTITIONS * size_of::<OutputSpan<'_>>(), 2 * size_of::<u32>(), expected.len() * size_of::<u32>(), expected.len() * size_of::<f64>()],
                ),
            );
        }
    }

    #[test]
    fn symbolic_admission_reports_unknown_fill_and_the_exact_requested_batch() {
        let a = Matrix { n_rows: 1, row_ptr: &[0, 2], col_idx: &[0, 1], vals: &[2.0, 3.0] };
        let b = RectCsr { n_rows: 2, n_cols: 1, row_ptr: vec![0, 1, 2], col_idx: vec![0, 0], vals: vec![5.0, 7.0] };
        let exact = 5 * MAP_ENTRY_BYTES + size_of::<usize>() + ROW_PARTITIONS * size_of::<Vec<usize>>();
        let mut budget = Budget {
            limits: Limits { max_bytes: exact - 1, ..limits() },
            bytes: 0,
            interpolation_nnz: 0,
            operator_nnz: 0,
        };
        let error = multiply(a, &b, Entries::Operator, &mut budget).unwrap_err();
        assert_eq!(requested_count(&error, Quota::Bytes, exact - 1), exact);
        assert_eq!(budget.bytes, 0);
        assert_eq!(budget.operator_nnz, 0);
        assert_eq!(
            error.cause.split_once("; admission ").unwrap().1,
            format!(
                "operation=product stage=symbolic-count rows=1 cols=1 nnz=None previous_bytes=0 vector_bytes={:?} scratch_bytes={}",
                [size_of::<usize>(), ROW_PARTITIONS * size_of::<Vec<usize>>()], 5 * MAP_ENTRY_BYTES,
            ),
        );
        assert_eq!(
            error.suggestion.as_deref(),
            Some("solve.run { solver: 'cpu-direct' }, or a host with a larger admitted solve budget")
        );
    }

    #[test]
    fn exact_sparse_fill_is_refused_before_output_allocation() {
        let a = Matrix { n_rows: 1, row_ptr: &[0, 2], col_idx: &[0, 1], vals: &[2.0, 3.0] };
        let b = RectCsr { n_rows: 2, n_cols: 1, row_ptr: vec![0, 1, 2], col_idx: vec![0, 0], vals: vec![5.0, 7.0] };
        let mut budget = Budget {
            limits: Limits { max_operator_nnz: 0, ..limits() },
            bytes: 0,
            interpolation_nnz: 0,
            operator_nnz: 0,
        };
        assert_eq!(multiply(a, &b, Entries::Operator, &mut budget).unwrap_err().code, ErrorCode::SolveTooLarge);
        assert_eq!(budget.operator_nnz, 0);
    }

    #[test]
    fn coarse_workspace_and_later_interpolation_obey_actual_storage_caps() {
        let a = poisson(2);
        let exact = size_of::<Plan>() + 2 * 4 * size_of::<f64>();
        let plan = build(&a, &a.vals, &[1.0; 2], None, Limits { max_bytes: exact, ..limits() }).unwrap();
        assert_eq!(plan, build(&a, &a.vals, &[1.0; 2], None, limits()).unwrap());
        let error = build(&a, &a.vals, &[1.0; 2], None, Limits { max_bytes: exact - 1, ..limits() }).unwrap_err();
        assert_eq!(error.code, ErrorCode::SolveTooLarge);
        let a = poisson(127);
        // Constant-only tentative interpolation has exactly one entry per fine row.
        let error =
            build(&a, &a.vals, &vec![1.0; a.n], None, Limits { max_interpolation_nnz: a.n, ..limits() }).unwrap_err();
        assert_eq!(error.code, ErrorCode::SolveTooLarge);
        assert!(error.cause.contains("interpolation fill"));
    }

    #[test]
    fn a_real_vector_request_above_the_platform_allocation_ceiling_is_refused() {
        // An ordinary empty ledger, not a fabricated allocated Vec or near-overflow
        // accounting state. This is a legitimate impossible allocation request; no
        // allocation occurs because admission precedes Vec construction.
        let mut budget = Budget {
            limits: Limits { max_bytes: usize::MAX, ..limits() },
            bytes: 0,
            interpolation_nnz: 0,
            operator_nnz: 0,
        };
        let len = isize::MAX as usize / size_of::<f64>() + 1;
        assert_eq!(budget.vector::<f64>(len).unwrap_err().code, ErrorCode::SolveTooLarge);
        assert_eq!(budget.bytes, 0);
    }

    #[derive(Clone, Copy)]
    enum Quota {
        Bytes,
        Interpolation,
        Operator,
    }

    impl Quota {
        fn limits(self, cap: usize) -> Limits {
            match self {
                Self::Bytes => Limits { max_bytes: cap, ..limits() },
                Self::Interpolation => Limits { max_interpolation_nnz: cap, ..limits() },
                Self::Operator => Limits { max_operator_nnz: cap, ..limits() },
            }
        }

        fn units(self) -> &'static str {
            match self {
                Self::Bytes => "setup bytes",
                Self::Interpolation => "interpolation fill",
                Self::Operator => "operator fill",
            }
        }
    }

    fn requested_count(error: &Error, quota: Quota, cap: usize) -> usize {
        assert_eq!(error.code, ErrorCode::SolveTooLarge);
        assert_eq!(error.where_.as_deref(), Some("solve/aggregation"));
        let prefix = error.cause.split("; admission ").next().unwrap();
        let suffix = prefix.strip_prefix("aggregation setup requested ").unwrap();
        let (count, rest) = suffix.split_once(' ').unwrap();
        let (units, admitted) = rest.split_once("; admitted limit ").unwrap();
        assert_eq!(units, quota.units());
        assert_eq!(admitted.parse::<usize>().unwrap(), cap);
        let requested = count.parse::<usize>().unwrap();
        assert!(requested > cap);
        assert_eq!(prefix, format!("aggregation setup requested {requested} {}; admitted limit {cap}", quota.units()));
        requested
    }

    /// Check physics and transfer identities independently of the resource ledger.
    fn check_poisson_plan(plan: &Plan) {
        match plan {
            Plan::Coarse { n, c } => {
                assert_eq!(*n, 2);
                // The two Dirichlet springs have inverse (1/3)*[[2,1],[1,2]].
                let got = [c[0] * c[0] + c[2] * c[2], c[3] * c[2]];
                assert!((got[0] - 2.0 / 3.0).abs() < 1e-15);
                assert!((got[1] - 1.0 / 3.0).abs() < 1e-15);
            }
            Plan::Fine { n, p, pt, coarse_operator, .. } => {
                let coarse = (0..p.n_cols).map(|i| libm::sin((i + 1) as f64 * 0.31)).collect::<Vec<_>>();
                let fine = rect_mv(p, &coarse);
                // Dirichlet chain energy is endpoints squared plus every neighbor
                // difference squared, independent of CSR assembly or Galerkin code.
                let energy = fine[0] * fine[0]
                    + fine[*n - 1] * fine[*n - 1]
                    + fine.windows(2).map(|w| (w[1] - w[0]) * (w[1] - w[0])).sum::<f64>();
                let mut ac = vec![0.0; coarse.len()];
                coarse_operator.spmv(&coarse, &mut ac);
                let reduced_energy = coarse.iter().zip(ac).map(|(a, b)| a * b).sum::<f64>();
                assert!(energy > 0.0);
                assert!((energy - reduced_energy).abs() <= 1e-12 * energy.max(1.0));
                let probe = (0..*n).map(|i| libm::cos((i + 1) as f64 * 0.17)).collect::<Vec<_>>();
                let left = fine.iter().zip(&probe).map(|(a, b)| a * b).sum::<f64>();
                let restricted = rect_mv(pt, &probe);
                let right = coarse.iter().zip(restricted).map(|(a, b)| a * b).sum::<f64>();
                assert!((left - right).abs() <= 1e-12 * left.abs().max(right.abs()).max(1.0));
            }
        }
    }

    fn walk_quota(k: &Csr, space: Option<&NearSpace>, quota: Quota) -> Plan {
        let scale = vec![1.0; k.n];
        let mut cap = 0;
        let mut attempts = 0;
        let plan = loop {
            attempts += 1;
            assert!(attempts <= 512, "bounded admission walk for {} rows", k.n);
            match build(k, &k.vals, &scale, space, quota.limits(cap)) {
                Ok(plan) => break plan,
                Err(error) => cap = requested_count(&error, quota, cap),
            }
        };
        // A successful jump is an actual exact quota boundary, not merely a random
        // generous limit. Coarse fill-free cases legitimately succeed at zero.
        if cap > 0 {
            let error = build(k, &k.vals, &scale, space, quota.limits(cap - 1)).unwrap_err();
            requested_count(&error, quota, cap - 1);
        }
        check_poisson_plan(&plan);
        plan
    }

    fn partial_physical_space(rows: usize) -> NearSpace {
        use crate::model::Idealisation;
        use femlab_geometry::{ElementKind, Structured};
        // A real solid mesh, retaining ux/uy along its first straight 64-node edge.
        // Others are prescribed; the final retained node may have only ux. Each
        // node owns at most two of its three actual displacement coordinates.
        let mesh = Structured { kind: ElementKind::Hex8, n: [63, 1, 1] }.box_([2.0, 1.0, 1.0]);
        let free = (0..rows).map(|row| (3 * (row / 2) + row % 2) as u32).collect::<Vec<_>>();
        physical::PhysicalSpace { mesh: &mesh, idealisation: &Idealisation::Solid3d, free: &free, dofs_per_node: 3 }
            .materialize(physical::NEAR_SPACE_BYTES)
            .unwrap()
    }

    #[test]
    fn real_quota_boundaries_preserve_dirichlet_energy_and_transfer_duality() {
        for n in [2, 97, 127] {
            let k = poisson(n);
            let physical = partial_physical_space(n);
            for space in [None, Some(&physical)] {
                let generous = build(&k, &k.vals, &vec![1.0; n], space, limits()).unwrap();
                check_poisson_plan(&generous);
                for quota in [Quota::Bytes, Quota::Interpolation, Quota::Operator] {
                    let admitted = walk_quota(&k, space, quota);
                    // Secondary resource independence only: the preceding closed
                    // forms, energy and duality checks supply independent oracles.
                    assert_eq!(admitted, generous);
                }
            }
        }
    }

    #[test]
    fn requested_resource_diagnostics_report_stable_counts_and_units() {
        let k = poisson(2);
        let cap = size_of::<Plan>();
        let error = build(&k, &k.vals, &[1.0; 2], None, Limits { max_bytes: cap, ..limits() }).unwrap_err();
        assert_eq!(requested_count(&error, Quota::Bytes, cap), cap + 64);
        let k = poisson(97);
        let error =
            build(&k, &k.vals, &vec![1.0; k.n], None, Limits { max_interpolation_nnz: 0, ..limits() }).unwrap_err();
        assert_eq!(requested_count(&error, Quota::Interpolation, 0), 1);
    }

    #[test]
    fn retired_ap_buffers_transpose_a_gram_matrix_without_new_output_allocations() {
        // P has disjoint columns: PᵀI₄P=2I₂. AP's four-entry arrays can hold the
        // two-entry transpose, and its five row offsets can hold three offsets.
        let a = Csr { n: 4, row_ptr: vec![0, 1, 2, 3, 4], col_idx: vec![0, 1, 2, 3], vals: vec![1.0; 4] };
        let p = RectCsr {
            n_rows: 4,
            n_cols: 2,
            row_ptr: vec![0, 1, 2, 3, 4],
            col_idx: vec![0, 1, 0, 1],
            vals: vec![1.0; 4],
        };
        let mut budget = Budget { limits: limits(), bytes: 0, interpolation_nnz: 0, operator_nnz: 0 };
        let pt = transpose(&p, Entries::Interpolation, &mut budget, None).unwrap();
        let ap = multiply(Matrix::square(&a, &a.vals), &p, Entries::Operator, &mut budget).unwrap();
        let raw = multiply(Matrix::rect(&pt), &ap, Entries::Operator, &mut budget).unwrap();
        let row_pointer = ap.row_ptr.as_ptr();
        let column_pointer = ap.col_idx.as_ptr();
        let value_pointer = ap.vals.as_ptr();
        let previous = budget.bytes;
        let actual = transpose(&raw, Entries::Operator, &mut budget, Some(ap)).unwrap();
        assert_eq!(actual.row_ptr.as_ptr(), row_pointer);
        assert_eq!(actual.col_idx.as_ptr(), column_pointer);
        assert_eq!(actual.vals.as_ptr(), value_pointer);
        // Old charges remain intact; only the separate two-entry cursor is new.
        assert_eq!(budget.bytes, previous + (2 * size_of::<u32>()) as u128);
        assert_eq!(actual.row_ptr, [0, 1, 2]);
        assert_eq!(actual.col_idx, [0, 1]);
        assert_eq!(actual.vals, [2.0, 2.0]);
        assert_eq!(rect_mv(&actual, &[3.0, 4.0]), [6.0, 8.0]);
    }

    /// Valid same-flow Galerkin fixture, not a claim that SA builds P from I.
    /// P=[1ᵀ;I], so AP=P and PᵀP=I+11ᵀ. Both operators are SPD and every
    /// dimension/entry is small, finite and valid. All consumed AP payloads were
    /// allocated through this same ledger; there are no fabricated capacity credits.
    fn gram_transpose_with_retired_ap(m: usize, budget: &mut Budget) -> Result<RectCsr, Error> {
        let n = m + 1;
        let a = Csr { n, row_ptr: (0..=n as u32).collect(), col_idx: (0..n as u32).collect(), vals: vec![1.0; n] };
        let mut p = RectCsr {
            n_rows: n,
            n_cols: m,
            row_ptr: vec![0, m as u32],
            col_idx: (0..m as u32).collect(),
            vals: vec![1.0; m],
        };
        for row in 0..m {
            p.row_ptr.push((m + row + 1) as u32);
            p.col_idx.push(row as u32);
            p.vals.push(1.0);
        }
        let pt = transpose(&p, Entries::Interpolation, budget, None).unwrap();
        let ap = multiply(Matrix::square(&a, &a.vals), &p, Entries::Operator, budget).unwrap();
        let raw = multiply(Matrix::rect(&pt), &ap, Entries::Operator, budget).unwrap();
        assert_eq!(ap.vals.len(), 2 * m);
        assert_eq!(raw.vals.len(), m * m);
        let rows = ap.row_ptr.as_ptr();
        let columns = ap.col_idx.as_ptr();
        let values = ap.vals.as_ptr();
        let result = transpose(&raw, Entries::Operator, budget, Some(ap));
        if let Ok(actual) = &result {
            // Fresh complete entry arrays must coexist with the old arrays during
            // replacement; the reused row-pointer buffer must preserve identity.
            assert_eq!(actual.row_ptr.as_ptr(), rows);
            assert_ne!(actual.col_idx.as_ptr(), columns);
            assert_ne!(actual.vals.as_ptr(), values);
        }
        result
    }

    #[test]
    fn retired_ap_fallback_charges_full_replacements_at_the_real_exact_cap() {
        let m = 257;
        let n = m + 1;
        let span_headers = ROW_PARTITIONS * size_of::<OutputSpan<'_>>();
        let count_headers = ROW_PARTITIONS * size_of::<Vec<usize>>();
        let pt_bytes = 4 * (m + 1) + 12 * (2 * m) + 4 * m;
        let ap_count = n * size_of::<usize>() + count_headers;
        let ap_output = span_headers + 4 * (n + 1) + 12 * (2 * m);
        let raw_count = m * size_of::<usize>() + count_headers;
        let raw_output = span_headers + 4 * (m + 1) + 12 * (m * m);
        let previous = pt_bytes + ap_count + ap_output + raw_count + raw_output;
        let replacement = 12 * (m * m) + 4 * m;
        let exact = previous + replacement;
        // Real earlier peaks fit the limit supplied at the beginning. The large
        // dense Gram output makes final replacement the actual maximum; neither
        // budget mutation nor unrelated padding is needed to target this boundary.
        let ap_peak = pt_bytes + ap_count + ap_output + (m + 7) * MAP_ENTRY_BYTES;
        let raw_peak = previous + 4 * (m + 1) * MAP_ENTRY_BYTES;
        assert!(ap_peak < exact - 1);
        assert!(raw_peak < exact - 1);
        let mut results = Vec::new();
        for threads in [1, 4] {
            let actual = par::Pool::new(threads).install(|| {
                let mut budget = Budget {
                    limits: Limits { max_bytes: exact, ..limits() },
                    bytes: 0,
                    interpolation_nnz: 0,
                    operator_nnz: 0,
                };
                let actual = gram_transpose_with_retired_ap(m, &mut budget).unwrap();
                assert_eq!(budget.bytes, exact as u128);
                actual
            });
            // Independent Gram closed form and energy ||x||²+(Σx)², not a
            // second transpose or sparse product implementation.
            for row in 0..m {
                let lo = actual.row_ptr[row] as usize;
                let hi = actual.row_ptr[row + 1] as usize;
                assert_eq!(hi - lo, m);
                for (col, &value) in actual.vals[lo..hi].iter().enumerate() {
                    assert_eq!(actual.col_idx[lo + col], col as u32);
                    assert_eq!(value, if row == col { 2.0 } else { 1.0 });
                }
            }
            let x = (0..m).map(|i| libm::sin((i + 1) as f64 * 0.31)).collect::<Vec<_>>();
            let y = rect_mv(&actual, &x);
            let energy = x.iter().zip(y).map(|(x, y)| x * y).sum::<f64>();
            let sum = x.iter().sum::<f64>();
            let expected = x.iter().map(|x| x * x).sum::<f64>() + sum * sum;
            assert!((energy - expected).abs() <= 1e-12 * expected);
            results.push(actual);
        }
        assert_eq!(results[0], results[1]);
        let mut refused = Budget {
            limits: Limits { max_bytes: exact - 1, ..limits() },
            bytes: 0,
            interpolation_nnz: 0,
            operator_nnz: 0,
        };
        let error = gram_transpose_with_retired_ap(m, &mut refused).unwrap_err();
        assert_eq!(requested_count(&error, Quota::Bytes, exact - 1), exact);
        assert_eq!(refused.bytes, previous as u128);
        assert_eq!(
            error.cause.split_once("; admission ").unwrap().1,
            format!(
                "operation=transpose stage=output-and-cursor rows={m} cols={m} nnz=Some({}) previous_bytes={previous} vector_bytes={:?} scratch_bytes=0",
                m * m, [0, 4 * (m * m), 8 * (m * m), 4 * m],
            ),
        );
    }

    #[test]
    fn a_real_prolongation_transpose_admits_all_arrays_and_cursor_at_the_exact_byte_bound() {
        for rows in [2, 127] {
            let a = poisson(rows);
            let plan = build(&a, &a.vals, &vec![1.0; rows], None, limits()).unwrap();
            match &plan {
                Plan::Coarse { .. } => check_poisson_plan(&plan),
                Plan::Fine { p, pt, .. } => {
                    // Transpose needs row pointers, columns, values, and a separate
                    // cursor for every output row. All coexist before construction.
                    let exact = (p.n_cols + 1) * size_of::<u32>()
                        + p.col_idx.len() * size_of::<u32>()
                        + p.vals.len() * size_of::<f64>()
                        + p.n_cols * size_of::<u32>();
                    let mut admitted = Budget {
                        limits: Limits { max_bytes: exact, ..limits() },
                        bytes: 0,
                        interpolation_nnz: 0,
                        operator_nnz: 0,
                    };
                    let actual = transpose(p, Entries::Interpolation, &mut admitted, None).unwrap();
                    assert_eq!(admitted.bytes, exact as u128);
                    // Independent transfer duality, not a second transpose implementation.
                    let coarse = (0..p.n_cols).map(|i| libm::sin((i + 1) as f64 * 0.31)).collect::<Vec<_>>();
                    let fine = (0..p.n_rows).map(|i| libm::cos((i + 1) as f64 * 0.17)).collect::<Vec<_>>();
                    let prolongated = rect_mv(p, &coarse);
                    let restricted = rect_mv(&actual, &fine);
                    let left = fine.iter().zip(prolongated).map(|(x, y)| x * y).sum::<f64>();
                    let right = coarse.iter().zip(restricted).map(|(x, y)| x * y).sum::<f64>();
                    assert!((left - right).abs() <= 1e-13 * left.abs().max(right.abs()).max(1.0));
                    assert_eq!(&actual, pt);
                    let mut refused = Budget {
                        limits: Limits { max_bytes: exact - 1, ..limits() },
                        bytes: 0,
                        interpolation_nnz: 0,
                        operator_nnz: 0,
                    };
                    let error = transpose(p, Entries::Interpolation, &mut refused, None).unwrap_err();
                    assert_eq!(requested_count(&error, Quota::Bytes, exact - 1), exact);
                    assert_eq!(refused.bytes, 0);
                    assert_eq!(
                        error.cause.split_once("; admission ").unwrap().1,
                        format!(
                            "operation=transpose stage=output-and-cursor rows={} cols={} nnz=Some({}) previous_bytes=0 vector_bytes={:?} scratch_bytes=0",
                            p.n_cols, p.n_rows, p.vals.len(),
                            [(p.n_cols + 1) * size_of::<u32>(), p.col_idx.len() * size_of::<u32>(), p.vals.len() * size_of::<f64>(), p.n_cols * size_of::<u32>()],
                        ),
                    );
                }
            }
        }
    }
}
