---
name: eurocode-1992-check
description: Sketch a NS-EN 1992-1-1 concrete check from an elastic FE result, with its limits stated.
when: the person asks for a concrete or reinforced-concrete code check on a solved model
---

**A sketch, not a code check.** An elastic FE stress field is not a design verification: EN 1992
checks sections and members, with cracking, redistribution and detailing rules an isotropic linear
solve does not model. Say this first, every time, then help with what the elastic result can support.

1. State the standard and the National Annex you are assuming (NS-EN 1992-1-1 with the Norwegian
   NA unless told otherwise), the exposure class, and every partial factor you use:
   `γ_C = 1.5`, `γ_S = 1.15`, `α_cc = 0.85` (NA-dependent).
2. Design strengths: `f_cd = α_cc f_ck / γ_C`, `f_ctd = α_ct f_ctk,0.05 / γ_C`,
   `f_yd = f_yk / γ_S`. Print the values you used with their units.
3. Load combination: ULS 6.10a/6.10b from EN 1990 with the ψ factors of the National Annex. Name the
   combination in the Step and in the report; an unnamed combination is not checkable.
4. From the elastic field, report only what it can honestly support:
   - principal compressive stress against `f_cd`, with the location;
   - principal tensile stress against `f_ctd`, flagged as *indicative of cracking*, not a capacity;
   - a strut-and-tie reading for a D-region: the compression field direction and the tie force
     obtained by integrating the tensile stress over the tie band — that force is a reinforcement
     demand you can quote.
5. End with what a real check still needs: section-level bending and shear resistance, minimum and
   maximum reinforcement, crack width and anchorage. List these as open items rather than implying
   the model passed.
