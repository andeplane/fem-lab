# Static Abaqus comparison workflows

Implementation issue: [#654](https://github.com/andeplane/fem-lab/issues/654).
Parent acceptance: [#650](https://github.com/andeplane/fem-lab/issues/650).
Typed structural normalization belongs to #653; persistent source regions to #652;
quadratic source admission to #655; independent exported-deck acceptance to #656;
host include acquisition, units and reporting to #657.

The goal is to retain representable exported analysis definitions so a user can solve
the same model and compare results. The converter consumes typed scoped deck blocks;
it does not rewrite input text or build a second mesh parser.

## Retained analysis

- Constant isotropic materials and every solid section are retained. Sections must
  cover every source element exactly once; disjoint region ownership uses existing
  material.assign Commands. Shared source nodes remain shared across interfaces.
- Each small-displacement linear-static Step becomes a named FEM Lab Step with its
  complete effective boundary, nodal-force and pressure state. The first analysis
  remains in the compatibility `analysis` report field; `analyses` lists all cases.
- BOUNDARY supports direct translational DOFs and the solid-active components of
  ENCASTRE, PINNED, X/Y/ZSYMM and X/Y/ZASYMM. Model-data constraints are zero.
- CLOAD remains a per-node magnitude, translated to the existing Set-total force
  contract. Uniform DSLOAD P and DLOAD Pn retain exact source face memberships and
  the inward-positive pressure convention.
- History families inherit between Steps. OP=MOD updates inherited state; OP=NEW
  clears that family's inherited state before its new definitions. Mixed OP values
  or overlapping conflicting definitions within one Step fail explicitly.
- Ordinary finite nonnegative STATIC increment controls and DIRECT are recognized.
  A report note explains that FEM Lab configures final equilibrium, without claiming
  the source solver's increment trajectory, iteration settings or history output.
- DENSITY is retained physically with an explicit unitTime. If source length, force
  and time scales are L, F and T, density scales by F T²/L⁴. Missing time fails;
  the engine never assumes seconds or a mass unit. Density is available for later
  supported model edits even though these imported Steps use static equilibrium.
- Quoted material/Step labels retain their exact case and source spelling in the
  report. If a label contains characters forbidden in callable FEM Lab object names,
  a deterministic collision-checked identifier is reported alongside the source label.
- Cumulative retained analysis assignments are bounded to 1,000,000 before inherited
  state is copied. Repeated scoped analysis retains at most 64 MiB of owned UTF-8
  text, admitted before each block clone, including continued keyword parameters,
  data fields and their original records. The existing final 16 MiB serialized-response
  limit also applies.

Unsupported material laws, physics, follower/nonuniform loads, coordinate transforms
and formulation substitutions remain structured errors. Recognized output requests
are reported by the typed reader rather than mistaken for physical model definitions.
Conversion does not solve or mutate the active document; host Candidate preparation
must validate the whole result and publish it atomically. The saved Journal contains
ordinary explicit Commands, without source-file dependencies.

## Verification

The existing registry integration binary retains SI/mm bar, prescribed patch,
per-node force, reaction, replay and atomic failure checks. Additional independent
oracles are specified in `docs/BENCHMARKS.md`: pressure at three refinements,
two-material series compliance at three refinements, inherited/modified/reset load
cases, and explicit source density units. The original real exported files and
external reference displacements belong to #656's composed acceptance.

Source drafting alone is not verification. Native/coverage/WASM/host acceptance is
reported on #654 and #650 after the required dependencies are composed.

## Observed comparison blocker

The unchanged author-published Abaqus `Job-11.inp` from BriefFiniteElement.Net
Case_06 imports and solves with 275 nodes, 160 C3D8 elements and the correct 4 MN
reaction. Native one/four-thread public outputs agree exactly except elapsed time.
Its 825 displacement components do **not** agree with the author's Abaqus probe:
610 fail a threshold fixed before execution (half the printed last-digit quantum
plus 1e-12 m roundoff floor); maximum absolute error is 1.5003315e-5 m.

This is a failed comparison, not an accepted benchmark or permission to widen the
tolerance. Abaqus documents selective volumetric integration for C3D8, whereas the
existing FEM Lab `full` path integrates the complete elastic operator at eight points.
That is a concrete formulation hypothesis requiring an independent controlled
diagnostic. The importer must not silently change the meaning of the existing global
`full` formulation. Parent #650 retains this numerical-comparison gate; source
admission and force balance alone do not close it. The original source, author
probe and raw FEM Lab outputs are preserved in the issue's validation evidence.
