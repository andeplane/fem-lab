import { prepareIsolation } from './isolation-bootstrap';

// Keep the application behind the isolation decision as well as its engine: the first
// uncontrolled Pages document should not download the entire application before its reload.
// Promise chaining also keeps this entry free of top-level await. In the current bundler,
// TLA changes helper placement into an AI/registry cycle before main can initialize.
void prepareIsolation({
  isolated: crossOriginIsolated, secure: isSecureContext,
  worker: navigator.serviceWorker, storage: () => sessionStorage,
  script: new URL('coi-serviceworker.min.js', document.baseURI).href,
  reload: () => location.reload(),
  clock: { setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) },
}).then(() => import('./main'));
