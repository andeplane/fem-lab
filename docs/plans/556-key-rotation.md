# Key rotation evidence

Tracks [#556](https://github.com/andeplane/fem-lab/issues/556).

The [dated activation record](661-stripe-activation.md#initial-verified-configuration)
records revocation of an exposed full-access Stripe TEST key, replacement with a
restricted key and pinned runtime installation. The fresh
[canonical TEST recovery](556-stripe-recovery.md) subsequently performed 48 SDK
GETs successfully with the restricted credential. Those are actual provider-key
receipts with their original source/date boundaries.

At 09:23:51 UTC on 5 November 2026, the existing authenticated Google operator
also exercised Secret Manager version pins using a new QA-only synthetic value.
No IAM grants or service identities were added. Version 1 and a different version
2 were each resolved through explicit numbered references into a local Node
runtime fingerprint checker. Adding version 2 left the version-1 pin unchanged.
Disabling version 1 made explicit old-pin access fail; version 2 still resolved
and matched its expected fingerprint. The QA secret was deleted and independent
readback confirmed it absent.

This fresh exercise proves immutable Secret Manager pin and disable behavior
under the existing operator identity. It did not rotate a production credential
or deploy a new provider key into Cloud Run. Actual source/image configuration
preservation and numbered service secret references are separately checked by the
API/recovery release procedure. No secret values, OAuth tokens or credential
files are included in the retained proof.
