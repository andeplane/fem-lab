# Documentation keyboard readiness

Issue: [#780](https://github.com/andeplane/fem-lab/issues/780).

The published mobile browser check sent Ctrl+K after the destination article became
visible, while the new document still had `no-js`. Static HTML is readable before
the documentation module installs its keyboard handler. The failed trace reached
the correct Getting started URL and heading; it did not observe an old page.

Require the destination URL, exact heading and existing `html.js` enhancement
state before the keyboard action. Keep one shortcut attempt after readiness and
verify the actual search result, keyboard focus and destination API anchor. A
separate browser case holds the destination module response to demonstrate that
visible HTML is insufficient, then verifies keyboard search after initialization.
Do not change the documentation client, add fixed delays or retry the acceptance
action.

Verification:

- Five fresh hosted Chromium contexts passed the original flow when the module
  had initialized; no page errors occurred.
- A controlled hosted response hold reproduced `no-js`, visible Getting started
  HTML and an unhandled early shortcut. Releasing the module enabled the same
  real keyboard search and API result.
- Run the corrected documentation suite against the local build and published
  staging, including repeated cold-context navigation and the delayed case.
