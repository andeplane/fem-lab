# Customer copy for optional Managed Payments

Issue [#674](https://github.com/andeplane/fem-lab/issues/674), part of activation
#661 and launch #556. This changes policy and account text; it does not activate
billing, configure the Dashboard, accept legal terms or establish tax eligibility.

The published Terms and Privacy pages were read over HTTPS on 15 October 2026 and
matched the main-branch files. Keep the verified operator identity, organisation
number and business address from #646. Direct purchases retain Hafreager kode &
koblinger as seller. Only a purchase using Managed Payments is sold by its merchant
of record, identified in that purchase’s checkout and receipt. Do not relabel old
direct purchases or infer the seller from whether billing or automatic tax is on.

Public policy pages cover both routes conditionally. They direct payment questions
to the seller’s receipt/support route and keep product support with FEM Lab. They
explain separate merchant order accounts and data requests without promising that
FEM Lab account deletion erases an independent merchant account. USD is the list
price; checkout shows the final currency and total. Single-account subscriptions
do not imply that only consumers may purchase or that Studio includes team seats.

Account copy uses the optional public `billing.merchantMode` contract coordinated
with Stripe configuration issue #676 (`pending | direct | managed`); missing data
is treated as pending during rolling deployments. It must not
infer merchant mode from `billing.available` or tax configuration. Until the actual
managed Checkout seller is verified, keep generic managed/pending text: “Seller
and applicable tax are shown at checkout.” Do not add a speculative personal versus
business purchase selector before the supported tax-category/catalogue route is
settled with the activation work.

The optional field is feature-detected so this copy can ship before #676 without
editing or duplicating its public types. Only the exact `direct` value identifies
Hafreager kode & koblinger as seller for new purchases. Managed, pending and missing
values keep neutral checkout wording. Billing availability continues to control
purchase actions independently of the copy.

Primary sources read on 15 October 2026:

- [How Managed Payments works](https://docs.stripe.com/payments/managed-payments/how-it-works): identifies the merchant-of-record route and customer-facing Onelink branding, including “Sold through Onelink”; describes payment support, receipts and separate order management. Naming is documented here, but app copy does not claim that an actual FEM Lab managed checkout has been verified.
- [Tax compliance](https://docs.stripe.com/payments/managed-payments/tax-compliance): tax handling depends on supported transactions and locations. Do not claim universal tax coverage or infer an owner tax registration.
- [Eligibility](https://docs.stripe.com/payments/managed-payments/eligibility): supported products and integrations must be checked before activation.
- [Stripe privacy policy](https://stripe.com/en-no/privacy): describes order and transaction information processed when Stripe acts as merchant of record, separate end-user services and privacy rights.

Verification: account tests cover direct, managed, pending and unavailable states;
public policy smoke checks preserve operator identity and conditional merchant
wording. All changes remain preparatory while production billing is disabled.
