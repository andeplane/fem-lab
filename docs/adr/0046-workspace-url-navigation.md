---
status: accepted
date: 2026-10-19
issue: https://github.com/andeplane/fem-lab/issues/808
---

# Workspace navigation in browser history

The main menu, examples and saved workspaces previously shared one URL. Opening an example
replaced the workspace without creating a history entry, so browser Back could leave the app.

Use `#/`, `#/examples` and `#/projects/<encoded browser-project id>`. Hash routing works with
the same static entry point on Firebase Hosting and GitHub Pages, including `/fem-lab/`, without
requiring a server rewrite or duplicating the hosting configuration. The tradeoff is the hash
in the address. Existing `#j=` Journal links and `#tutorial=` links retain their syntax and
their existing replay semantics; `?example=` remains supported.

The router belongs to the browser host above replaceable engine sessions. Its history and
workspace interfaces are injected. UI navigation still uses registered Commands, including
`navigation.home` for the logo. Back/Forward restores through the active owner's ordinary
`project.open` path. A same-project return only closes overlays; it does not replace the engine.
An opened example gets its saved project URL, so refresh restores edits and retained Results
instead of replaying the example again. With autosave enabled, a newly opened Model/example's
first complete artifact is saved before recording its URL. Restores reuse the already claimed
artifact without uploading an unchanged cloud revision. Empty new projects keep ordinary
autosave batching. Autosave-off retains its existing limitations.

URLs are browser-project pointers, not sharing grants: ids may differ in another browser or
account. Identity changes invalidate pending route opens and replace the private workspace URL
with the menu. Missing or inaccessible ids show a structured error at the menu. Existing storage
ownership and session admission checks remain authoritative. No engine Command, URL, or history
entry grants access to another owner's project.
