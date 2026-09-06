# Difference fields across retained Results

Status: implemented on the committed #280 Result-record API; merge remains gated on #280.
Issue: [#281](https://github.com/andeplane/fem-lab/issues/281), child of
[#16](https://github.com/andeplane/fem-lab/issues/16) and its accepted
[comparison plan](https://github.com/andeplane/fem-lab/blob/fc07f08/docs/plans/16-result-journal-comparison.md). This child implements the engine calculation
for Plan 5.6 / J8.10. Browser transport and presentation remain #282 and #283; transient frame
selection remains #286 after #243.

## Query contract

`query.difference` takes two explicit operands and an explicit comparison mesh:

```text
left, right: { resultId: string, field: string, component?: integer }
onto: left | right
```

Both ids select immutable records retained by the same live Engine. There is no Step-name or
latest-Result fallback: eviction, reset, or a foreign id is a structured `not-found` error from
the #280 selector. Field strings use the same namespace as `query.field`, including `mode:k`.
Both fields must be nodal and carry the same physical dimension. Either both operands omit
`component`, preserving the complete vector/tensor layout when their component counts agree, or
both name a valid component and produce a scalar field. Explicit field names and component
numbers may differ: for example, an explicitly selected stress component minus von Mises is a
defined same-dimension scalar difference, without claiming the two quantities are equivalent.

The response identifies the resolved left and right Result ids, fields and components, the
selected comparison Result id, and whether interpolation was needed. Values are `left − right`
from the retained engine f64 fields before any display conversion, component-fastest at every
node of the selected comparison mesh. The unit is the canonical SI unit of the shared dimension.
A temperature difference therefore subtracts absolute-kelvin storage and reports the numerical
difference in K; it never applies an absolute-temperature display offset. The wire value array is
`Option<f64>`: every component of a comparison node is `null` when that point lies outside the
other mesh. Coverage reports `insideNodes`, `totalNodes`, and the sorted comparison-node indices
in `outsideNodes`. Zero overlap is a valid, explicit zero-coverage response. The response also
labels both resolved fields/components and carries structured warnings. Comparing `mode:k` values
adds a warning that raw modal signs and order are not correlated; the engine never sign-aligns
shapes or implies that equal indices identify corresponding physical modes. The retained target
id supplies the mesh/surface context to #282, so this Query does not duplicate coordinates or
connectivity.

## Numerical path

Direct indexed subtraction is allowed only when the two analysis meshes have identical dimension,
bitwise coordinates, element kinds, block boundaries, and connectivity. Named Sets are not part
of field topology. Any other mesh pair takes the projection path, even when node counts happen to
match. The non-target nodal field is evaluated at each target node with the existing finite-element
isoparametric point probe; the target value is already nodal. Choosing `onto: left` computes
`left(node) − right(projected at node)`. Choosing `onto: right` computes
`left(projected at node) − right(node)`.

Different 2D/3D mesh dimensions, non-nodal fields, unsupported element/field layouts, and a
numerical locator failure return `unsupported`; these failures are distinct from a target point
that the locator positively classifies outside the source domain and must never masquerade as
zero coverage. Subtraction or interpolation that produces a nonfinite value also returns
`unsupported` at the exact output node and component instead of serializing that value as the
same `null` used for outside coverage. Missing ids or fields remain `not-found`. A
physical-dimension mismatch returns `unit.dimension`. Missing, one-sided, or out-of-range
component choices return `schema` at the specific operand path. No path pairs nodes by count,
substitutes the current Model or Mesh, reads a file, mutates retention order, or extends a record
lifetime.

## Independent verification

A nonzero constant temperature offset gives exactly 10 K after projection between unequal linear
and quadratic meshes.
An affine field gives its closed-form left-minus-right value at every covered target node in both
projection directions; this checks sign, SI units, interpolation and quadratic mid-edge nodes
without comparing one implementation to another. The operands use different Model display units,
and a temperature case proves a delta is reported in K without an absolute offset. A holed or
partially overlapping mesh reports
exact sorted outside-node indices and null value slots while retaining exact values inside.
Reversed operands negate covered values, a Result compared with itself is exact zero through the
direct path, and two retained solves separated by a material change remain independently
selectable. Equal node counts with different coordinates must interpolate; equal coordinates with
different connectivity must also avoid the direct path. Hole and off-surface cases cover both 2D
and 3D meshes. An opposite-sign mode-shape witness verifies raw subtraction and the modal warning,
without automatic sign alignment. Tests also cover every
structured error, deterministic repeat calls, unchanged Journal/Model/retention ordering, schema
and generated types, and 100% engine/geometry line, function and region coverage including GPU
paths.
