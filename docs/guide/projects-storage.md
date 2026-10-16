# Projects, storage and sharing

A browser project is local work, not an account-synchronized cloud document. Sign-in enables hosted AI/billing; it does not upload your project catalogue or turn the account export into a model backup.

## Create and reopen projects

**New project** starts an empty Model under a new browser project. **Recent projects** and the Projects dialog reopen saved projects by their own identities. Starting another project keeps the previous saved project in this browser. Project metadata name and the engine Model name are distinct operations; use Model naming when you want the engineering document name to change too.

Autosave is on by default and saves the Journal after changes. Check the saved/pending/error status rather than assume a queued write is durable. Browser storage can be cleared, denied or lost with a profile/device change. Private browsing and storage pressure can also limit persistence.

```ts
console.log(await fem.query.projects());
console.log(await fem.query.autosaveHistory());
await fem.file.save({  });
```

`file.save` writes a portable Model file. Use it before deleting browser data, changing computers or relying on a long-lived analysis record. `project.save` commits the current browser project and thumbnail; it is not a substitute for an external backup.

## Restore and delete deliberately

`query.autosaveHistory` lists retained local revisions and distinguishes pending from saved work. `file.restore` opens a revision as a separate project, preserving the currently saved project. The retained history is bounded, so an old revision is not permanent version control.

Deleting a project removes that browser copy without Undo. Save a file first if you may need it again. Signing out or requesting account deletion leaves local Model files/projects in the browser; deleting an account does not clean up every local copy or exported file.

## Work in a folder

**Open folder** asks for browser permission. File reads/writes are scoped to that chosen folder; the host can read project instructions such as `AGENTS.md` and available skills. Reopening a remembered folder may need a fresh user gesture and permission. Closing it removes that folder capability and returns exports/saves to download behavior.

Inspect destination paths before overwriting a report or script. Folder access is a host capability and differs from an ordinary script having ambient filesystem access. See [scripting](./scripting-journal.md) and [MCP](./cli-mcp.md).

## Share a Model

`file.shareLink` compresses the Journal into the URL fragment; creating it does not upload the Model to a project server. Anyone who receives the link receives its contents. Treat it as a portable copy, including any sensitive names or definitions, rather than a revocable access-controlled document.

Share links are bounded to 32 kB encoded and 1 MiB uncompressed. For a larger Model, save and send the Model file through your chosen channel. These mechanisms share engineering definitions, not permanent session-local Result IDs or a multiuser editing session. See [import/export](./import-export.md).
