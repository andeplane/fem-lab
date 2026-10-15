# Abaqus alternate mesh data files

Issue: [#681](https://github.com/andeplane/fem-lab/issues/681).
Parent interoperability acceptance: [#650](https://github.com/andeplane/fem-lab/issues/650).

Support the documented NODE INPUT and ELEMENT INPUT parameters through the same
explicit sourceFiles bundle and dependency query used for ordinary INCLUDE files.
Paths stay relative to the submission directory and preserve case. The engine performs
no I/O. Alternate files contain only the data records of their owning keyword; inline
records combined with INPUT and any keyword in an alternate file fail explicitly.
This does not add INCLUDE splicing into an active data or keyword-continuation stream.

The existing bounded collector reads both inline and alternate records. It retains raw
physical lines, original filenames, label/connectivity order and per-file SHA-256 hashes.
ELEMENT continuations remain data records of the same owner. Source references share
existing file-count, nesting, cycle, path, aggregate-byte and expanded-byte limits;
raw records share the existing record/entity admission before owned record allocation.
Errors in a raw file keep its own location through outer owner/assembly annotations.

Verification uses independently authored unit-Tet4 geometry, exact sparse identities,
original-file digests, inline equivalence, replay, and the analytical 1/6 m³ volume.
A continued Tet10 file checks original connectivity. Negative cases cover missing,
escaping and cyclic paths, raw keywords, inline/alternate conflicts, nonfinite coordinates,
unknown nodes, incomplete continuations, record/entity admission and file/byte limits.
The existing hosts acquire the new dependencies from the registry response; no host
parser or filesystem operation is added to the engine. Composed host proof is recorded
separately from native parser checks.

Primary references: [NODE](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEKEYRefMap/simakey-r-node.htm)
and [ELEMENT](https://docs.software.vt.edu/abaqusv2025/English/SIMACAEKEYRefMap/simakey-r-element.htm).
