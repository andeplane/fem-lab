# Authentication email sender domain

Tracks [#710](https://github.com/andeplane/fem-lab/issues/710), following
[Google sign-in](616-google-sign-in.md) and [custom-domain routing](600-domain-routing.md).

The production owner requested one real email sign-in link. It arrived within one second,
but Gmail placed it in Spam. Its default Firebase sender passed SPF and DKIM. Receipt is
proven; inbox placement and a completed email-link login are separate acceptance checks.
The message/link was not consumed during that metadata inspection.

## Smallest supported change

Keep Firebase's `DEFAULT` managed email transport and verify `femlab.app` as its sender
domain. This requires no SMTP provider, mailbox subscription, new key, backend mailer,
or change to Google OAuth. The sender domain applies to all authentication templates.

A scoped read of both project configurations found `method: DEFAULT`,
`customDomainState: NOT_STARTED`, no custom/pending sender domain, and default
`*.firebaseapp.com/__/auth/action` callbacks. The production template uses `noreply`.
Public DNS initially had `hosting-site=femlab-app` as its only apex TXT answer and no
MX or `_dmarc` TXT answers. Existing hosting/auth records must be preserved.

Firebase's production Authentication → Templates → Customize domain wizard supplied:

| Type | Name | Value | Proxy |
| --- | --- | --- | --- |
| TXT | `femlab.app` | `v=spf1 include:_spf.firebasemail.com ~all` | DNS only |
| TXT | `femlab.app` | `firebase=femlab-app` | DNS only |
| CNAME | `firebase1._domainkey.femlab.app` | `mail-femlab-app.dkim1._domainkey.firebasemail.com.` | DNS only |
| CNAME | `firebase2._domainkey.femlab.app` | `mail-femlab-app.dkim2._domainkey.firebasemail.com.` | DNS only |

Use the provider-issued values, retaining the independent Hosting TXT record. If an SPF
record appears before configuration, merge the required include into that one record;
do not create two `v=spf1` records. Verification CNAMEs must remain DNS-only and unflattened.
Production and staging have distinct Firebase projects: do not overwrite these production
DKIM selectors with another project's targets. A staging sender would need its own
reviewed domain configuration.

## API and console boundary

The Firebase CLI's `deploy --only auth` configuration supports authentication providers;
it does not expose sender-domain verification. Identity Platform documents:

```text
POST https://identitytoolkit.googleapis.com/admin/v2/projects/femlab-app/domain:verify
{"domain":"femlab.app","action":"VERIFY"}

POST https://identitytoolkit.googleapis.com/admin/v2/projects/femlab-app/domain:verify
{"domain":"femlab.app","action":"APPLY"}
```

`VERIFY` starts/checks state; `APPLY` activates the verified sender. These are mutations,
requiring `firebaseauth.configs.update`. The public response exposes verification state
and error, not a DNS-record table. Obtain exact records from the Firebase wizard. The
current v2 public discovery document omits this documented domain method; v2beta1
discovery advertises its equivalent. Do not interpret discovery omission as a completed
or tested v2 mutation.

Read back only the needed `notification.sendEmail.method`, `dnsInfo`, `callbackUri` and
sender metadata fields from `GET /admin/v2/projects/femlab-app/config`. Never dump full
configuration, SMTP credentials, password-hash configuration, or access tokens. If sender
metadata or action URL changes are needed, use a precise `updateMask` on `PATCH` config;
the browser's Firebase `authDomain` is a separate Google redirect setting.

## Configuration record: 2026-10-15

The owner completed Cloudflare sign-in and its explicit terms step. The four production
records above are saved, both DKIM CNAMEs are DNS-only, and all six pre-existing web,
API, Hosting and certificate records are preserved. Both authoritative Cloudflare
nameservers return the required TXT and CNAME answers. Staging was not modified.

Firebase accepted `VERIFY` at `2026-10-15T19:54:54.529Z`. The scoped readback at 20:13 UTC
still reports `pendingCustomDomain: femlab.app` and `customDomainState: IN_PROGRESS`.
The transport remains `DEFAULT`, and the active email callback is still
`https://femlab-app.firebaseapp.com/__/auth/action`. `APPLY` has not been submitted.
The console permits up to 48 hours for verification; the documentation describes up to
24 hours. DNS publication is complete, while provider verification remains outstanding.

Actual production owner sign-in through the normal native Chromium Firebase SDK email-link
flow passed before this sender change, preserving the existing account and allowance.
Fresh default-sender messages still landed in Gmail Spam despite SPF and DKIM passing.
Successful sign-in and Inbox placement are separate results.

After Firebase reports successful verification, apply the custom domain and read back
its applied `customDomain`/`useCustomDomain` state and unchanged `DEFAULT` transport.
Save public configuration/DNS evidence and a screenshot. Coordinate one fresh owner
request, then inspect its actual sender authentication, placement and link completion.
No post-APPLY email has been requested. Custom-domain authentication is not proof of
Inbox delivery; record that result separately before closing #710.


## Applied sender and actual Inbox delivery: 2026-10-17

At 05:46:39 UTC, one documented `VERIFY` recheck for the existing pending
`femlab.app` domain returned `SUCCEEDED`. The original request time remained
`2026-10-15T19:54:54.529Z`; this observation does not establish that every repeated
verification is read-only or preserves its request time. Both public resolvers
still returned the exact Firebase TXT/SPF and DNS-only DKIM CNAME records.

`APPLY` succeeded at 05:47:52 UTC. Scoped configuration readback confirms
`customDomain: femlab.app`, `useCustomDomain: true` and transport `DEFAULT`.
The callback remains `https://femlab-app.firebaseapp.com/__/auth/action`.
After applying, the pending verification state resets to `NOT_STARTED` and its
request time to the Unix epoch; the applied custom-domain fields, rather than
that pending-work state, establish the active sender.

Exactly one authorized fresh production sign-in message was requested through
the product UI and received at 05:49:06 UTC. It came from `noreply@femlab.app`;
Gmail labeled it `INBOX`, `UNREAD`, `IMPORTANT` and `CATEGORY_PERSONAL`, without
`SPAM`. No labels were changed or filters added. `Authentication-Results` records
SPF pass with `smtp.mailfrom=noreply@femlab.app` and DKIM pass with
`header.i=@femlab.app`, selector `firebase2`. This actual message meets #710's
sender-delivery check; it does not guarantee future Inbox placement at every
recipient. No further email is authorized by the one-message approval.

The received link was also opened through the normal Firebase action handler in
the Codex in-app browser. That did not establish a signed-in Account UI and
reported `auth/invalid-action-code`; the cause is not established. Do not treat
sender authentication or Inbox placement as proof of native Chromium account or
#775 production owned-project acceptance. Those browser checks remain separate.
The application/API traffic revision, billing, SMTP credentials and other DNS
records were not changed by this sender operation. No action code or access token
is included in this record.

Primary references:
[Firebase managed custom sender domains](https://firebase.google.com/docs/auth/email-custom-domain),
[domain verification API](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v2/projects.domain/verify),
[verification actions](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v2/DomainVerificationAction),
[email configuration](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v2/Config),
[Firebase CLI auth provider configuration](https://firebase.google.com/docs/auth/configure-providers-cli),
[Cloudflare verification CNAMEs](https://developers.cloudflare.com/dns/manage-dns-records/troubleshooting/cname-domain-verification/).
