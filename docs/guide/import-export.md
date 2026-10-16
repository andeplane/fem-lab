# Import and export

Choose a format by what it actually preserves. Geometry, finite-element connectivity, replayable engineering definitions, numerical tables and screenshots serve different purposes. A listed exporter does not imply a matching importer.

## Open a FEM Lab Model

**Open model file** / `file.open` reads a saved `femlab/1` JSON Model file, with a 16 MiB UTF-8 limit. It validates/replays the Journal. A bundled example Journal array is not the same file format; use `example.open` for bundled examples. A file containing definitions but no `solve.run` remains unsolved after replay.

Save a portable copy before replacing the current Model. Failed validation should leave the existing document intact; inspect any import error rather than repeatedly submitting the same unsupported data.

## Import STEP geometry

Choose **Import STEP geometry**, supply a Body name and physical tessellation tolerances, then select `.step` or `.stp` up to 16 MiB.

```ts
await fem.geometry.importStep({ name: 'part', linearDeflection: '0.1 mm', angularDeflection: '15 deg' });
```

The host downloads the converter on demand and runs it in a cancellable Worker. Declared STEP units are converted to metres. All converted meshes become **one tessellated Body**. Exact B-rep, CAD feature history, original face identifiers and CAD materials are not retained. Use geometric predicates for durable targets, then assign Material and mesh.

Smaller deflection can add curved detail; source tolerances can supersede it. Unsupported topology/external references, incomplete transfers and reported transfer warnings are rejected conservatively. Conversion cancellation or an intervening Model/project change prevents late publication. The Journal records ordinary imported triangles, so later replay needs neither the original STEP file nor converter. Original-file conversion is host-dependent.

`geometry.import` supports STL surface text/base64 through its schema. STL carries no units, so provide `unitLength` explicitly (for example `1 mm` for millimetre coordinates). Inspect scale, closedness and resulting target patches. There is no general public Gmsh MSH import workflow; an MSH exporter or internal reader does not establish one. Do not assume arbitrary mesh/CAD formats are accepted because FEM Lab can export them.

## Import Abaqus input decks

Choose **Import .inp**, then **Mesh and Sets** or **Linear static analysis**. Supply source Length units; static mode also needs Force units, and Time units when density is present. Display units do not select these conversions.

Supported source solids are C3D4, mean-dilatation C3D8, C3D10 and full-integration C3D20. Parts, transformed assembly instances, source labels, exact Sets and supported material regions are preserved. Static conversion includes isotropic elasticity, translational supports/displacements, nodal forces, face pressures and multiple supported linear-static cases. Inspect the receipt's source-to-FEM Lab name mappings.

Select the submission folder for `INCLUDE` and NODE/ELEMENT `INPUT=` dependencies. Paths are submission-relative and case-sensitive; inline tooling can provide exact UTF-8 `sourceFiles`. The total deck/dependencies have a 16 MiB UTF-8 limit. Saved Models carry the checked definitions and no longer require the source files.

Import does not solve: solve each named Step explicitly. Nonlinear/contact source analyses, unsupported formulations and binary `.odb`/`.cae` files are not silently downgraded. Reduced-integration, hybrid and modified elements are rejected rather than substituted. Export a supported text `.inp` from the source application.

## Export the right artifact

| Format | Use |
|---|---|
| Model JSON (`femlab/1`) | Portable definitions and Journal for reopening/replay. |
| TypeScript Script | Read or modify the engineering operation sequence. |
| VTU | Mesh and available Step fields for tools such as ParaView. |
| MSH, INP, STL | Supported mesh/surface interchange; not a universal complete-analysis round trip. |
| CSV | Extrema, reactions, path samples or nodal displacements. |
| PNG / WebM | Viewer image or selected mode-shape sweep; these are presentation artifacts. |
| Markdown report | Calculation note with assumptions, mesh, conditions, Results and Journal. |

```ts
await fem.file.export({ spec: { format: 'csv', table: 'nodal-displacements', step: 'static' } });
```

Nodal-displacement CSV preserves scientific f64 coordinates and three displacement components **in metres**, with normalized labels and original node/part/instance identities. Unused source nodes have blank displacements and an `unused` status. Identity columns must be treated as text. Stale/changed source Results are refused before delivery.

Exports go to an open permitted project folder when selected, otherwise to a download. Inspect the exact completed filename and byte receipt; an expired retained download can be regenerated from the appropriate Model. See [storage](./projects-storage.md) and [Results](./results-verification.md).

## Portable solved projects

The headless engine additionally exposes `query.portableProject`, an owned `femlab-project/1`
artifact for project-storage hosts. It includes the ordinary `femlab/1` Model and Journal plus
all currently retained simulation results: their solved Models and fingerprints, exact meshes,
resolved Sets, f64 fields, modes, frame histories, harmonic sweeps, convergence/adaptation report tables and solver diagnostics.
Restoration uses an unpublished replacement candidate and preserves those values without
running the simulations again. A corrupt or incompatible artifact leaves the open project
unchanged. Ordinary `.femlab.json` files continue to contain inputs only.

Version 1 supports the exact engine version, eight retained results, and at most 64 MiB of
UTF-8 JSON. Projects exceeding that artifact limit cannot be captured or restored through this
boundary. Results already evicted by the engine's retention limit are not recoverable from a
later snapshot. Model fingerprints identify the saved inputs; they do not certify an imported
answer's physical correctness. Account ownership, cloud synchronization, original imported
files and completed output bytes are responsibilities of the surrounding project-storage host.
