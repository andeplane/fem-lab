//! Deterministic f64 setup for the GPU's fixed symmetric aggregation V-cycle.
//!
//! The root operator is borrowed. Only coarse operators, prolongation/restriction and the
//! small inverse Cholesky factor are retained. The caller supplies every resource limit;
//! this module chooses neither a host memory budget nor a fallback solver.

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
    n_cols: usize,
    row_ptr: &'a [u32],
    col_idx: &'a [u32],
    vals: &'a [f64],
}

impl<'a> Matrix<'a> {
    fn square(k: &'a Csr, vals: &'a [f64]) -> Self {
        Self { n_rows: k.n, n_cols: k.n, row_ptr: &k.row_ptr, col_idx: &k.col_idx, vals }
    }
    fn rect(k: &'a RectCsr) -> Self {
        Self { n_rows: k.n_rows, n_cols: k.n_cols, row_ptr: &k.row_ptr, col_idx: &k.col_idx, vals: &k.vals }
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

struct Budget {
    limits: Limits,
    bytes: usize,
    interpolation_nnz: usize,
    operator_nnz: usize,
}

fn too_large(what: &str) -> Error {
    Error::new(ErrorCode::SolveTooLarge, format!("aggregation setup exceeds its {what} limit"))
        .at("solve/aggregation")
        .suggest("solve.run { solver: 'cpu-direct' }, or a host with a larger admitted solve budget")
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
    fn bytes(&mut self, bytes: usize) -> Result<(), Error> {
        let next = self.bytes.checked_add(bytes).ok_or_else(|| too_large("byte"))?;
        if next > self.limits.max_bytes {
            return Err(too_large("byte"));
        }
        self.bytes = next;
        Ok(())
    }
    fn vector<T>(&mut self, len: usize) -> Result<(), Error> {
        self.bytes(len.checked_mul(size_of::<T>()).ok_or_else(|| too_large("byte"))?)
    }
    fn entries(&mut self, entries: usize, kind: Entries) -> Result<(), Error> {
        let (used, limit, name) = match kind {
            Entries::Interpolation => {
                (&mut self.interpolation_nnz, self.limits.max_interpolation_nnz, "interpolation fill")
            }
            Entries::Operator => (&mut self.operator_nnz, self.limits.max_operator_nnz, "operator fill"),
        };
        let next = used.checked_add(entries).ok_or_else(|| too_large(name))?;
        if next > limit || next > u32::MAX as usize {
            return Err(too_large(name));
        }
        *used = next;
        Ok(())
    }
    fn room<T>(&mut self, out: &mut Vec<T>, additional: usize) -> Result<(), Error> {
        let needed = out.len().checked_add(additional).ok_or_else(|| too_large("byte"))?;
        if needed > out.capacity() {
            let cap = needed.checked_next_power_of_two().ok_or_else(|| too_large("byte"))?;
            // Charge the complete replacement buffer, so growth also admits the old/new overlap.
            self.vector::<T>(cap)?;
            out.reserve_exact(cap - out.len());
        }
        Ok(())
    }
    fn add(&mut self, row: &mut BTreeMap<u32, f64>, col: u32, value: f64) -> Result<(), Error> {
        if value != 0.0 && !row.contains_key(&col) {
            self.bytes(MAP_ENTRY_BYTES)?;
        }
        add_value(row, col, value)
    }
    fn map(&mut self) -> Result<BTreeMap<u32, f64>, Error> {
        // An emptied BTreeMap can retain its root allocation until it is dropped.
        self.bytes(MAP_ENTRY_BYTES)?;
        Ok(BTreeMap::new())
    }
    fn release_map(&mut self, row: BTreeMap<u32, f64>) {
        self.bytes -= (row.len() + 1) * MAP_ENTRY_BYTES;
    }
}

fn add_value(row: &mut BTreeMap<u32, f64>, col: u32, value: f64) -> Result<(), Error> {
    if value == 0.0 {
        return Ok(());
    }
    if !value.is_finite() {
        return Err(stalled("a setup product is nonfinite"));
    }
    let sum = row.entry(col).or_default();
    *sum += value;
    if !sum.is_finite() {
        return Err(stalled("a setup sum is nonfinite"));
    }
    Ok(())
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
    if k.n <= COARSE_ROWS {
        return level(a, &[], &[], 0, &mut budget);
    }
    let count = space.map_or(1, |s| s.modes.len() + 1);
    budget.vector::<Vec<f64>>(count)?;
    let mut basis = Vec::with_capacity(count);
    for col in 0..count {
        budget.vector::<f64>(k.n)?;
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
        if *d <= 0.0 || !d.is_finite() || !(sum / *d).is_finite() {
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
    budget.vector::<u32>(n)?;
    budget.vector::<usize>(count + 1)?;
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
    budget.vector::<bool>(n_groups)?;
    let mut assigned = vec![false; n_groups];
    let count = n_groups.div_ceil(GROUPS_PER_AGGREGATE);
    budget.vector::<Vec<usize>>(count)?;
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
                budget.bytes -= MAP_ENTRY_BYTES;
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
        budget.vector::<usize>(rows)?;
        let mut indices = Vec::with_capacity(rows);
        for group in members {
            indices.extend_from_slice(&groups.row_order[groups.offsets[group]..groups.offsets[group + 1]]);
        }
        out.push(indices);
    }
    Ok(out)
}

fn local_basis(indices: &[usize], basis: &[Vec<f64>], budget: &mut Budget) -> Result<Vec<Vec<f64>>, Error> {
    budget.vector::<Vec<f64>>(basis.len())?;
    let mut q: Vec<Vec<f64>> = Vec::with_capacity(basis.len());
    for vector in basis {
        budget.vector::<f64>(indices.len())?;
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

fn tentative(
    n: usize,
    aggregates: &[Vec<usize>],
    basis: &[Vec<f64>],
    budget: &mut Budget,
) -> Result<(RectCsr, Vec<Vec<f64>>, Vec<u32>), Error> {
    budget.vector::<Vec<f64>>(basis.len())?;
    let mut coarse_basis = vec![Vec::new(); basis.len()];
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
    budget.vector::<u32>(n + 1)?;
    budget.vector::<u32>(triplets.len())?;
    budget.vector::<f64>(triplets.len())?;
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
    Ok((t, coarse_basis, coarse_groups))
}

fn empty_rect(n_rows: usize, n_cols: usize, budget: &mut Budget) -> Result<RectCsr, Error> {
    budget.vector::<u32>(n_rows + 1)?;
    Ok(RectCsr { n_rows, n_cols, row_ptr: vec![0; n_rows + 1], col_idx: Vec::new(), vals: Vec::new() })
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
    fn row(self, row: usize) -> Result<BTreeMap<u32, f64>, Error> {
        let mut out = BTreeMap::new();
        match self {
            Self::Product { a, b } => {
                for e in a.row(row) {
                    let middle = a.col_idx[e] as usize;
                    for f in b.row_ptr[middle] as usize..b.row_ptr[middle + 1] as usize {
                        add_value(&mut out, b.col_idx[f], a.vals[e] * b.vals[f])?;
                    }
                }
            }
            Self::Smooth { a, t, diag, omega } => {
                for e in t.row_ptr[row] as usize..t.row_ptr[row + 1] as usize {
                    add_value(&mut out, t.col_idx[e], t.vals[e])?;
                }
                let factor = -(omega / diag[row]);
                for e in a.row(row) {
                    let middle = a.col_idx[e] as usize;
                    let coefficient = factor * a.vals[e];
                    for f in t.row_ptr[middle] as usize..t.row_ptr[middle + 1] as usize {
                        add_value(&mut out, t.col_idx[f], coefficient * t.vals[f])?;
                    }
                }
            }
            Self::Symmetric { a, transpose } => {
                for matrix in [a, transpose] {
                    for e in matrix.row_ptr[row] as usize..matrix.row_ptr[row + 1] as usize {
                        add_value(&mut out, matrix.col_idx[e], 0.5 * matrix.vals[e])?;
                    }
                }
            }
        }
        Ok(out)
    }
}

// Equivalent to n*slot/4, without overflowing usize on wasm32.
fn rows(n: usize, slot: usize) -> std::ops::Range<usize> {
    let at = |index| n / ROW_PARTITIONS * index + (n % ROW_PARTITIONS) * index / ROW_PARTITIONS;
    at(slot)..at(slot + 1)
}

struct RowBlock {
    row_ptr: Vec<u32>,
    col_idx: Vec<u32>,
    vals: Vec<f64>,
}

/// Four fixed partitions, with a count pass followed by exactly the same numerical fill.
/// Every map envelope and count array is admitted before parallel work. Exact output fill,
/// the four blocks and their final merged copy are admitted before the second pass.
fn sparse_rows(op: RowOp<'_>, kind: Entries, budget: &mut Budget) -> Result<RectCsr, Error> {
    let (n_rows, n_cols) = op.shape();
    let mut scratch = 0usize;
    for slot in 0..ROW_PARTITIONS {
        let bound = rows(n_rows, slot).map(|row| op.row_bound(row)).max().unwrap_or(0);
        let bytes =
            bound.checked_add(1).and_then(|n| n.checked_mul(MAP_ENTRY_BYTES)).ok_or_else(|| too_large("byte"))?;
        scratch = scratch.checked_add(bytes).ok_or_else(|| too_large("byte"))?;
    }
    budget.bytes(scratch)?;
    budget.vector::<usize>(n_rows)?;
    budget.vector::<Vec<usize>>(ROW_PARTITIONS * 2)?;
    budget.vector::<Result<Vec<usize>, Error>>(ROW_PARTITIONS)?;
    let counts = par::map_collect(ROW_PARTITIONS, |slot| {
        let range = rows(n_rows, slot);
        let mut out = Vec::with_capacity(range.len());
        for row in range {
            let values = op.row(row)?;
            out.push(values.values().filter(|&&v| v != 0.0).count());
        }
        Ok::<_, Error>(out)
    })
    .into_iter()
    .collect::<Result<Vec<_>, _>>()?;
    let mut nnz = 0usize;
    for block in &counts {
        for &count in block {
            nnz = nnz.checked_add(count).ok_or_else(|| too_large("sparse fill"))?;
        }
    }
    budget.entries(nnz, kind)?;
    budget.vector::<RowBlock>(ROW_PARTITIONS)?;
    // The disjoint output blocks and final CSR coexist during their ordered merge.
    budget.vector::<u32>(n_rows.checked_add(ROW_PARTITIONS).ok_or_else(|| too_large("byte"))?)?;
    budget.vector::<u32>(nnz)?;
    budget.vector::<f64>(nnz)?;
    budget.vector::<u32>(n_rows.checked_add(1).ok_or_else(|| too_large("byte"))?)?;
    budget.vector::<u32>(nnz)?;
    budget.vector::<f64>(nnz)?;
    let blocks = par::map_collect(ROW_PARTITIONS, |slot| {
        let range = rows(n_rows, slot);
        let block_nnz = counts[slot].iter().sum();
        let mut out = RowBlock {
            row_ptr: Vec::with_capacity(range.len() + 1),
            col_idx: Vec::with_capacity(block_nnz),
            vals: Vec::with_capacity(block_nnz),
        };
        out.row_ptr.push(0);
        for row in range {
            // Count and fill use the same immutable operands and arithmetic order. Any
            // numerical error was already returned by the count pass, before output allocation.
            let values = op.row(row).expect("the identical count pass accepted this numerical row");
            for (col, value) in values {
                if value != 0.0 {
                    out.col_idx.push(col);
                    out.vals.push(value);
                }
            }
            out.row_ptr.push(out.vals.len() as u32);
        }
        out
    });
    let mut out = RectCsr {
        n_rows,
        n_cols,
        row_ptr: Vec::with_capacity(n_rows + 1),
        col_idx: Vec::with_capacity(nnz),
        vals: Vec::with_capacity(nnz),
    };
    out.row_ptr.push(0);
    for block in blocks {
        let offset = out.vals.len() as u32;
        out.row_ptr.extend(block.row_ptr.into_iter().skip(1).map(|n| offset + n));
        out.col_idx.extend(block.col_idx);
        out.vals.extend(block.vals);
    }
    budget.bytes -= scratch;
    Ok(out)
}

fn multiply(a: Matrix<'_>, b: &RectCsr, kind: Entries, budget: &mut Budget) -> Result<RectCsr, Error> {
    if a.n_cols != b.n_rows {
        return Err(invalid("setup product dimensions do not agree"));
    }
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

fn transpose(a: &RectCsr, kind: Entries, budget: &mut Budget) -> Result<RectCsr, Error> {
    budget.entries(a.vals.len(), kind)?;
    let mut out = empty_rect(a.n_cols, a.n_rows, budget)?;
    budget.vector::<u32>(a.col_idx.len())?;
    budget.vector::<f64>(a.vals.len())?;
    out.col_idx = vec![0; a.col_idx.len()];
    out.vals = vec![0.0; a.vals.len()];
    for &col in &a.col_idx {
        out.row_ptr[col as usize + 1] += 1;
    }
    for row in 0..out.n_rows {
        out.row_ptr[row + 1] += out.row_ptr[row];
    }
    budget.vector::<u32>(out.n_rows)?;
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
    let transposed = transpose(&raw, Entries::Operator, budget)?;
    let symmetric = sparse_rows(RowOp::Symmetric { a: &raw, transpose: &transposed }, Entries::Operator, budget)?;
    Ok(Csr { n: symmetric.n_rows, row_ptr: symmetric.row_ptr, col_idx: symmetric.col_idx, vals: symmetric.vals })
}

fn coarse(a: Matrix<'_>, budget: &mut Budget) -> Result<Plan, Error> {
    let n = a.n_rows;
    // level() reaches this factorization only for n <= COARSE_ROWS (96).
    let count = n * n;
    budget.vector::<f64>(count)?;
    budget.vector::<f64>(count)?;
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
    budget.vector::<Plan>(1)?;
    if a.n_rows <= COARSE_ROWS {
        return coarse(a, budget);
    }
    let (diag, high, uploaded_high) = diagonal(a, budget)?;
    let groups = groups(node_of_row, budget)?;
    let aggregates = aggregates(a, &groups, budget)?;
    let (t, coarse_basis, coarse_groups) = tentative(a.n_rows, &aggregates, basis, budget)?;
    let p = smooth_interpolation(a, &t, &diag, 0.8 / high, budget)?;
    let pt = transpose(&p, Entries::Interpolation, budget)?;
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
    fn bounded_factor_applies_the_closed_form_two_spring_inverse() {
        let a = poisson(2);
        let plan = build(&a, &a.vals, &[1.0; 2], None, limits()).unwrap();
        let mut checked = false;
        if let Plan::Coarse { n, c } = plan {
            checked = true;
            assert_eq!(n, 2);
            let x = [c[0] * c[0] + c[2] * c[2], c[3] * c[2]];
            assert!((x[0] - 2.0 / 3.0).abs() < 1e-15);
            assert!((x[1] - 1.0 / 3.0).abs() < 1e-15);
            assert_eq!(c[1], 0.0);
        }
        assert!(checked);
    }

    #[test]
    fn aggregate_local_qr_prunes_dependencies_and_reproduces_affine_candidates() {
        let basis = vec![vec![1.0; 8], vec![2.0; 8], (0..8).map(|i| i as f64).collect()];
        let mut budget = Budget { limits: limits(), bytes: 0, interpolation_nnz: 0, operator_nnz: 0 };
        let (t, coarse, _) = tentative(8, &[vec![7, 2, 0, 6, 1, 3, 5, 4]], &basis, &mut budget).unwrap();
        assert_eq!(t.n_cols, 2);
        for (original, reduced) in basis.iter().zip(&coarse) {
            let reproduced = rect_mv(&t, reduced);
            for (&left, &right) in reproduced.iter().zip(original) {
                assert!((left - right).abs() < 1e-13);
            }
        }
    }

    #[test]
    fn restriction_is_the_actual_transpose_and_galerkin_preserves_energy() {
        let a = poisson(127);
        let plan = build(&a, &a.vals, &vec![1.0; a.n], None, limits()).unwrap();
        let mut checked = false;
        if let Plan::Fine { n, diag, weights, p, pt, coarse_operator, .. } = plan {
            checked = true;
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
        assert!(checked);
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
        let mut a = Csr { n, row_ptr: vec![0], col_idx: Vec::new(), vals: Vec::new() };
        for row in 0..n {
            for col in 0..n {
                let value = if row == col {
                    8.0
                } else if (row == 0 && col == 11) || (row == 11 && col == 0) {
                    2.0
                } else if (row == 0 && col == 1) || (row == 1 && col == 0) {
                    0.5
                } else {
                    0.0
                };
                if value != 0.0 {
                    a.col_idx.push(col as u32);
                    a.vals.push(value);
                }
            }
            a.row_ptr.push(a.vals.len() as u32);
        }
        let mut budget = Budget { limits: limits(), bytes: 0, interpolation_nnz: 0, operator_nnz: 0 };
        let grouping = groups(&(0..n as u32).collect::<Vec<_>>(), &mut budget).unwrap();
        let actual = aggregates(Matrix::square(&a, &a.vals), &grouping, &mut budget).unwrap();
        assert_eq!(actual, [vec![0, 11, 1, 2, 3, 4, 5, 6], vec![7, 8, 9, 10]]);
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
        let a = Matrix { n_rows: 1, n_cols: 2, row_ptr: &[0, 2], col_idx: &[0, 1], vals: &[2.0, 3.0] };
        let b = RectCsr { n_rows: 2, n_cols: 1, row_ptr: vec![0, 1, 2], col_idx: vec![0, 0], vals: vec![5.0, 7.0] };
        let mut budget = Budget { limits: limits(), bytes: 0, interpolation_nnz: 0, operator_nnz: 0 };
        let product = multiply(a, &b, Entries::Operator, &mut budget).unwrap();
        assert_eq!(product.row_ptr, [0, 1]);
        assert_eq!(product.col_idx, [0]);
        assert_eq!(product.vals, [31.0]);
        let opposite = RectCsr { vals: vec![3.0, -2.0], ..b };
        let zero = multiply(a, &opposite, Entries::Operator, &mut budget).unwrap();
        assert_eq!(zero.row_ptr, [0, 0]);
        assert!(zero.vals.is_empty());
    }

    #[test]
    fn count_pass_reports_numerical_errors_before_publishing_output_fill() {
        let a = Matrix { n_rows: 1, n_cols: 2, row_ptr: &[0, 2], col_idx: &[0, 1], vals: &[f64::MAX, f64::MAX] };
        let b = RectCsr { n_rows: 2, n_cols: 1, row_ptr: vec![0, 1, 2], col_idx: vec![0, 0], vals: vec![1.0, 1.0] };
        let mut budget = Budget { limits: limits(), bytes: 0, interpolation_nnz: 0, operator_nnz: 0 };
        assert_eq!(multiply(a, &b, Entries::Operator, &mut budget).unwrap_err().code, ErrorCode::SolveStalled);
        assert_eq!(budget.operator_nnz, 0);
        let overflow_product = RectCsr { vals: vec![2.0, 1.0], ..b };
        assert_eq!(
            multiply(a, &overflow_product, Entries::Operator, &mut budget).unwrap_err().code,
            ErrorCode::SolveStalled
        );
        assert_eq!(budget.operator_nnz, 0);
        let bad_shape = Matrix { n_cols: 3, ..a };
        assert_eq!(
            multiply(bad_shape, &overflow_product, Entries::Operator, &mut budget).unwrap_err().code,
            ErrorCode::Schema
        );
    }
}
