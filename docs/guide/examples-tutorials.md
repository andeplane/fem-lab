# Examples and tutorials

**Examples** load complete bundled Journals, often including a solve. **Tutorials** guide you through Commands and explain why each one is used. They are complementary: inspect an example to see a complete definition, then build a similar Model through a tutorial.

## The modeling tour

The first local workspace entry shows an eight-stage **Modeling tour**, unless you previously dismissed it in this browser. It explains what to build and in which order. Choose **Tutorials → Modeling tour** to reopen it, including from an active tutorial. This pauses the tutorial panel; the tour's final **Build the cantilever tutorial** action starts the cantilever guide at its first step without applying old Journal entries as completed work. No modeling Command runs just from opening either guide.

Dismiss the tour with **Continue on my own**, its close button, or **Escape**. Dismissal never removes a Model or draft. If you already dismissed the older tour, the updated tour does not silently reset that preference; use the Tutorials action to see it.

## A practical learning path

1. Start with **Cantilever beam** and the cantilever tutorial. Learn Body, Material, face Set, support, Load and Step.
2. Use **Read a result** and **Mesh convergence** to compare the numerical answer with reactions and an independent reference.
3. Move to **Symmetry and 2D** and a plate-with-hole example before modeling a finely detailed 3D part.
4. Choose a physics path: heat conduction/transient heat/thermal-stress chaining, modal/free-free modal, or trusses and column buckling.
5. Try **Thermal design check** to state a steady tip-temperature requirement before solving, probe the fin tip and compare with an independent fin formula.
6. Use **Journal as program** and **Solve cost and solvers** when repeating analyses or growing a Model.

The tutorial's **Do it** action dispatches the same registered Command as a form. You can also perform the action yourself. Read the explanatory step before advancing; completing clicks is not an independent validation of the result.

In short windows, the explanation scrolls inside the tutorial card. Each new step starts its explanation at the top; your reading position stays put while using controls within the same step. The **Modeling tour** replay control and the current step's **Do it** and **Skip** actions stay outside that scrolling explanation.

## Useful bundled Models

| Example name | What to inspect |
|---|---|
| `cantilever` | Hex8 bending, support reaction and beam-theory displacement. |
| `cantilever-hex20` | Compare quadratic interpolation with the basic beam. |
| `kirsch-quarter-plate` | Symmetry, curved mapped quadratic mesh and a stress concentration. |
| `plate-with-hole-2d` | Free triangular meshing and local refinement. |
| `lame-cylinder-axisymmetric` | Axisymmetric pressure and radial/hoop stress interpretation. |
| `steel-roof-truss` | Line-member Sections, connectivity, joint forces and supports. |
| `column-buckling` | A continuum column's eigenvalue factor versus Euler theory; this is not beam-element frame buckling. |
| `cantilever-modal` | Mass, natural frequencies and arbitrary mode-shape amplitude. |
| `bar-transient-heat` | Temperature history and time-step/output settings. |
| `thermal-stress-plate` | A thermal predecessor feeding restrained thermal stress. |

Open one from a script or browser console:

```ts
await fem.example.open({ name: 'cantilever-hex20' });
```

Use **Search** in the gallery to find words in example names, descriptions and tags. Search ignores case and matches every word you enter, in any order. Combine it with the tag and difficulty filters to narrow the results; the count updates as you type. **Reset filters** clears all three controls, including when nothing matches. This needs no account or AI. The same view action is available through `example.filter` with `query`, `tag` and `difficulty`.

Opening an example or switching projects keeps those filters in the current workspace. Use browser **Back** to return to the same filtered gallery. Account changes and sign-out clear the filters; reloading the page starts with the default gallery filters.

The exact catalogue is generated from the shipped Journal fixtures and metadata; the list above is a learning selection.

## Make a thermal design decision

Choose **Tutorials → Thermal design check**. Use a separate Model: the guide builds the existing `heated-fin-convection` case and solves steady conduction with the local engine. No account or hosted AI is required. Its numerical material constants are assumed illustrative aluminium values for the fin reference, including conductivity 205 W/(m K); they are not certified 6061-T6 or EN 573-3 material data. Geometry, boundary conditions and numerical constants match the checked example; the tutorial explicitly identifies the assumptions.

The illustrative requirement is **at most 40 °C at the centre of the insulated tip**, at `[150 mm, 12.5 mm, 1 mm]`. With a 120 °C held root, 20 °C ambient and an assumed convection coefficient of 50 W/(m² K) on all four long faces, expect about **37.41 °C** there. The independent adiabatic-tip fin formula gives **37.3946 °C**. On the post-solve inspection step, **Do it for me** fits the fin in the viewer without changing the Journal or Results; use **Next** after inspecting it. Probe the actual result in Celsius:

```ts
const tip = await fem.query.probe({
  field: 'temperature',
  at: ['150 mm', '12.5 mm', '1 mm'],
});
console.log(tip.value); // approximately { value: 37.41, unit: 'degC' }
```

This passes the stated tip-only check under those assumptions, with about 2.59 K of margin. The global maximum is the prescribed 120 °C root: a 40 °C limit anywhere in the Body would fail. `heat-steady` gives no transient peak or warm-up time, and convection is supplied rather than computed from fluid flow. Uncertain inputs can reverse the decision even when the mesh agrees closely with the analytical reference.

The closing step explains corresponding Abaqus steady-state heat-transfer, Ansys Steady-State Thermal and Nastran heat-transfer terminology. These describe comparable workflows; the tutorial does not establish equivalent solver implementations or certify a design.


## Verification walkthroughs

These tutorials run locally without an account or hosted AI. Start each in a separate Model: **Do it for me** executes ordinary registered Commands, including the solve. The final **Fit** action only changes the camera; inspect the Result and then choose **Next**. The closing theory explains corresponding Abaqus, Ansys and Nastran terminology and links the original problem source.

### Axisymmetric transient heat

Choose **Tutorials → Axisymmetric transient heat**. A 0.3 m-radius, 0.4 m-long cylinder starts at 0 °C, with its curved wall and both ends held at 1000 °C. The displayed rectangle is the cylinder’s meridian: x means radius and y means axial position. The axis is naturally insulated, with the circumferential weighting supplied by the idealisation. The heat-only Material supplies conductivity, density and heat capacity; elastic stiffness is unnecessary.

After the backward-Euler run to **190 s**, probe temperature at `[0.1 m, 0.3 m, 0 m]`. The independently published NAFEMS/COMSOL target is **186.5 °C**; the cylindrical diffusion series gives **186.4853 °C**. The tutorial’s Δt = 2 s result is **186.2292 °C**. Its finite time step introduces a small integration error, which the automated check verifies decreases on halving Δt. It also checks spatial refinement separately. Inspect the retained frame’s time before comparing: another frame is another physical answer. The guide covers maintained boundary temperatures, and does not implement the source tutorial’s later change to insulated boundaries.

```ts
const reading = await fem.query.probe({
  step: 'warm-up', field: 'temperature',
  at: ['0.1 m', '0.3 m', '0 m'],
});
console.log(reading.value); // degC; compare the final 190 s Result with 186.5
```

### Thermal stress with one-eighth symmetry

Choose **Tutorials → Thermal stress with one-eighth symmetry**. The guide uses the positive octant of a 1 m cube centred at the origin to teach the reduction used in Fusion’s thermal-stress workflow. It does not recreate the vendor’s disk-brake rotor, CAD simplification or yielding assessment.

Three true mirror planes restrain only their normal displacements, leaving thermal expansion free. A 100 K temperature rise combines with 10 MPa pressure on the physical xmax outside face. At `[0.5 m, 0.5 m, 0.5 m]`, expect displacement components **(0.475, 0.5075, 0.5075) mm**, stress σxx = **−10 MPa**, and von Mises = **10 MPa**. The x reaction is **2.5 MN**, the pressure resultant on the modeled quarter-area, rather than the full cube’s outside face.

Removing the pressure from the Step leaves stress-free expansion, with 0.5 mm in every corner component. Clamping an entire mirror face instead of its normal displacement creates restraint stresses and changes that solution. An eighth is valid only when geometry, material directions, temperature and loads all reflect across all three planes.


For this validated **heating-only** control, floating-point reaction residuals can be about 10⁻⁷ N while the true mechanical actions are zero. The reported relative balance can then divide roundoff by roundoff and show a misleading failure ([known issue #842](https://github.com/andeplane/fem-lab/issues/842)). Inspect the absolute residual alongside the independent stress/displacement solution for this control. The pressure-loaded tutorial has a nonzero physical force scale and retains its normal force-balance check; this limitation does not justify disregarding imbalance in a loaded Model.

### LE10: the full-face support variant

Choose **Tutorials → LE10: the full-face support variant**. Build the curved mapped base and sweep a 0.6 m thickness into quadratic solids. This is the independently verified **ESRD full-face-support variant**, with all three outer-face displacement components fixed. Its reference is **σyy(D) = −5.25 MPa**, at the upper inner corner `D = [2 m, 0 m, 0.6 m]`; the tutorial mesh gives about **−5.234 MPa**. Probe stress component **1**, rather than displacement, von Mises or a mid-plane point.

The original NAFEMS LE10 holds vertical displacement only on the outer face’s mid-plane line, and has the different **−5.38 MPa** target. Use the separate **LE10: original mid-plane line support** guide for that original result; this full-face guide and example retain their different supports and reference. The tutorial explicitly compares support definitions and the 6 × 6 × 2 versus 12 × 12 × 8 quadratic refinements. A coarse mesh accidentally approaching another problem’s reference is not verification.

### LE10: original mid-plane line support

Choose **Tutorials → LE10: original mid-plane line support**. This reproduces the original [SimScale/NAFEMS plate definition](https://www.simscale.com/docs/validation-cases/thick-plate-under-pressure/): ellipses with semi-axes (2, 1) m and (3.25, 2.75) m, thickness 0.6 m, E = 210 GPa, ν = 0.3 and 1 MPa top pressure. The two cut faces remove only their normal displacement. The whole outer curved face holds **ux and uy**, while **uz is held only on its z = 0.3 m mid-plane line**.

The guide imports a reproducible 425-node, 64-cell Hex20 mesh through the normal checked imported-mesh contract. Its complete authored INP source includes a named 9-node mid-plane Set and a SHA-256 provenance hash. `node tools/generate-le10-original.mjs` after the normal Node WASM build regenerates the three source decks in `tools/fixtures/le10-original/`, all three numerical test fixtures and the interactive middle-mesh tutorial payload through the registry mesher, exporter and converter. The imported `order: 1` retains the authored quadratic connectivity; it does not linearize it. Import certification may take longer than the solve.

Show stress **component 1 (σyy)** and probe `[2 m, 0 m, 0.6 m]`. The original independent reference is **−5.38 MPa**; the visible 4 × 4 × 4 mesh gives **−5.40449 MPa**, about **0.455%** from the reference and within the unchanged **2%** stress check. The independent three-mesh test retains 4 × 4 × 2, 4 × 4 × 4 and 6 × 6 × 6 meshes, giving −5.65287, −5.40449 and −5.38031 MPa with decreasing reference error. The 1225-node, 216-cell finest mesh remains a numerical refinement fixture; the interactive lesson uses 64 cells so repeated imported-geometry certification fits its browser budget. This is a discrete point-stress refinement check, not a formal asymptotic convergence-rate claim for a singular line support. Stress is interpolated from recovered nodal values.

Check the support physically as well: the upper and lower outer edges move vertically by approximately −8.78 μm and −7.65 μm, while the mid-plane line remains at zero uz. All 56 other outer-face nodes retain z freedom. A full-face vertical clamp would remove those motions and requires the separate −5.25 MPa reference. The total vertical reaction balances approximately **5.448 MN**. The [ESRD benchmark guide, pp. 29–31](https://www.esrd.com/wp-content/uploads/dlm_uploads/Benchmarks-Guide-Standard-NAFEMS-Benchmarks-Linear-Elastic-Tests.pdf) records both support definitions and explains their distinction.

## Keep a comparison record

Before changing an example, save a portable Model file or keep it as a separate project. Change one assumption at a time, solve the named Step again, and write down the quantity and units being compared. A tutorial's reference value is tied to its stated geometry, boundary conditions and formulation; it is not a target to force a different model to match.

The repository's [Benchmark record](https://github.com/andeplane/fem-lab/blob/main/docs/BENCHMARKS.md) documents analytical/reference cases and convergence tests. For interpreting disagreement, start with [verification](./results-verification.md), [mesh settings](./meshing.md) and [physics limitations](./physics.md).

The `heated-fin-convection` and `heated-fin` examples, and the **Thermal bar** tutorial, use assumed illustrative aluminium constants, including conductivity 205 W/(m K), rather than certified 6061-T6 or EN 573-3 property data. Their Journals, gallery explanations and tutorial material step state that assumption. Replacing those inputs with an actual alloy data set changes the physical problem: solve it again and update the analytical reference before comparing temperatures.
