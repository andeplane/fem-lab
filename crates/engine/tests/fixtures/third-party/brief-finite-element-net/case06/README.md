# BriefFiniteElement.Net Case_06 — separately licensed reference data

**LGPLv3 boundary:** the third-party input, report, transcription and retained notices in this
directory are not relicensed by FEM Lab's root MIT license. The original project's
`LICENSE` is preserved byte-for-byte as `COPYING.LGPL-3`; the incorporated GPLv3 terms are
included as `COPYING.GPL-3`, fetched unchanged from the Free Software Foundation's primary
[GPLv3 text](https://www.gnu.org/licenses/gpl-3.0.txt). Retain these notices when copying this
fixture. `Job-11.inp` and `Displacements` contain no additional per-file copyright notice;
their original bytes, including all existing comments and notices, are preserved unchanged.
Attribution is to the BriefFiniteElement.Net project and its original contributors.
Original trailing whitespace and final blank lines are intentionally retained so source hashes
remain exact; `git diff --check` reports those unchanged vendor formatting details.

Primary upstream source: [BriefFiniteElement.Net Case_06](https://github.com/BriefFiniteElementNet/BriefFiniteElement.Net/tree/8e627e941aec0ad86de69e78a483a132aef8ceb5/Validation/Validation/Case_06),
immutable revision `8e627e941aec0ad86de69e78a483a132aef8ceb5`.
[The adjacent author validator](https://github.com/BriefFiniteElementNet/BriefFiniteElement.Net/blob/8e627e941aec0ad86de69e78a483a132aef8ceb5/Validation/Validation/Case_06/Validator.cs)
explicitly identifies this input and an ABAQUS nodal-displacement comparison. The author
also published the original textual probe report and displacement images. The literal report
filename in their validator differs from the published filename; we did not execute that
validator. The original author Abaqus version and CAE generation workflow remain **unknown**.
No fresh local Abaqus execution or verified modern CAE export is claimed.

`provenance.json` pins every retained original/derived file by byte count and SHA-256 and
identifies the independently preserved full author evidence package. The two unchanged
numerical originals are:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `Job-11.inp` | 22,270 | `4c68bd4b4fa0f27423a65854c49f0f2109f26e187222db302b077340433225af` |
| `Displacements` | 147,821 | `6806e99c3d4225e7de9dba98aa752e064e2fb5090e1b878f51f79b86ed762f55` |

The input defines 275 nodes, 160 C3D8 elements, one part/instance, named source sets,
`E=210 GPa`, `ν=.25`, a fixed root and four -1e6 N y-loads. Use explicit m/N units, consistent
with the author's material values and metre-labelled displacement validation. Total applied
force is `(0,-4e6,0)` N; reaction equilibrium is an independent load-sum check, not published RF.

`author-abaqus-probes-checked.json` is a **derived transcription** of the original author
report, retaining all 275 source coordinates, original printed displacement tokens and all
275 direct U vectors. All 1,005 repeated attached-element rows agree; their 1,280 total rows
are not separate nodes. The transcription is checked against the original input and report
by the network-free corpus tests. It contains no FEM Lab-computed reference values.

The Rust numerical regression added for #673 may consume these offline files; the broader
[interoperability corpus](../../../abaqus-interoperability/README.md) is owned by #656.
Original input/report bytes and oracle tolerances must stay unchanged when a numerical
implementation fails. Source admission, numerical equivalence and fresh physical validation
are distinct evidence. A separate unchanged CalculiX attempt yielded no displacement output;
it is not used as a numerical oracle for this case.
