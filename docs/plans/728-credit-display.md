# Compact AI credit display

Issue [#728](https://github.com/andeplane/fem-lab/issues/728) changes the public unit
without changing prices, supplier budgets or any existing grant, hold or debit.
One public credit represents $0.001 of supplier usage. The displayed monthly
allowances are Free 5,000 after eligibility approval and an explicit claim, Plus
7,500, Pro 12,000 and Studio 37,500. Existing free grants retain their exact
199,999,980 internal subcredits: 4,999.9995 public credits display as 5,000. After
112 legacy credits of usage, 4,999.9155 display as 4,999.92.

The account client and hosted AI transport request `X-FEMLab-Credit-Unit:
usd-milli-v1`. The account response marker applies to all balance/free-allowance
amounts; streamed and replayed usage receipts carry their own marker. All numbers
remain precise in memory. Only displayed text rounds to at most two decimal
places, including the Assistant balance and cumulative usage. Plan cards import
the shared public allowance constants. Unknown units and invalid amounts fail
closed before becoming balances or confirmed tool receipts.

For an explicitly legacy or marker-absent response, the client converts once using
the shared legacy conversion and marks the normalized in-memory result. It never
converts a current-unit response twice or rounds each request to a whole credit.
Raw receipt subcredits and tariff versions remain unchanged. Identity epochs,
401 handling, free eligibility, purchase-use selection and billing gates retain
their existing behavior. A network failure causes no automatic generation retry.

Deploy the header-capable backend before publishing this frontend. It continues
serving legacy units to cached clients that do not opt in. Rollback must retain a
header-capable API while this client may be cached; the client does not retry CORS
failures or probe deployment order through mutations.

Verification covers authoritative account refresh, both receipt delivery paths,
unit negotiation, legacy conversion, double-conversion prevention, fractional
charges, unknown-unit rejection and unchanged account/checkout controls. Public
policy checks assert all four displayed allowances. Local verification on 15 October 2026 passed all 1,366 app tests (five expected
skips), all coverage thresholds and inclusion of all 91 authored modules, plus the
app TypeScript check. The production build and 67-file secret scan passed. Four
Chromium CPU checks covered anonymous account behavior, a 390px account dialog,
all plan/free allowances in public Terms, and public policy links. Account component
fixtures separately checked the exact 4,999.9155 balance displays as 4,999.92 while
remaining unchanged in memory.

Browser and Node WASM were rebuilt and optimized from this worktree's matching
Rust source (crates tree `122c7db2a4e0638653d2be85088d80afe73ccd72`), using the
release `wasm` profile. Candidate #556's artifacts were not copied because its
engine source differs. This avoids the unrelated debug-WASM boundary in #716.
These checks are local; they do not verify the deployed owner's session. This
slice performs no deployment, account funding or Stripe mutation.
