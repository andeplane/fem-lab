# Public terms and privacy notice

Issue [#646](https://github.com/andeplane/fem-lab/issues/646), part of launch #556.

Publish `/terms.html` and `/privacy.html` as static, script-free pages. They load
without Firebase, the solver or an account. Relative links work on femlab.app and
the GitHub Pages subdirectory. The landing screen and Account panel expose both
pages; landing also exposes the existing `account.open` Command. Replace landing
copy that incorrectly said hosted AI never sends data off the page.

The seller name is the Stripe account explicitly chosen by the user, Hafreager
kode & koblinger. The approved support email is andershaf@gmail.com. The Norwegian
business register confirms organisation number NO938680582, sole proprietorship
(ENK), and registered business address Gunnar Schjelderups vei 19B, 0485 Oslo,
Norway. The record reports no VAT registration, so the number has no MVA suffix.
This does not determine VAT obligations or authorize a tax registration. Owner
confirmation of tax treatment, customer markets and operational retention remains
part of launch configuration; these pages do not establish compliance.

Terms describe the existing $49/$149/$499 monthly individual plans, weighted
credits, paid-period expiry, no automatic overages, next-period plan changes,
renewal cancellation, deletion, and support. They preserve statutory remedies and
withdrawal rights rather than adding a waiver to the checkout consent. Free AI
is invitation-only and does not renew automatically, matching admission #645.

Privacy reflects ADR 0028 and `packages/service/src/privacy.ts`: local projects
and chats; hosted request context through FEM Lab to OpenAI; no transcript
archive in the account database; usage and financial references; Firebase and
Stripe; Frankfurt service/database/export placement without an EU-only provider
claim; export expiry; and durable deletion. Pseudonymous receipts currently have
no automated ledger expiry; the notice says so rather than promising a purge.

Primary sources checked 15 October 2026:

- [Brønnøysund Register Centre entity 938680582](https://data.brreg.no/enhetsregisteret/api/enheter/938680582): live API response confirms the exact business name, organisation number, ENK legal form, registered business address, and `registrertIMvaregisteret: false`. No telephone number is inferred or published.
- [Altinn website and business-document information requirements](https://info.altinn.no/starte-og-drive/drive-bedrift/juridiske-og-regulatoriske-krav/krav-til-informasjon-om-foretaket-pa-nettsider-og-forretningsdokumenter): identifies business name and organisation number disclosures and the MVA suffix for VAT-registered businesses.
- [Norwegian Consumer Council withdrawal guidance](https://www.forbrukerradet.no/angrar-du-pa-eit-kjop-nynorsk/): notice and the initial 14-day service withdrawal period.
- [Norwegian Directorate of Health information-rights guidance](https://www.helsedirektoratet.no/normen/rettigheter-ved-behandling-av-helse-og-personopplysninger/retten-til-informasjon-om-behandling-av-personopplysninger/retten-til-informasjon-etter-personvernlovgivingen): controller, purposes, recipients, retention and rights disclosure. This implements the general transparency elements; FEM Lab is not presented as a health service.
- [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data): `store: false` is distinct from abuse monitoring and API data is not used for training by default. Do not claim zero retention.

Verification: production build and bundle secret scan; Chromium public-page and
landing/account link smoke; narrow viewport; subdirectory and root page paths.
Stripe must use the deployed canonical policy URLs before paid checkout opens.
