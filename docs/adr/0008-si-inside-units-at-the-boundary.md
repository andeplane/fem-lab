---
status: proposed
date: 2026-09-05
---

# SI internally; every Command input that is a physical quantity carries a unit

Abaqus has no units and its users pay for it in N/mm² confusion every week. The Model stores
SI (m, kg, s, Pa, K) and nothing else. Every Command schema field that is a physical quantity
is a `Quantity` (value plus unit string) validated for dimension, so `pressure: "2 MPa"` and
`length: "250 mm"` are accepted and `pressure: "250 mm"` is a schema error before anything
runs. The UI displays in the user's chosen unit set; the AI reads and writes unit strings,
which is how it reasons about them anyway. This is one of the few places the incumbents are
wrong that costs nothing to get right at the start and everything to retrofit.
