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

## Verification and current state

The wizard's four public records have been captured. Cloudflare sign-in is pending an
owner action-time confirmation because its Continue button explicitly accepts its terms.
No DNS records, provider APPLY, SMTP settings, or new test email has been submitted yet.

After configuration, verify all four authoritative DNS answers, Firebase's applied
`customDomain`/`useCustomDomain`/successful state and unchanged `DEFAULT` transport. Save
public configuration/DNS evidence and a screenshot. The coordinator then controls one
fresh owner request and checks actual sender authentication, placement and link completion.
Custom-domain authentication is not proof of inbox delivery; record that result separately.

Primary references:
[Firebase managed custom sender domains](https://firebase.google.com/docs/auth/email-custom-domain),
[domain verification API](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v2/projects.domain/verify),
[verification actions](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v2/DomainVerificationAction),
[email configuration](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v2/Config),
[Firebase CLI auth provider configuration](https://firebase.google.com/docs/auth/configure-providers-cli),
[Cloudflare verification CNAMEs](https://developers.cloudflare.com/dns/manage-dns-records/troubleshooting/cname-domain-verification/).
