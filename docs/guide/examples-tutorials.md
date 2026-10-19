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
5. Use **Journal as program** and **Solve cost and solvers** when repeating analyses or growing a Model.

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

The exact catalogue is generated from the shipped Journal fixtures and metadata; the list above is a learning selection.

## Keep a comparison record

Before changing an example, save a portable Model file or keep it as a separate project. Change one assumption at a time, solve the named Step again, and write down the quantity and units being compared. A tutorial's reference value is tied to its stated geometry, boundary conditions and formulation; it is not a target to force a different model to match.

The repository's [Benchmark record](https://github.com/andeplane/fem-lab/blob/main/docs/BENCHMARKS.md) documents analytical/reference cases and convergence tests. For interpreting disagreement, start with [verification](./results-verification.md), [mesh settings](./meshing.md) and [physics limitations](./physics.md).
