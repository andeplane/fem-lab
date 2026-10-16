---
status: accepted
date: 2026-10-16
---

# Portable project artifacts retain solved context independently of Model files

Issue #779 supplies the scientific persistence boundary required by cloud project sync (#774,
#775). `femlab/1` remains the input-only Model snapshot and Journal format. Changing its default
export to include fields would make existing Model-file size guarantees misleading and break
input-only workflows.

Add `femlab-project/1`, an explicitly versioned artifact containing the unchanged Model file,
the retained insertion-ordered solve cache, convergence/adaptation report tables and its decimal identity sequence. Each result owns
its solved Model, input and Model hashes, exact finite-element Mesh and resolved Sets, scientific
f64 fields, modes, histories, sweeps, reactions and solver diagnostics. Renderer f32 arrays are
never persistence inputs. A checked `query.portableProject` captures this as one owned read;
the enclosing ReadReply supplies session/version identity. User identity and storage I/O belong
to hosts and are never embedded as engine authority.

Restoration builds a private replacement Candidate. It checks the complete artifact, replays
only the current Model's Journal with solves skipped, checks its snapshot hash, installs
validated retained records, and publishes only through the existing replacement ticket. An
error leaves the active owner unchanged. Restoring results never calls a numerical procedure
or remeshes a solved result. The ordinary current-model mesh remains a lazy derived cache.

Version 1 accepts the exact engine version, at most eight retained results and 64 MiB of UTF-8
JSON. Bounds, connectivity, resolved selection indices, field layout, finite numerical values,
frame schedules, sweep layouts and model fingerprints are checked before publication. Hashes
identify stored inputs; they are not signatures or evidence that an imported answer is physically
correct. Verification against analytical benchmarks and engineering judgment still applies.
Original input bytes and completed host output files belong in the host's enclosing bundle;
they must not be reconstructed from screenshots or rounded renderer values.
