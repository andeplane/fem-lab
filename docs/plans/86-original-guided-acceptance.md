# Original guided-workflow acceptance

Issues: [#86](https://github.com/andeplane/fem-lab/issues/86) and its original-rotor
child [#848](https://github.com/andeplane/fem-lab/issues/848).

The useful workflows in PR #840 are shipped, but its ESRD LE10 and thermoelastic cube
are explicitly different physical problems from original line-supported LE10 and the
Fusion BrakeRotor. They do not waive those remaining requests. Keep #86 open through
both original-problem follow-ups. Earlier closed children explicitly requested re-authored
teaching problems; their accepted contracts remain separate from literal vendor CAD/API
identity. Do not reopen them merely because FEM Lab has different UI or solver internals.

## Ten-row acceptance map

| Source problem / lesson | Implemented guide | Fidelity and accepted contract | Remaining acceptance |
|---|---|---|---|
| Cornell SimCafe pressure vessel | `pressure-vessel` | The Lamé cylinder and thin-wall comparison specified by closed #368; re-authored parameters. | Closing Abaqus/Ansys/Nastran terms and primary-source link added in this follow-up. |
| COMSOL axisymmetric transient heat | `axisymmetric-transient-heat` | Original maintained-temperature finite-cylinder NAFEMS case, including the 190 s target. The later switch to insulation is explicitly outside this guide. | Existing numerical/browser proof covers the stated benchmark scenario. |
| FreeCAD composite block in shear | `composite-block-shear` | The two-material panel, tie and stiffness-bounds lesson specified by closed #370; no claim of literal vendor CAD identity. | Closing cross-product terms and primary-source link added in this follow-up. |
| Fusion thermal design decision | `thermal-design-check` | The checked fin and illustrative tip-only 40 °C requirement explicitly specified by closed #809. | Accepted design-question workflow is complete; no vendor-CAD or certification claim. |
| Fusion one-eighth BrakeRotor thermal stress | `eighth-thermal-stress` cube | Analytical teaching variant only; different geometry, material, temperature field and loads. | Child #848 must obtain the actual functional rotor/property data and deliver the original heat→stress/yield workflow. |
| Femap thermal→structural chaining | `thermal-stress-chaining` | The restrained plate and consumed temperature field specified by closed #369. | Closing cross-product terms and source link added in this follow-up. |
| SimScale/NAFEMS LE10 | `le10-original` plus `le10-full-face` | Exact original support split and −5.38 MPa reference; separately named ESRD full-face −5.25 MPa variant retained. | Finish source-bound numerical/browser acceptance and merge the original guide. |
| Fusion free-free modal lesson | `free-free-modal` | The free-free beam explicitly specified by closed #373. The original Fusion source uses a 304 stainless tuning fork and 418/440 Hz tuning; this beam must not claim that literal reproduction. | Closing terms and source link added; actual beam contract retained. |
| FreeCAD Python scripting lesson | `journal-as-program` | The export/edit/replay/hash workflow specified by closed #371, using FEM Lab scripting and a committed Journal. | Closing terms/source link added; clearly FEM Lab Journal scripting, not the FreeCAD Python API. |
| FEniCSx AMG elasticity lesson | `solve-cost-and-solvers` | The cost/direct/PCG lesson specified by closed #372; the actual preconditioner is Jacobi, not the source demo's AMG. | Closing terms/source link added, retaining direct/PCG/Jacobi semantics. |

## Original LE10 recipe

The [SimScale primary definition](https://www.simscale.com/docs/validation-cases/thick-plate-under-pressure/)
specifies the quarter elliptic plate between `(x/2)^2+y^2=1` and
`(x/3.25)^2+(y/2.75)^2=1`, extruded from z=0 to 0.6 m, E=210 GPa, ν=0.3.
The x/y symmetry faces restrain only their normal displacement. The entire outer face
restrains ux and uy, while **only its curved mid-plane line at z=0.3 m restrains uz**.
The upper surface carries 1 MPa inward pressure. Probe σyy at D=(2,0,0.6) m.
SimScale reports magnitude 5.38 MPa; the signed NAFEMS reference is −5.38 MPa, also
stated in the [ESRD primary benchmark description, p.29](https://www.esrd.com/wp-content/uploads/dlm_uploads/Benchmarks-Guide-Standard-NAFEMS-Benchmarks-Linear-Elastic-Tests.pdf).
ESRD's separate full-face variant and its −5.25 MPa reference remain named separately.

No new element, solver or selector capability is needed. The current registry can export
its own mapped Hex20 mesh, convert that authored INP source into a checked portable
`mesh.set{imported}` Command, and preserve a named NSET for the exact midline. SimScale's
own workflow likewise uploads precomputed meshes. The generator records the complete
source-deck hash including the midline NSET; it does not assign a full-face uz support or
approximate the line by a finite-width clamped band.

The bounded WASM registry refinement family is 4×4×2 → 4×4×4 → 6×6×6 Hex20:
σyy(D)=−5.652871425 → −5.404492888 → −5.380306238 MPa. Errors against unchanged
−5.38 MPa decrease to 0.0057%. The final mesh has 1225 nodes / 216 cells, with exactly
13 mid-plane support nodes among 133 outer-face nodes. The other 120 nodes retain uz
freedom; upper/lower outer edges move −9.77/−8.65 μm while midline uz is roundoff zero.
The final relative force balance is 8.90e−15 and vertical reaction is 5.448646543 MN.
Source hashes, generator, exact membership and analytical load checks are committed with
the actual guided fixture. These discrete point-stress refinements do not claim a formal
global asymptotic rate for the singular line support. Source-bound Linux gates and visible
Chromium acceptance must complete before delivery is claimed.

## Original rotor recipe and closure

The [Autodesk original tutorial](https://help.autodesk.com/cloudhelp/ENU/Fusion-Simulate/files/GUID-88BCA6F7-A333-41C8-AA35-703F6F99DE13.htm)
uses `Samples > Basic Training > 11-Simulation > BrakeRotor`. Its source settings and
load data are recorded in #848. The actual vented/ribbed geometry and sample material
property record must be obtained before claiming reproduction; screenshot-derived
dimensions or a plain annulus are not substitutes. Child #848 owns that source-access,
physics and guided-runtime work independently of the LE10 changes.

Close #86 only after the original LE10 workflow, #848 and the six missing closing
terminology/source blocks are delivered and verified. Keep source/test, browser, merged
and publicly deployed evidence distinct. Existing closed child contracts and the broader
vendor-capability tracker #45/#432 must not be relabelled as literal vendor replication.
