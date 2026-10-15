---
status: accepted
date: 2026-10-14
---

# Schema metadata presents Material physics and Step procedure fields

The registry stays one headless, host-independent Command surface (ADRs 0003 and 0012).
A Material is one definition across physics; `material.add` remains one complete replacement
and one Journal entry. Splitting it into thermal, structural and plasticity Commands would
expand the AI tool surface and complicate replay and complete-definition editing.

Rust schema annotations describe presentation as well as validation. `x-physics` assigns each
Material field one group: `stiffness`, `mass`, `thermal`, `expansion`, `plasticity`, `anisotropy`,
or `common`. Common identity and provenance fields always show. Procedure variants expose
`x-material-physics` for suggested groups; `x-material-properties`, `x-material-needs` and
`x-results` describe consumed properties and produced Results. Step fields use `x-procedures`
with procedure names or `*` for shared fields. Generated schemas carry these annotations to
hosts and AI tools without changing Command arguments or Journal bytes.

A Material form initially selects the groups suggested by the Model's Steps, active gravity
and temperature Loads, and already defined properties. A heat Step suggests thermal and mass;
its exact requirements still distinguish steady conductivity from transient heat capacity.
With no Steps or properties, stiffness is the starter group. Fields are ordered by suggested
groups, so the heat form leads with conductivity and specific heat. Existing values select
their own groups too, making a thermoelastic definition inspectable. Optional Orthotropic
fields follow their own physics tags; its required stiffness fields remain visible whenever
the Orthotropic group is shown, because the current block schema requires them.

Chips dispatch the host `form.open` Command with explicit `materialPhysics` view state. Every
field edit and Revert preserves that selection. Hiding a group changes presentation only:
its values stay in the full argument object, remain visible in the recorded Command preview,
and are submitted unchanged. A fresh form derives its groups again. This view state is never
recorded in the engine Journal. Step procedure selection follows the same preservation rule
for fields that become hidden.

Field doc strings explain quantities and alternatives in both the Properties panel and the
AI's tool schema. Schema traversal tests require every Material field to have exactly one
physics tag and a meaningful description. Form tests verify conditional visibility, ordering,
callable chip changes and preservation through editing, Apply and Revert. Chromium checks
exercise the production form against the real engine. These tests cover UI/schema behavior;
existing numerical Benchmarks continue to own physical validation.
