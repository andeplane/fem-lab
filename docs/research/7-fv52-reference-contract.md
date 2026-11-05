# FV52 reference semantics and accepted fixed-deck checks (#7)

The remaining work in [#7](https://github.com/andeplane/fem-lab/issues/7) was D3.
D4's independent manufactured L2/full-displacement-gradient H1 gates and finite-width
VM142's published-geometry gates had already shipped through #630 and #626.

[ADR 0051](../adr/0051-fv52-fixed-deck-is-not-a-continuum-reference.md) records why
a single continuum target cannot be selected from the two differently attributed
published FV52 columns. The 2025 Abaqus input/result pair defines a reproducible
**discrete** comparison. The 2022.3 Altair primary discussion explains why its
few-element reference is unsuitable as a refined singular-solid continuum limit.
This is a correction to the old verification assumption, not a claim that the
publishers' original NAFEMS attributions have been reconciled.

## Fixed physical and numerical contract

`crates/femlab/benches/cases/fv52-published-hex20-deck.json` is the installed,
public-Command Benchmark. It reconstructs the linked `nfv52fkc.inp` active mesh:
16 full-integration Hex20 elements and 155 active nodes, a 10×10×1 m plate with
z from −0.5 to 0.5 m. E=200 GPa, nu=0.3 and rho=8000 kg/m³. Only UZ is fixed
at the 32 nodes of the bottom perimeter. The source deck generates additional
unused nodes; those are not physical DOFs in its 16-element model.

All seven computed C3D20 frequencies are gated at the unchanged 3%, rather than
selecting one of the two disputed NAFEMS rows. Three additional zero-frequency
bounds, exact mesh counts and retained-result freshness complete the CLI checks.
The registry regression independently projects the three rigid modes onto the
analytic Tx/Ty/Rz span, requires rank three, and compares all ten mode fields and
summary payloads exactly at one and four workers.

## Enlarged-spectrum study

Run the current-source release CLI, then:

```sh
python3 tools/verify-fv52-deck.py --native /path/to/femlab --out /new/evidence/path
```

The harness retains 24 mode shapes on each of the original three nested full Hex20
grids, at one and four workers. Each process has the unchanged 180-second/2-GiB
guards and measured backward residual at most 1e−10. The first three fields must
span the allowed rigid motions. Physical quarter-turns of displacement and node
position must remain within each same-frequency modal subspace through mode 20;
four extra modes prevent the measurement window from cutting a repeated pair.
The relative subspace tolerance is 1e−6, while frequencies are clustered at 1e−7
relative tolerance. These gates are fixed before the first run.

For conforming nested spaces and nested homogeneous boundary traces, the min-max
principle requires nonincrease of each indexed eigenvalue. The first seventeen
elastic frequencies are gated accordingly, with 1e−8 relative arithmetic allowance.
The square's symmetry gates check repeated-subspace completeness under that symmetry;
they do not certify that no unrelated eigenpair was omitted. Neither a lowest-spectrum
certificate nor a singular-edge asymptotic convergence rate is claimed.

The historical ten-mode #639 outputs and their original producer/hash record remain
unchanged in [the original report](639-fv52-solid-investigation.md). Their original
one/four-thread counterexample was repaired separately by #640. The new run supplies
new evidence instead of rewriting those old observations.
