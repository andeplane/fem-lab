# Source-labelled nodal displacement CSV

Issue [#691](https://github.com/andeplane/fem-lab/issues/691), completing the practical
comparison workflow in [#650](https://github.com/andeplane/fem-lab/issues/650).

`file.export` accepts CSV table `nodal-displacements`. The Export dialog lists this table
separately from the existing extrema table, including independent multi-export selection.
Unknown CSV table names are schema errors, rather than falling through to extrema.

The host pins one immutable Result id and reads scientific f64 `query.surface` positions
and `query.field` displacement values for that id. Coordinates and all three displacement
components are always in metres, identified in the column names; display units do not
scale these values. Decimal formatting preserves the original binary64 value and signed
zero. Renderer Float32 staging is not used.

The source provenance comes from a captured `query.document` whose hash must equal the
Result catalogue's solved Model hash. Stale Results and mismatched documents are refused
before file delivery. This deliberately supports a current, matching solved document;
historical Results cannot acquire identities from a subsequently edited source.

Each computed row records the result, Step, zero-based FE node index, normalized imported
label, original local source label, instance, part, SI coordinates and SI displacements.
Repeated local labels on different instances remain distinct. Ordinary generated and
auxiliary nodes have blank authored identities. Unused authored nodes retain source
coordinates and identity, with empty FE index/displacement cells and `status=unused`;
they are never assigned fabricated zero results. CSV quoting preserves exact source names,
including formula-leading names: this is a machine-readable scientific interchange and
consumers interpret identity columns as text. It does not add spreadsheet-specific prefixes
or change names. A final current-document hash and retained-result status receipt rejects
edits during scientific reads before delivery.

Verification covers exact f64/SI values, original and normalized identities, quoted labels,
auxiliary and unused nodes, stale/source/result mismatches, invalid scientific layouts and
unknown table rejection at unchanged 100% registry coverage thresholds. Browser acceptance
downloads the visible export for an analytical two-instance axial bar and the unchanged
author-published Abaqus Case06, using its existing declared comparison gate. The Case06
evidence is an author-published Abaqus result, not a local Abaqus rerun; its exact CAE version
and export settings remain unknown.
