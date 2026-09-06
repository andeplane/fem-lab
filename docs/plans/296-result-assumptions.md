# Solver-used Result assumptions (#296)

This is the assumption-log child of #24. Material catalogue data is #295; retained Result
identity and lifetime are #280, and solve-input fingerprints are #123. This change stores
assumptions in the existing `StepResult`, so a future retained Result carries the same snapshot.

The Model-to-Problem boundary represents omitted rho, alpha, k and cp as zero. Existing
procedure validation rejects a missing k for heat, missing rho or cp for transient heat, and a
zero mass for modal or explicit dynamics before those values can produce a Result. Record an
omission only when the successful procedure reads that property for a material assigned to an
actual nonempty mesh block. Report the solved Step, material and body names, property, SI
quantity, cause and material provenance as they were at solve time. Explicit zero is an input
and never an assumption. Unassigned/unused materials never appear. A failed solve must leave
the previous Result and its assumptions intact.

Audit of existing read paths:

- Structural gravity reads rho; modal and explicit mass assembly also read rho.
- Structural assembly with a resolved temperature field reads alpha, including chained heat.
- Heat conductivity assembly reads k; transient capacity reads rho and cp.
- Yield strength is a postprocessing limit, not an implicit solver default.

This does not introduce defaults or change admissibility rules. Existing missing-property
validation remains effective. Any independently discovered invalid-input behavior gets a
separate issue and regression instead of an unreviewed material-policy change here.

Expose typed assumptions on `query.result` and solve summaries. Keep the snapshot independent
of later Model edits, renames or units; host display can show the captured SI unit. The Assistant
must render these records from successful tool results, including solve results returned by a
script, without relying on generated prose or truncating them inside the generic JSON preview.

Verification covers used and unused omitted properties, explicit zero, named body/material
scope, source retention, stale Results after edits/rename, replay and a subsequent successful
solve. Existing independent physics benchmarks and meaningful full coverage remain required.
