# Independent STEP fixtures (#351)

These Part 21/AP203 files were authored directly from analytic geometry on 2026-10-15.
They were not exported by OCCT or reconstructed from the tested tessellator's output.
The original metre box/cylinder topology was authored before conversion was run; mm/inch
box variants retain identical geometric coordinates and change only declared length units
and descriptive header text. An inch is defined here by an explicit conversion of 0.0254 m.

| Source | Exact geometry | Volume (m³) | Area (m²) |
| --- | --- | --- | --- |
| analytic-box-m.step | [0,1] × [0,2] × [0,3] m | 6 | 22 |
| analytic-box-mm.step | [0,1] × [0,2] × [0,3] mm | 6e-9 | 22e-6 |
| analytic-box-inch.step | [0,1] × [0,2] × [0,3] in | 6 × 0.0254³ | 22 × 0.0254² |
| analytic-cylinder-m.step | x²+y²≤1, 0≤z≤2 m | 2π | 6π |

The box has eight shared vertices, twelve shared straight edges, six outward planar faces
and one closed shell. Its boundary orders are ADCB, EFGH, ABFE, BCGF, CDHG and DAEH.
Every shared edge appears in opposite directions across its two incident faces.

The cylinder has one exact cylindrical lateral surface, two planar caps and a closed shell.
Each circular rim closes on a seam vertex. The shared lateral seam occurs twice in opposite
directions; its pcurves have u=0 and u=2π, v=z. The lower cap's outward axis is -z and the
upper cap's is +z. The source contains exact circles, not a polygonal approximation.

`tools/test-step-import.mjs` checks engine-query volume, area, bounds and nonempty named
face/mesh output. Curved cases decrease absolute deflection at a coarse fixed angular
deflection so the angular setting does not dominate refinement. The actual facet radial
sag establishes a conservative volume bound; an API parameter alone is not a proof of it.
The additional regular-polygon prism formulas independently check the tessellated geometry
and its second-order circumferential convergence. See `docs/BENCHMARKS.md`.

`tools/step-replay-only.mjs` runs from a directory containing only portable Model/Journal
files, the native executable and the FEM Node module pair. It never receives these STEP
files, the converter or its source tree. Original units and source-file access therefore
cannot accidentally influence native one/four-thread or Node-WASM replay.

`untranslatable-face-child.step` adds an unsupported seventh base `FACE` to the box's closed
shell. Actual OCCT transfer originally warned and omitted that child while returning a valid
six-face box. It is the retained before/after regression for the strict transfer-warning
guard, which now reports `STEP_TRANSFER_CHECK_FAILED` and no partial arrays. Other real
negative cases in the permanent tool author explicit free point/wire and empty-shell children,
an external document reference, invalid entities, empty DATA and malformed source text.
