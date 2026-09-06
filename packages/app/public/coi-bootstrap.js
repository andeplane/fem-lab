// ADR 0013: COOP/COEP from a service worker lets GitHub Pages host a cross-origin-isolated
// app. coi-serviceworker can ask to reload on `updatefound`, before clients.claim() controls
// this page. Wait for the controller: only a controlled navigation can receive its headers.
function createControlledReload(serviceWorker, storage, reload) {
  let waiting = false;
  const key = 'coi-reset';
  return function reloadWhenControlled() {
    if (!serviceWorker || waiting || storage.getItem(key)) return;
    waiting = true;
    let finished = false;
    const controlled = () => {
      if (finished || !serviceWorker.controller) return;
      finished = true;
      serviceWorker.removeEventListener('controllerchange', controlled);
      storage.setItem(key, '1');
      reload();
    };
    serviceWorker.addEventListener('controllerchange', controlled);
    controlled();
    if (!serviceWorker.controller) {
      void serviceWorker.ready.then(controlled, () => {
        if (finished) return;
        serviceWorker.removeEventListener('controllerchange', controlled);
        waiting = false;
      });
    }
  };
}

window.coi = {
  coepCredentialless: () => true,
  shouldRegister: () => !sessionStorage.getItem('coi-reset'),
  doReload: createControlledReload(navigator.serviceWorker, sessionStorage, () => location.reload()),
  quiet: true,
};
