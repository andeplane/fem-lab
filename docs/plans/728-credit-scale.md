# Thousands-scale AI credits

Issue [#728](https://github.com/andeplane/fem-lab/issues/728); decision
[ADR 0039](../adr/0039-public-ai-credit-unit.md).

Show Free 5,000, Plus 7,500, Pro 12,000 and Studio 37,500 credits. One public
credit represents USD 0.001 of supplier usage. Paid prices remain USD 49/149/499
per month before applicable tax. Free access still requires review and an explicit
monthly claim; one identity, one month, expiry, revocation and service budgets keep
the same enforcement. This is a unit change, not more usage or a per-request fee.

Implement request-unit negotiation, exact raw-subcredit balance/receipt conversion,
response markers and legacy compatibility. Keep all allocation/tariff/history
values byte-for-byte unchanged. Account exports add an explicit raw-unit descriptor.
Central registry constants define public quantities and the one legacy conversion.
The UI requests the new unit, normalizes older unmarked responses once, rejects
unknown units and formats at most two decimal places. Public copy and descriptive
Stripe manifests use the same quantities and explicit unit.

Deploy the backend first and retain its header capability while cached new clients
exist. Publish the frontend after readiness and successful release. The release
owner updates all relevant Stripe Product descriptions/metadata with canonical
readback, preserving Product/Price identities, amounts, tax classifications and
live activation flags. Source manifests in this stacked change retain their base
activation settings; the release owner copies only credit-unit quantities into
the active launch configuration. No paid charge or new AI request is needed to
verify a representation change. Compare the existing owner's old/new public
account/receipt responses against the same immutable database rows.

## Local verification

On disposable PostgreSQL 17 at port 16458:

```sh
TEST_DATABASE_URL=postgres://femlab728@127.0.0.1:16458/femlab728 npm run test -w packages/service
npm run build -w packages/service
npm run test -w packages/registry
npm run typecheck -w packages/registry
python3 -m unittest discover -s infra/stripe -p 'test_*.py'
```

252 service tests pass, including real account/claim HTTP negotiation, legacy
responses, exact 3-subcredit cached usage, immutable grant/debit/receipt snapshots,
and SSE/status/cross-unit replay without another provider dispatch. All existing
monthly identity, funding, revocation and paid-dispatch regressions still pass.
193 registry tests pass with 100% statements, branches, functions and lines.
Both packages typecheck. Frontend and release evidence follow in the issue/PR.

The PR initially stacks on #718's reviewed-free-allowance branch. Retarget after
that foundation merges; never include unrelated engine changes in the focused
deployment candidate merely to bring the PR base up to date.
