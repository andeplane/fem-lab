# Abaqus assembly and provided-source normalization

Issue [#653](https://github.com/andeplane/fem-lab/issues/653), part of
[#650](https://github.com/andeplane/fem-lab/issues/650). Persistent source regions and
identity are [#652](https://github.com/andeplane/fem-lab/issues/652), analysis mapping is
[#654](https://github.com/andeplane/fem-lab/issues/654), quadratic source validation is
[#655](https://github.com/andeplane/fem-lab/issues/655), and host acquisition is
[#657](https://github.com/andeplane/fem-lab/issues/657).

The normalizer is a headless, deterministic transformation of supplied source snapshots.
It does not read paths, weld coincident nodes, solve, or publish a model. It keeps original
keyword/data locations and passes typed analysis blocks to the analysis mapper. There is
no intermediate generated input file.

## Semantics

- Quote-aware fields preserve quoted case, spaces, punctuation and filename case. Unquoted
  labels are case insensitive; qualified references split periods outside quotes.
- Flat decks retain their numeric labels. Assembly instances receive deterministic global
  labels in instance declaration order and local label order, with original instance, part
  and local labels retained in persistent provenance. Two instances never share a node
  merely because their coordinates coincide.
- A part mesh is inherited, or an empty part has a mesh on each instance. Inherited meshes,
  sections, sets and surfaces cannot be overridden on an instance. New instance sets and
  surfaces may refer to inherited entities. Assembly sets can span instances.
- Instance translation precedes the right-handed rotation about the supplied axis. The
  transformation changes geometry; it does not reinterpret global nodal force components
  or invent a local nodal `TRANSFORM`.
- Part sections are instantiated as typed scoped analysis records before step history.
  The analysis mapper resolves each region and preserves its material assignment.
- `C3D10` and `C3D20` connectivity continuation retains the exact Abaqus local node order.
  Reduced-integration element names are never silently substituted with full integration.
- Includes resolve only against supplied submission-directory-relative names, with exact
  filename case. Include paths do not become relative to the including file's directory.
  Missing files are discoverable through a pure query; actual conversion requires them.
  Cycles, traversal, excessive depth, more than 128 provided files, aggregate input above
  16 MiB and expanded input above 16 MiB are errors. File hashes and the root name persist.
- Analysis and output records are passed through explicitly. Unknown physical intent is
  rejected by the mapper; mesh-only mode cannot silently drop an analysis.

## Verification

The independently authored `assembly-two-instances.inp` fixture exercises two instances
of one part with repeated local labels, quoted labels containing punctuation, a translation
followed by a 90-degree rotation, inherited and instance sets, assembly union sets and
surfaces. Its transformed coordinates, exact identities/memberships and Journal replay
have direct assertions. It is a syntax fixture, not evidence of an actual CAE export.

Pure graph tests cover nested includes, case-sensitive names, missing-file discovery,
original locations, cycles, traversal, malformed syntax and resource limits. An invalid
included scope must identify the original include filename and line. Unsupported physical
records adjacent to valid structural data must fail rather than disappear.

Reference semantics: [Input Syntax Rules](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEMODRefMap/simamod-c-inputsyntax.htm),
[Assembly Definition](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEMODRefMap/simamod-c-partassy.htm),
[INSTANCE](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEKEYRefMap/simakey-r-instance.htm),
[NSET](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEKEYRefMap/simakey-r-nset.htm),
[ELSET](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEKEYRefMap/simakey-r-elset.htm), and
[INCLUDE](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEKEYRefMap/simakey-r-include.htm).
