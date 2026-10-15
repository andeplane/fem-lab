# Independent interoperability corpus (#656)

Parent [#650](https://github.com/andeplane/fem-lab/issues/650) is the user workflow: load an
existing solver model without hand-editing its input, explicitly solve, and compare answers.
The implementation plan is [Abaqus interoperability](../../../../../docs/plans/650-abaqus-interoperability.md)
([#651](https://github.com/andeplane/fem-lab/issues/651)).
Import admission, source preservation, numerical agreement and an actual exporter-generated
file are separate evidence. A successful parser test alone does not establish interoperability.

## Reproduce the external reference comparison

Run from the checkout with Python 3.10+ and a separately built, verified native CLI containing
the supported import paths. These commands never build the engine or execute CalculiX:

```sh
python3 tools/abaqus-interoperability/corpus.py fetch --out /private/tmp/femlab-reference-corpus
python3 tools/abaqus-interoperability/corpus.py check --source /private/tmp/femlab-reference-corpus
python3 -B -m unittest discover -s tools/abaqus-interoperability -p 'test_*.py'
python3 tools/abaqus-interoperability/corpus.py compare \
  --source /private/tmp/femlab-reference-corpus \
  --native /absolute/path/to/verified/femlab \
  --out /private/tmp/femlab-reference-comparison
```

`compare --case calculix-beam20p` selects one named case; the default requires **both**
official cases, the unchanged FreeCAD export, the authors' Abaqus assembly case and our authored
assembly. An unsupported keyword, import/solve failure,
changed source hash, omitted reference node, altered load, wrong units, nonfinite field or
thread disagreement fails the command. It never repairs the source, strips physics,
overrides a formulation or treats an unsupported case as a numerical pass. Fresh comparison
directories prevent old output being mistaken for a new run. Raw CLI arguments, exit codes,
stdout/stderr, portable imported files, explicit solve scripts and comparison receipts remain
external. An incomplete run records `completed: false` and exits unsuccessfully.

Each manifest `step` is the canonical source identity: unquoted Abaqus names are uppercase,
so the original `Step-1` is identified as `STEP-1` without changing its source bytes. The
harness requires exactly one matching `analyses[].sourceStep` in the conversion report and
uses that entry's engine `step` for the explicit solve and all Result/field queries. It does
not assume that a source spelling is an engine target or silently select the first analysis.

## Official CalculiX comparison cases

[The manifest](../../../../../tools/abaqus-interoperability/corpus.json) pins the original
[CalculiX 2.23 test archive](https://www.dhondt.de/ccx_2.23.test.tar.bz2), selected input and
`.dat.ref` bytes by SHA-256. The fetcher reads only four exact regular archive members into
memory and stores the untouched archive, members, license and versioned source acquisition receipt
outside the checkout. It never extracts archive paths onto the filesystem.

| Untouched official input | Actual contents | Independent comparison |
| --- | --- | --- |
| `beam20p.inp` | 261 nodes, 32 full-integration `C3D20`; continued connectivity, two-field `GENERATE`, repeated boundary blocks, density, one static step, `CLOAD`, `NODE PRINT`/`EL PRINT` | Every one of the 261 reference nodal displacement vectors; total reaction `(0,-9,0)` N. |
| `beam10p.inp` | 90 sparse node labels, 31 `C3D10` with labels 37–67; omitted zero z-coordinates, continued connectivity, named sets, one static step, `CLOAD`, print requests | Every one of the 90 reference nodal displacement vectors; total reaction `(0,-9,0)` N. The source comment mentions pressure, but actual loading uses `CLOAD`. |

The declared source system is mm/N/s: `E=210000` is N/mm², and `beam20p` density `7.8e-9`
is tonne/mm³. Reference displacements are converted from mm to metres. One fixed tolerance
is used for every displacement component: `1e-13 m + 2e-6 × max(|reference U|)`; it accommodates
the independent file's printed precision and is not fitted to FEM Lab results. Native 1/4-thread
selected public outputs must also match exactly after omitting `timeMs`. Integration-point
stress references are preserved but are **not** compared because that needs an independently
established integration-point ordering correspondence. The two meshes are cross-solver
comparison cases, not a known-rate convergence study or a new completed numerical Benchmark.

Force balance uses one vectorwise tolerance in N: `1e-7 + 1e-10 × max(|expected reaction|)`.
This keeps the absolute floor for small loads while handling summation roundoff at large force
scales: a 3e-7 N error on 4 MN is approximately 7.5e-14 relative. Tests accept that roundoff
and reject missing loads and meaningful imbalance at both small and meganewton scales.
This policy is separate from the displacement-reference tolerance, which is unchanged.

The distribution is separate third-party reference data under GPL-2.0-only, not FEM Lab's MIT
license. [Upstream](https://www.dhondt.de/) links its GPLv2 terms; the
[Debian source copyright record](https://metadata.ftp-master.debian.org/changelogs/main/c/calculix-ccx/calculix-ccx_2.23-1_copyright)
identifies the upstream copyright/license. The repository commits the acquisition metadata
and our harness, not CalculiX input/reference originals. Do not relabel downloaded files as MIT.

## Untouched FreeCAD export, with independently published definition checks

The fetcher also acquires `test/inp_parser/testcube.inp` unchanged from
[JuliaTopOpt/TopOpt.jl at `ca90253960194b18cfdd10521712bd90ba8d65dd`](https://github.com/JuliaTopOpt/TopOpt.jl/blob/ca90253960194b18cfdd10521712bd90ba8d65dd/test/inp_parser/testcube.inp).
Its actual footer identifies **FreeCAD 0.17.13514 (Git), 2018-11-07**, and declares mm geometry,
MPa elasticity and N nodal loads. This is a published export from another application,
not our hand-authored example and **not** an Abaqus/CAE export. The source project ships
[independent regression checks](https://github.com/JuliaTopOpt/TopOpt.jl/blob/ca90253960194b18cfdd10521712bd90ba8d65dd/test/inp_parser/test_inpstiffness.jl)
for this same file's five quadratic tetrahedra, elastic material, nodal force and pressure
face definitions. Its original MIT copyright/license and those definition checks are fetched
and attested at the same immutable source revision. The original exported bytes stay external.

The 10 mm cube has 26 nodes and five C3D10 elements. It combines nested named element sets,
named displacement constraints, a -1 N y-force at source node 2, and 1 MPa pressure on faces
25/P3 and 29/P2. Those two triangles span the entire 100 mm² top face: pressure supplies
-100 N in z, so the total reaction must be `(0,1,100)` N. Output/file/print requests remain in
the untouched input.

An independently built and executed **CalculiX 2.23** now completed this unchanged original
with exit 0 and printed all 26 displacement vectors. The observed
[reference JSON](freecad-testcube-ccx-2.23.json) records those exact values in original mm units,
input/DAT/binary/source archive hashes, actual command/environment, compiler/dependency
versions and the independently retained evidence package identity. All 1,180 solver C/Fortran/header
files were byte-identical to the official source archive; only build configuration and the
official SPOOLES corrections were applied. The successful build enabled ARPACK-NG 3.9.1;
initial unsuccessful build configurations and their failures remain in the external evidence.
This observed result is independently executed reference data, not a vendor-published table
or output from FEM Lab. The raw DAT, FRD, STA, logs, binary and source/build provenance remain
in the external 66-payload reference package, whose manifest hash is pinned in the JSON.

The same independent solver also executed both untouched official beam decks: all 270 printed
beam10p displacement components matched the distribution reference exactly; beam20p's largest
difference was `1.908667e-14` in original mm units on a near-zero x-component. Those runs
corroborate the independent reference setup; the harness still compares against the original
distribution `.dat.ref` files rather than replacing them with locally generated answers.

The FreeCAD case is now included in the strict harness comparison list. The input's output
requests do **not** include RF, so no CalculiX reaction output is claimed: the reaction gate
uses the independent analytical applied-force sum above. Integration-point stresses are
retained but unclaimed pending an independently established ordering correspondence.
Reference execution/source inventory is **not** FEM Lab numerical acceptance: the untouched
input must still pass complete conversion and explicit solve against the composed importer.

## Authors' published Abaqus assembly validation, with all nodal displacements

[BriefFiniteElement.Net Case_06](https://github.com/BriefFiniteElementNet/BriefFiniteElement.Net/tree/8e627e941aec0ad86de69e78a483a132aef8ceb5/Validation/Validation/Case_06)
provides an unchanged `Job-11.inp`, original textual `Displacements` probe report and an
adjacent `Validator.cs` that explicitly names this input and an **ABAQUS** nodal-displacement
comparison. The fetcher pins those primary author artifacts and the original LGPLv3 license
outside the checkout. For the offline #673 numerical regression, unchanged originals and a
checked transcription are also retained in a [separately licensed third-party fixture directory](../third-party/brief-finite-element-net/case06/README.md)
with both LGPLv3/GPLv3 texts and exact provenance; the root MIT license does not relicense them.
The source's actual Abaqus version and CAE export workflow are unknown;
neither a verified modern CAE export nor a fresh local Abaqus execution is claimed. The author
validator code documents their comparison intent; it was not executed here, and its literal
report filename differs from the published file's name.

This ordinary assembly uses `PART`/`ASSEMBLY`/`INSTANCE`, source names beginning with `_`,
`INTERNAL` sets and instance-qualified assembly memberships. It has 275 nodes and 160 **full
C3D8** elements, `E=210 GPa`, `ν=.25`, fixed-root constraints and a named linear static
`Step-1`. Four nodal y-loads of -1e6 N give -4e6 N total; original output requests include
`RESTART,WRITE,FREQUENCY=0` and field/history `PRESELECT`. The authored validation code's
metre displacement labels and the input's material/load magnitudes establish the declared
SI m/N system used by the harness.

The strict fifth case `author-abaqus-case06` reads all 275 direct `U1/U2/U3` vectors from the
original report, verifies each original coordinate against the source and requires its 1,005
repeated attached-element rows to agree. It **does not** subtract the coarsely printed
deformed coordinates or infer values from a screenshot. Original published precision uses the
same fixed displacement tolerance as the other cases; reaction equilibrium is independently
checked against +4e6 N in y, not a published RF result. A single unchanged CalculiX attempt
exited 0 while warning about unsupported assembly/output content and produced only a mesh,
with no displacement DAT. That run is retained as a limitation, **not** a numerical oracle
or an excuse to strip unsupported model data. Actual FEM Lab agreement remains pending the
composed import/solve runtime.

The first actual composed-import trial preserved all 275 nodes/160 elements, balanced the
4 MN load and produced identical 1/4-thread public outputs, but **failed** the published U
comparison: maximum absolute error `1.50033150347e-5 m`; 608 of 825 components exceeded this
harness's fixed `7.16712e-10 m` tolerance. This remains a strict RED acceptance case.
[Abaqus documents selectively reduced volumetric integration for its linear 3D elements](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEBMKRefMap/simabmk-c-linbending.htm),
while the initial FEM Lab Full Hex8 path integrates pointwise strain at all eight Gauss
points. That formulation difference requires investigation; it does not justify changing
the reference, tolerances or silently substituting another element. No equivalence is claimed.

## Authored assembly: two materials and two transformed instances

`assembly-two-material-bars.inp` is independently authored for this project and carries the
repository MIT license. **It was not exported by Abaqus/CAE.** It uses the documented
assembly syntax because [CAE writes assemblies of part instances by default](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEMODRefMap/simamod-c-partassy.htm).

Each part has two conforming Hex8 cells with a shared four-node interface and cross-section
0.01 m². The first half has `E=200 GPa`, the second `E=100 GPa`, both with `ν=0`; a 1000 N
axial tip load yields constant axial stress 100000 Pa. The exact interface displacement is
`1000/.01 × .5/200e9 = 2.5e-7 m`, and the tip displacement is
`1000/.01 × (.5/200e9 + .5/100e9) = 7.5e-7 m`. All transverse displacements/stresses are zero.
This detects accidentally replacing both materials with a homogeneous assignment.

Instance A is untransformed. Instance B first translates by `(2,0,0)` m, then rotates +90°
about the global z-axis, giving `(x,y,z)=(-local_y,2+local_x,local_z)`. Its axial load and
displacement are global y, while instance A uses global x. Each root is fixed separately;
the instances are spatially distinct and have no contact assumption. Reused local labels
must become 24 distinct solved nodes and four elements without welding. The harness checks
every node's piecewise analytical displacement, the rotated stress tensor, force balance,
and exact 1/4-thread replay output. Named node/element/surface memberships and the two
material regions remain ordinary imported-source data; output requests do not add loads.

## Honest remaining corpus gaps

The manifest separately records small, directly accessible Abaqus vendor verification decks
and exact hashes for C3D20/C3D10 pressure, CPS8 plane stress, a DC2D4 heat patch and a three-instance
coupling model. They are **candidates**, not passing static-comparison cases. Hydrostatic
pressure, multiple steps, thermal mapping and distributing-coupling semantics cannot be
deleted to force acceptance. Redistribution permission for these vendor originals was not
established; do not commit them without a grant. Analytical problem descriptions are linked
for independently authored future fixtures.

An **untouched Abaqus/CAE-generated file with verified exporter/version provenance is still
missing**. Neither these vendor verification decks nor our authored assembly proves that
final acceptance. Modal and thermal import comparisons also remain separate work; the static
corpus must not be advertised as validating them or all Abaqus formats.
