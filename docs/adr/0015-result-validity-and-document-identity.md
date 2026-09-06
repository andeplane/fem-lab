---
status: proposed
date: 2026-09-06
---

# A Model's display name changes document identity, but not Result validity

Issue #123 makes the Model name editable without resetting the analysis. The existing full
Model hash includes the name and appears in every Journal entry and replay verification.
Removing the name from that hash would weaken the document identity and change existing
saved-file hashes.

Keep the full Model and Journal hashes unchanged. Introduce a separate, internal
Result-validity fingerprint: hash the same Model parameters with only `name` replaced by
an empty string. Store that fingerprint when solving or completing a convergence study,
and compare it when reporting whether a cached Result is stale. Other fields remain in
this conservative fingerprint; this change does not introduce a general classification of
all metadata or alter numerical inputs.

`model.setName` remains a regular, transactional, journaled and undoable engine Command.
Rename and undo/redo preserve a current Result; a Result stale before renaming stays stale.
A new Model still clears cached Results. Numerical values, exported Model hashes, old
Journal hashes and replay verification are unchanged.

Alternatives rejected: excluding the name from the full hash would break the document
contract; rewriting cached Result hashes on each rename/undo would mix validity with history
bookkeeping and could accidentally revive stale results.

The host's unsaved indicator compares the complete normalized Journal with the last
successfully opened or saved Journal, not with Result validity or a revision counter.
Autosave is recovery state and does not establish that explicit save baseline.
