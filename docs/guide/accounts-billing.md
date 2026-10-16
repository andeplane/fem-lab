# Accounts, AI credits and billing

Local modeling, meshing and solving do not require an account or AI subscription. Sign-in is needed for hosted AI and private account project sync. Account state and payment actions are separate from the engine Model and are never entries in its engineering Journal.

## Sign in and review your allowance

Use the sign-in action on home or in the header. Choose Google or enter your email and open the newest sign-in link in the requesting browser. If the link opens elsewhere, complete the email prompt as needed. A completed login verifies account access; it does not automatically approve free eligibility or establish a unique person.

After sign-in, the home screen becomes your workspace overview, showing your account email and available plan/allowance information alongside local projects. Use the avatar/email control in the header to open your profile menu, then **Account & AI settings** for your identity, AI allowance, subscription and account records. **Sign out** ends hosted access without removing local projects.

The account overview shows available, total and reserved credits, the allowance expiry and current billing status when those values have loaded. Refresh reads authoritative service state. Loading, a failed refresh or missing account data is not a zero-credit balance or proof of a free plan: read the status and retry the refresh before interpreting your allowance. A disabled claim or purchase button should be read with the accompanying status; repeated clicks or account recreation do not bypass it.

New projects created while signed in save locally and queue a private cloud copy. Existing anonymous projects stay local unless you explicitly choose **Upload a copy**, which leaves their originals intact. Signing out hides the account cache and returns to anonymous local work. Check sync status before relying on another device; see [projects and storage](./projects-storage.md).

## What an AI credit means

One public AI credit represents **USD 0.001 of supplier/model usage**. It is a cost-budget unit, not a raw input/output token. Model choice, output/reasoning, cached input, conversation/tool context and images can change consumption. The UI rounds the display; internal accounting retains exact integer subcredits, so small requests do not each get rounded into a larger charge.

| Offer | Included public AI credits | USD subscription price before applicable tax |
|---|---:|---:|
| Reviewed free monthly | 5,000 | No subscription charge; approval and explicit claim required |
| Plus | 7,500 per paid period | $49 / month |
| Pro | 12,000 per paid period | $149 / month |
| Studio | 37,500 per paid period | $499 / month |

Account totals and debits retain exact internal precision; display rounding does not add credit or round each request up. These are included allowances; there is no automatic paid overage or rollover.

## Included cloud storage

Free accounts have 100 MB of cloud project space; Plus includes 2 GB, Pro 10 GB and Studio 50 GB (decimal units). This is separate from AI credits and free-AI approval. The server reports actual quota/usage. Downgrading preserves stored projects and read/delete access, but writes can be blocked above the current limit; it does not automatically delete projects. Browser bundle/file limits are separate. See [storage and recovery](./projects-storage.md#storage-limits-and-offline-work).

## Free monthly access

Signup starts at zero. Request an eligibility review through the Account support link. After approval, explicitly choose **Claim this month's free allowance** for the current UTC calendar month. Unused credits expire at 00:00 UTC on the first of the next month, even for a late claim. Each new month needs another explicit claim.

One reviewed person can claim once per month across approved aliases and account recreation. Deletion/reopening does not reset the month or transfer an earlier account's credits. Eligibility can be revoked. Free monthly credits do not stack with an active paid allowance, and shared service budgets/capacity can temporarily pause claims or requests. These pool limits are operational configuration, not a permanent marketing promise.

## Subscribe, change or cancel

Choose a tier and declare personal or business use when requested. That choice remains fixed for the subscription. Checkout shows the applicable tax, payment terms and final total. Hafreager kode & koblinger sells/provides FEM Lab; when Managed Payments is used, Stripe handles the merchant-of-record transaction. Consult the [Terms](https://femlab.app/terms.html) for current seller, support and statutory-rights information.

Credits follow the canonical paid invoice, not the browser's return from Checkout. A pending/failed payment or expired unpaid Session is not an entitlement. Plan changes are scheduled for the next paid period; current credits remain unchanged. **Manage subscription and payment** opens the owned management flow, including cancellation. Cancellation stops renewal at the period end rather than silently deleting the current paid period.

## Export or delete account data

Account-record JSON export contains service records and a cloud project metadata index, not project artifact bytes, captured files, Results or chats. Download complete project bundles separately before deletion. Deletion requires typing DELETE and immediately freezes cloud/AI access; durable processing cancels renewal and purges cloud project objects/metadata before removing the identity. Failed cleanup keeps deletion pending, with no guaranteed completion deadline. Required financial records and pseudonymous reviewed-eligibility/abuse-prevention markers can remain as described in the [Privacy notice](https://femlab.app/privacy.html). Browser caches, anonymous projects and downloaded files remain yours to manage. Signing out clears hosted access while anonymous local modeling remains available.
