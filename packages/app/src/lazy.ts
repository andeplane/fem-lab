// A component that arrives with its own chunk (plan B §7, budget: the landing chunk is the shell
// alone). It renders nothing until the `import()` resolves, which is what the start screen wants:
// three.js, the two AI SDKs and the tutorial runner are never on the boot path.
import { h, type ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';

export function lazy<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
  // Module scope, so a second mount reuses the first mount's fetch instead of starting another.
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<void> | null = null;
  return function Lazy(props: P) {
    const [Comp, setComp] = useState<ComponentType<P> | null>(loaded);
    useEffect(() => {
      if (Comp) return;
      let live = true;
      // A chunk that never arrives (offline, a deploy mid-flight, a torn-down test environment)
      // leaves the slot empty rather than becoming an unhandled rejection.
      pending ??= load().then(
        (c) => {
          loaded = c;
        },
        (e: unknown) => void e,
      );
      void pending.then(() => {
        if (live && loaded) setComp(() => loaded);
      });
      return () => {
        live = false;
      };
    }, [Comp]);
    return Comp === null ? null : h(Comp, props);
  };
}
