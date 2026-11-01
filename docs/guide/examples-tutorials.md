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

## Keep a comparison record

Before changing an example, save a portable Model file or keep it as a separate project. Change one assumption at a time, solve the named Step again, and write down the quantity and units being compared. A tutorial's reference value is tied to its stated geometry, boundary conditions and formulation; it is not a target to force a different model to match.

The repository's [Benchmark record](https://github.com/andeplane/fem-lab/blob/main/docs/BENCHMARKS.md) documents analytical/reference cases and convergence tests. For interpreting disagreement, start with [verification](./results-verification.md), [mesh settings](./meshing.md) and [physics limitations](./physics.md).

The `heated-fin-convection` and `heated-fin` examples, and the **Thermal bar** tutorial, use assumed illustrative aluminium constants, including conductivity 205 W/(m K), rather than certified 6061-T6 or EN 573-3 property data. Their Journals, gallery explanations and tutorial material step state that assumption. Replacing those inputs with an actual alloy data set changes the physical problem: solve it again and update the analytical reference before comparing temperatures.
