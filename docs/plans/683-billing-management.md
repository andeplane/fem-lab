# Billing management during a sales pause

Tracks [#683](https://github.com/andeplane/fem-lab/issues/683), following the
[frozen purchase contract](680-purchase-use.md) and
[merchant responsibility decision](../adr/0032-billing-merchant-responsibility.md).

`billing.available` admits new Checkout and plan-change requests. Pausing it does
not prevent an existing customer from opening Stripe's hosted Portal to cancel
renewal or manage payment details. The independent `billing.canManage` signal is
true only when the service has its configured payment gateway and an active
account owns a customer mapping. The public response never exposes the customer
ID. Older hosts can omit the field; the app then hides management.

A refund/dispute financial-review freeze still blocks purchases and plan changes,
but does not block owned Portal access. Verified authentication, strict rejection
of customer/return overrides and a fresh active-account check protect the Portal
route. Missing customer mappings cannot create a Portal session or a new customer.
The HTTP route still fails closed when its payment gateway is not configured.

Recovery continues for previously accepted pending plan changes during a sales
pause. The version, target price, purchase use, account/customer ownership, active
period and financial-review guards from #680 remain authoritative; recovery does
not accept a new purchase or silently rebuild an old intent. Global merchant/tax
selection does not convert an existing subscription.

Verification uses real PostgreSQL and the HTTP host for paused/frozen owned Portal
access, public availability, absent/foreign mappings and rejected overrides. It
also exercises inactive accounts after an earlier identity read, paused recovery
with the original operation key/price, and refusal of unversioned, frozen or deleted
recovery targets. UI tests keep management available for a frozen paid customer
while all new plan controls are disabled, and hide it for a no-customer account.

Stripe supports Portal management for Managed subscriptions as documented in
[How Managed Payments works](https://docs.stripe.com/payments/managed-payments/how-it-works).
This change does not modify registrations, tax decisions or Stripe/cloud settings.
