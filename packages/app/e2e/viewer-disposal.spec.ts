import { expect, test } from '@playwright/test';

test.describe('@cpu viewer resource lifecycle', () => {
  test.setTimeout(120_000);
  test('replaces surfaces and modes without retaining owned GPU resources', async ({ page }) => {
    await page.goto('./');
    const result = await page.evaluate(async () => {
      const viewerUrl = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]'))
        .map((link) => link.href)
        .find((href) => /\/viewer-[^/]+\.js$/.test(href));
      if (!viewerUrl) throw new Error('the built Viewer module was not preloaded');
      const { Viewer } = (await import(viewerUrl)) as {
        Viewer: new (canvas: HTMLCanvasElement) => unknown;
      };
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 240;
      canvas.style.width = '320px';
      canvas.style.height = '240px';
      document.body.append(canvas);

      const listenerAdds: Record<string, number> = {};
      const listenerRemoves: Record<string, number> = {};
      const add = canvas.addEventListener.bind(canvas);
      const remove = canvas.removeEventListener.bind(canvas);
      canvas.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
        listenerAdds[type] = (listenerAdds[type] ?? 0) + 1;
        return add(type, listener, options);
      }) as typeof canvas.addEventListener;
      canvas.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
        listenerRemoves[type] = (listenerRemoves[type] ?? 0) + 1;
        return remove(type, listener, options);
      }) as typeof canvas.removeEventListener;

      const viewer = new Viewer(canvas) as unknown as {
        setSurface(surface: unknown): void;
        setMode(mode: 'geometry' | 'mesh'): void;
        dispose(): void;
        mesh: { geometry: { constructor: { prototype: { dispose: () => void } } } } | null;
        edges: { geometry: object; material: object } | null;
        outlines: { geometry: object; material: object } | null;
        grid: { geometry: object; material: object } | null;
        triad: { geometry: object; material: object } | null;
        material: object;
        renderer: { info: { memory: { geometries: number } } };
      };
      const surface = {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
        indices: new Uint32Array([0, 1, 2, 1, 3, 2]),
        triBody: new Uint32Array([0, 0]),
        triFace: new Uint32Array([0, 1]),
        faceNames: ['body.a', 'body.b'],
        bodyNames: ['body'],
        source: 'geometry' as const,
        edges: new Uint32Array([0, 1, 1, 3, 3, 2, 2, 0]),
        edgeFace: new Uint32Array([0, 0, 1, 1]),
        edgeBody: new Uint32Array([0, 0, 0, 0]),
      };

      viewer.setSurface(surface);
      const sharedMaterial = viewer.material;
      const events: object[] = [];
      const watched = new Set<object>();
      const watch = (resource: object): void => {
        if (watched.has(resource)) return;
        watched.add(resource);
        (resource as { addEventListener(type: string, listener: () => void): void }).addEventListener('dispose', () => events.push(resource));
      };
      const watchOwned = (): void => {
        for (const object of [viewer.mesh, viewer.edges, viewer.outlines, viewer.grid, viewer.triad]) {
          if (!object) continue;
          watch(object.geometry);
          const material = (object as { material?: object }).material;
          if (material) watch(material);
        }
      };
      watch(sharedMaterial);

      const initialGeometries = viewer.renderer.info.memory.geometries;
      let maximumGeometries = initialGeometries;
      for (let i = 0; i < 300; i++) {
        watchOwned();
        viewer.setSurface(surface);
        watchOwned();
        viewer.setMode(i % 2 === 0 ? 'mesh' : 'geometry');
        maximumGeometries = Math.max(maximumGeometries, viewer.renderer.info.memory.geometries);
      }
      const beforeTeardown = {
        maximumGeometries,
        liveGeometries: viewer.renderer.info.memory.geometries,
        ownedDisposals: events.filter((resource) => resource !== sharedMaterial).length,
        sharedMaterialDisposals: events.filter((resource) => resource === sharedMaterial).length,
      };

      watchOwned();
      viewer.dispose();
      const afterTeardown = {
        liveGeometries: viewer.renderer.info.memory.geometries,
        sharedMaterialDisposals: events.filter((resource) => resource === sharedMaterial).length,
        listenerRemoves: { click: listenerRemoves.click ?? 0, pointermove: listenerRemoves.pointermove ?? 0 },
      };
      const eventCount = events.length;
      viewer.dispose();
      return {
        initialGeometries,
        allDisposedOnce: [...watched].every((resource) => events.filter((event) => event === resource).length === 1),
        beforeTeardown,
        afterTeardown,
        secondDisposeEventCount: events.length,
        eventCount,
        listenerAdds: { click: listenerAdds.click ?? 0, pointermove: listenerAdds.pointermove ?? 0 },
      };
    });

    expect(result.beforeTeardown.maximumGeometries - result.initialGeometries).toBeLessThanOrEqual(1);
    expect(result.beforeTeardown.ownedDisposals).toBeGreaterThan(2000);
    expect(result.allDisposedOnce).toBe(true);
    expect(result.beforeTeardown.sharedMaterialDisposals).toBe(0);
    expect(result.afterTeardown.sharedMaterialDisposals).toBe(1);
    expect(result.afterTeardown.liveGeometries).toBe(0);
    expect(result.secondDisposeEventCount).toBe(result.eventCount);
    expect(result.listenerAdds).toEqual({ click: 1, pointermove: 1 });
    expect(result.afterTeardown.listenerRemoves).toEqual({ click: 1, pointermove: 1 });
  });
});
