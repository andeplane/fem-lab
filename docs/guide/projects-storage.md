# Projects, storage and sharing

You can model, mesh and solve without an account. Anonymous projects stay in this browser. When signed in, new projects save to your private account cache and queue a cloud copy so you can reopen them on another device. Signing in does not upload existing anonymous projects: **Upload a copy** is an explicit choice for each one.

## Create and reopen projects

**New project** starts an empty Model under a new project identity. Recent projects and the Projects dialog show the current browser/account's projects. Starting another project keeps the previous saved project. The project name and engine Model name are distinct operations; changing one need not rename the other.

For signed-in projects, autosave captures the complete project locally before queuing synchronization. Its cloud bundle contains the portable engine Model, Journal and retained solved states, project metadata, exact source files captured by successful imports, and completed generated output files. Conversations are separate browser state. Granting access to a folder does not upload its unrelated contents.

Read the status: **pending**, **syncing**, **synced**, **offline**, **quota**, **conflict** or **error** describe different outcomes. A saved browser copy is not proof of a completed cloud upload. **Sync projects** refreshes account projects and retries queued work. Wait for **synced** before relying on another device to have the latest revision.

Account caches are separate from anonymous projects and from other signed-in accounts. Signing out hides the account's project rows and restores your anonymous project list; it stops that account's sync. Cached bytes may remain on the device. Signing back into the same account can recover its cache. Browser storage can still be cleared, denied or lost through storage pressure, private browsing or a profile/device change.

```ts
console.log(await fem.query.projects());
console.log(await fem.query.autosaveHistory());
await fem.file.save({ });
```

## Keep a portable backup

**Download project bundle** preserves the complete project payload and its captured original/generated files. You can also download individual retained files. A cloud project bundle is different from the legacy `femlab/1` Model file, a Journal-only share link, and the account-record JSON export. See [import/export](./import-export.md).

Use `file.save` for a portable Model file when that is the format you need. `project.save` saves the current project; it does not create an independent external backup. Keep important project bundles outside browser storage before clearing site data or making destructive changes.

## Storage limits and offline work

| Current account plan | Cloud storage quota |
|---|---:|
| Free | 100 MB |
| Plus | 2 GB |
| Pro | 10 GB |
| Studio | 50 GB |

These quotas use decimal units: one MB is 1,000,000 bytes and one GB is 1,000,000,000 bytes. The server determines the current plan and authoritative storage usage. Free cloud storage does not approve free AI eligibility or add AI credits. Larger storage quotas accompany paid plans; Studio remains a single-account plan.

Each browser project bundle is limited to **128 MiB**, with at most **64 MiB** of engine JSON, **32 MiB per captured input/output file**, and **256 files**. These binary limits use 1 MiB = 1,048,576 bytes and are separate from the account quota. A large Model or result set can hit the bundle limit even when account space remains.

Offline edits stay in the account's browser cache and queue for reconnect. Network, quota or validation errors do not mean the cloud copy was updated; keep/export the browser copy and inspect the status. A downgrade does not automatically delete existing projects. Reads and deletion remain available, but new writes can be refused until the project/account fits the current limits. Capacity can also remain unavailable while failed cleanup is retried.

## Resolve a conflict deliberately

Cloud revisions prevent one tab or device from silently overwriting a newer revision. A conflict preserves the browser bytes and identifies the remote version. **Use cloud version** explicitly restores that version; export or **Keep browser copy** first if you need the local changes. Keeping a copy creates a separate project rather than merging engineering Journals automatically.

Existing anonymous projects remain independent. **Upload a copy** makes an account-owned copy and leaves the anonymous original in place. It does not transfer ownership, remove the original or upload your other projects.

## Restore and delete deliberately

`query.autosaveHistory` lists retained local revisions and distinguishes pending from saved work. `file.restore` opens a revision as a separate project, preserving the currently saved project. Retained history is bounded; it is not permanent version control.

Deleting a project has no Undo. An offline account-project deletion must synchronize before the service receives it. Once accepted, the cloud project is no longer normally downloadable; old object cleanup can retry and has no guaranteed completion deadline. Download a backup before deleting something you may need again.

Account deletion immediately freezes cloud access and new sync, then purges cloud project objects and metadata before identity removal can finish. Cleanup failures leave deletion pending. Account-record export lists project metadata, not the project bytes: export the complete projects separately first. Deleting an account does not erase every browser cache, anonymous project or downloaded file. See the [Privacy notice](https://femlab.app/privacy.html).

## Work in a folder

**Open folder** asks for browser permission. File reads/writes are scoped to that chosen folder; the host can read project instructions such as `AGENTS.md` and available skills. Reopening a remembered folder may need a fresh user gesture and permission. Closing it removes that folder capability and returns exports/saves to download behavior.

Inspect destination paths before overwriting reports or scripts. Only files actually captured as project inputs/outputs join its cloud bundle; selecting a folder is not a whole-folder backup. See [scripting](./scripting-journal.md) and [MCP](./cli-mcp.md).

## Share a Model

`file.shareLink` compresses the Journal into the URL fragment; creating it does not publish your private cloud project or upload that link payload to a project server. Anyone who receives the link receives its contents. Treat it as a portable copy, including sensitive names or definitions, rather than a revocable access-controlled document.

Share links are bounded to 32 kB encoded and 1 MiB uncompressed. For a larger Model, use an appropriate file or project bundle through your chosen channel. A Journal share link does not carry the complete captured-file bundle or retained solved-state cache, and private account sync is not multiuser editing. See [import/export](./import-export.md).
