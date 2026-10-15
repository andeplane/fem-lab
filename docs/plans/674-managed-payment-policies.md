# Customer copy for optional Managed Payments

Issues [#674](https://github.com/andeplane/fem-lab/issues/674) and
[#695](https://github.com/andeplane/fem-lab/issues/695), part of activation
#661 and launch #556. This changes policy and account text; it does not activate
billing, configure the Dashboard, accept legal terms or establish tax eligibility.

The published Terms and Privacy pages were read over HTTPS on 15 October 2026 and
matched the main-branch files. Keep the verified operator identity, organisation
number and business address from #646. Hafreager kode & koblinger sells and provides
FEM Lab in both payment modes. For a Managed Payments transaction, Sold through
Link, LLC acts as merchant of record and facilitates the sale on the seller’s
behalf; this does not make it the seller of record. The Norway service terms
§2.1(a) establish this distinction. Earlier direct purchases retain their existing
payment arrangements.

Public policy pages cover both routes conditionally. They direct payment questions
to Hafreager for either route and offer additional Link payment support for
Managed Payments transactions. Product support stays with FEM Lab. They
explain separate merchant order accounts and data requests without promising that
FEM Lab account deletion erases an independent merchant account. USD is the list
price; checkout shows the final currency and total. Single-account subscriptions
do not imply that only consumers may purchase or that Studio includes team seats.

Account copy uses the optional public `billing.merchantMode` contract coordinated
with Stripe configuration issue #676 (`pending | direct | managed`); missing data
is treated as pending during rolling deployments. It must not
infer merchant mode from `billing.available` or tax configuration. Seller identity
is unconditional; only the explicit managed mode adds merchant-of-record wording.
The separate personal/business selector and catalog work is tracked in #680.

The optional merchant-mode field controls transaction-role wording without editing
or duplicating public types. Direct, managed, pending and missing responses all
identify Hafreager as seller and provider. Billing availability and the supported
merchant mode continue to control purchase actions independently of seller copy.

Primary sources read on 15 October 2026:

- [Norway Stripe Managed Payments service terms](https://stripe.com/en-no/legal/ssa-service-terms#stripe-managed-payments), last modified 28 September 2026: §§1.1 and 2.1(a) identify SMP and distinguish merchant-of-record handling from the seller’s product sale. §§3.3 and 4.1 govern additional refund policy and supported indirect-tax handling. This primary legal source corrects the earlier seller-role simplification in #674; details and verification are in [#695’s plan](695-seller-merchant-roles.md).
- [How Managed Payments works](https://docs.stripe.com/payments/managed-payments/how-it-works): identifies the merchant-of-record route and customer-facing Link branding, including “Sold through Link”; describes payment support, receipts and separate order management. It also supports offering subscription management through the Customer Portal from FEM Lab. Merchant branding is not hardcoded in the app or policies: the actual seller and payment terms are shown at checkout and on the receipt.
- [Tax compliance](https://docs.stripe.com/payments/managed-payments/tax-compliance): tax handling depends on supported transactions and locations. Do not claim universal tax coverage or infer an owner tax registration.
- [Eligibility](https://docs.stripe.com/payments/managed-payments/eligibility): supported products and integrations must be checked before activation.
- [Stripe privacy policy](https://stripe.com/en-no/privacy): describes order and transaction information processed when Stripe acts as merchant of record, separate end-user services and privacy rights.

Verification: account tests cover direct, managed, pending and unavailable states;
public policy smoke checks preserve operator identity and conditional merchant
wording. All changes remain preparatory while production billing is disabled.
