# Browser requirements and troubleshooting

Chromium is the supported browser. Start with a current Chrome/Chromium installation and the public app or a correctly configured development server. WebGPU enables an available GPU path; the app announces CPU fallback rather than pretending the GPU ran. Shared memory and cross-origin isolation are needed for its multithreaded browser engine.

## Read capability status first

The engine chip reports local CPU/GPU and the actual initialized worker count. Capability notes explain missing WebGPU, an unavailable adapter or a reduced thread pool. Other browsers are best effort, not an alternative supported test target.

```ts
console.log(await fem.query.capabilities());
```

A software GPU adapter is useful for correctness tests and is not a performance reference. GPU availability also does not make every procedure use a GPU solver. See [Steps and solvers](./steps-solvers.md).

## Startup or a blank page

Wait for the startup status to finish, then use its Retry control after a transient failure. Keep the original tab/project state while diagnosing; a fresh tab in the same browser can help distinguish one tab's presentation problem. Save a portable Model before clearing site data, since browser projects are local.

For a local build, serve the app through its documented development/preview server. Opening `index.html` directly or using a server without required isolation/resource headers is not equivalent. Browser extensions, privacy settings, blocked workers and revoked permissions can change behavior. Record the URL, browser version, engine notes and exact error when reporting an issue; do not attach account tokens or sign-in links.

## Solve or model errors

| Symptom | First useful checks |
|---|---|
| Missing-material/property warning | Assignment and the active Step's required stiffness, mass or thermal properties. |
| Unconstrained/singular system | Each disconnected component's supports, correct Set membership, rigid modes and coupling. Free-free modal/dynamic cases have different rules from static equilibrium. |
| Empty/wrong Load target | Set definition, mesh coverage, import label scope and Step active lists. |
| Stalled iterative solve | Model conditioning and Constraints; consider direct solve only if it fits and the procedure supports it. |
| Memory/size refusal | `query.cost`, mesh size/order, retained time frames and available device memory. |
| Stale Result | Re-solve, or explicitly inspect the retained original solved context. |
| Unsupported operation | The exact procedure/element/host restriction; do not substitute a different physical formulation without reviewing it. |

## Sign-in, credits and files

An iCloud Passwords or other password-manager popup in the analysis prompt comes from your browser or password manager. The prompt and project name are plain text and request that autofill be turned off; FEM Lab sign-in uses Google or an email link and does not ask for a password. Password managers can ignore autofill hints. Dismiss an unrelated popup with Escape; use the actual **Sign in for AI** action when you want to sign in.

Use the newest email link, check Spam, and return to the requesting browser. Google sign-in offers another configured route. Report repeated failures with the error code, not the private link. Zero signup credits, review-required free access and disabled claims can be expected policy states; see [accounts](./accounts-billing.md).

If you have signed in but the home/profile overview is still loading, unavailable or reports a refresh error, use its Refresh action and read the resulting status. Missing values do not mean zero credits or a changed plan. Check the displayed account email before interpreting a balance. Signing out still leaves local modeling and local projects available.

If a screen differs from this guide, include its exact public URL and whether it is signed in when reporting it. A different origin, an older screen or one tab's rendering problem needs diagnosis; its appearance alone does not establish a cache defect or that clearing browser storage will fix it. Preserve local projects and downloaded backups while investigating.

A failed autosave is not a durable backup. Download a Model file if storage is restricted. Folder permissions can require a new click after reopening the app. Imported source units and display units are separate; check geometry bounds before solving a suspiciously large or small model. See [projects](./projects-storage.md) and [import/export](./import-export.md).
