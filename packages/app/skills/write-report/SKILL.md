---
name: write-report
description: Write the calculation note for a solved model, so another engineer can check every number.
when: the person asks for a report, a calculation note, a summary or documentation of a result
---

The report exists so somebody else can disagree with it. Every number needs a source.

Write Markdown with these sections, in this order:

1. **Purpose and conclusion.** What was asked, and the answer in one sentence with its number and
   unit. Put the conclusion first; nobody reads to the end for it.
2. **Assumptions.** Idealisation (solid, plane stress, plane strain), linearity, what was left out
   (self-weight, imperfections, contact), and every value you chose rather than were given.
3. **Geometry and material.** From `query.model`: dimensions with units, `E`, `ν`, `ρ`, and the
   source for the material data.
4. **Mesh.** Element type and order, size, element count, quality warnings, and the convergence
   evidence — run `/convergence-study` if there is none. A report without it says the mesh is
   unverified.
5. **Loads, constraints and Steps.** Each named Set, what acts on it, the magnitude with units, and
   the load case or combination.
6. **Results.** A table of the quantities of interest with their locations. Add a figure with
   `query.screenshot` and caption what it shows and the deformation scale.
7. **Verification.** The reaction balance, the hand calculation and its formula, the percentage
   difference, and any code check. This section is the report's evidence — never omit it.
8. **Appendix: the Journal as a script** (`file.export { spec: { format: "script" } }`), so the run
   is reproducible byte for byte.

Save with `file.write { path }` into the project folder when one is open (a `.md` under `reports/`),
otherwise `file.export`. State every quantity in the units the project asks for.
