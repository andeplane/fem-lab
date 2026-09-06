/* FEM Lab viewer: structured hex mesh of a reinforced-concrete corbel, three.js UMD (window.THREE) */
(function () {
  const MAPS = {
    viridis: ['#440154', '#414487', '#2a788e', '#22a884', '#7ad151', '#fde725'],
    turbo: ['#30123b', '#4145ab', '#4675ed', '#39a2fc', '#1bcfd4', '#24eca6', '#61fc6c', '#a4fc3b', '#d1e834', '#f3c63a', '#fe9b2d', '#f36315', '#cb2a04', '#7a0403'],
    rainbow: ['#0000ff', '#00ffff', '#00ff00', '#ffff00', '#ff0000']
  };
  const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
  function sample(name, t) {
    const stops = (MAPS[name] || MAPS.viridis).map(hex2rgb);
    t = Math.min(1, Math.max(0, t));
    const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
    const a = stops[i], b = stops[i + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }

  // geometry: L-shaped corbel. x = thickness 300, y = 0..750, z = 0..1800 (mm)
  const H = 1800, CS = 50, NX = 6, NY = 15, NZ = 36;
  const nid = (i, j, k) => (i * (NY + 1) + j) * (NZ + 1) + k;
  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  function build(shape) {
    const cell = shape === 'column' ? (j, k) => j < 8 : (j, k) => (j < 8 || k >= 28);
    const nN = (NX + 1) * (NY + 1) * (NZ + 1);
    const base = new Float32Array(nN * 3), disp = new Float32Array(nN * 3), val = new Float32Array(nN);
    let vmax = 0;
    for (let i = 0; i <= NX; i++) for (let j = 0; j <= NY; j++) for (let k = 0; k <= NZ; k++) {
      const n = nid(i, j, k), x = i * CS, y = j * CS, z = k * CS;
      base[n * 3] = x; base[n * 3 + 1] = y; base[n * 3 + 2] = z;
      const zn = z / H, nibT = clamp01((y - 400) / 350), zg = clamp01((z - 1200) / 300);
      disp[n * 3] = 0; disp[n * 3 + 1] = 0.16 * zn * zn;
      disp[n * 3 + 2] = -(0.32 * zn + 1.15 * Math.pow(nibT, 1.5) * zg);
      let s = ((H - z) / H) * (Math.abs(y - 200) / 200) * 7.5;
      s += 26 * Math.exp(-Math.hypot(y - 400, z - 1400) / 95);
      s += 6.5 * Math.exp(-z / 70) * (0.35 + Math.abs(y - 200) / 200);
      s += 5 * Math.exp(-Math.hypot(y - 575, z - 1800) / 130);
      val[n] = s; if (s > vmax) vmax = s;
    }
    for (let n = 0; n < nN; n++) val[n] /= vmax;
    const idx = [], eset = new Set(), lines = [];
    const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) for (let k = 0; k < NZ; k++) {
      if (!cell(j, k)) continue;
      for (const d of dirs) {
        const ni = i + d[0], nj = j + d[1], nk = k + d[2];
        if (ni >= 0 && ni < NX && nj >= 0 && nj < NY && nk >= 0 && nk < NZ && cell(nj, nk)) continue;
        let q;
        if (d[0] !== 0) { const a = i + (d[0] > 0 ? 1 : 0); q = [nid(a, j, k), nid(a, j + 1, k), nid(a, j + 1, k + 1), nid(a, j, k + 1)]; }
        else if (d[1] !== 0) { const b = j + (d[1] > 0 ? 1 : 0); q = [nid(i, b, k), nid(i + 1, b, k), nid(i + 1, b, k + 1), nid(i, b, k + 1)]; }
        else { const c = k + (d[2] > 0 ? 1 : 0); q = [nid(i, j, c), nid(i + 1, j, c), nid(i + 1, j + 1, c), nid(i, j + 1, c)]; }
        idx.push(q[0], q[1], q[2], q[0], q[2], q[3]);
        for (let e = 0; e < 4; e++) {
          const a = q[e], b = q[(e + 1) % 4], key = a < b ? a + '_' + b : b + '_' + a;
          if (!eset.has(key)) { eset.add(key); lines.push(a, b); }
        }
      }
    }
    return { base, disp, val, idx, lines, nN };
  }

  function waitThree() {
    return new Promise((res) => {
      if (window.THREE) return res();
      const t = setInterval(() => { if (window.THREE) { clearInterval(t); res(); } }, 60);
    });
  }

  class FemViewer extends HTMLElement {
    static get observedAttributes() { return ['mode', 'scale', 'colormap', 'glyphs', 'clip', 'play', 'dim', 'built', 'meshed']; }
    connectedCallback() {
      if (this._booted) return; this._booted = true;
      this.style.display = 'block'; this.style.position = 'relative'; this.style.width = '100%'; this.style.height = '100%';
      this._probe = document.createElement('div');
      this._probe.style.cssText = 'position:absolute;left:12px;bottom:12px;max-width:calc(100% - 480px);min-width:180px;font:11px/1.5 "IBM Plex Mono",ui-monospace,monospace;color:#8b929d;pointer-events:none;letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      waitThree().then(() => { this._setup(); this.appendChild(this._probe); });
    }
    attributeChangedCallback(name) {
      if (!this._ready) return;
      if (name === 'built') this._rebuild();
      this._apply();
    }

    _setup() {
      const T = window.THREE;
      this.renderer = new T.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      this.renderer.localClippingEnabled = true;
      this.renderer.domElement.style.cssText = 'display:block;width:100%;height:100%';
      this.appendChild(this.renderer.domElement);
      this.scene = new T.Scene();
      this.camera = new T.PerspectiveCamera(35, 1, 10, 40000);
      this.center = new T.Vector3(150, 300, 800);
      this.orbit = { az: -0.85, el: 0.32, r: 5200 };

      this.scene.add(new T.HemisphereLight(0xdfe6f0, 0x14161b, 0.85));
      const d1 = new T.DirectionalLight(0xffffff, 0.75); d1.position.set(-1800, -2600, 3200); this.scene.add(d1);
      const d2 = new T.DirectionalLight(0x9fc4d8, 0.35); d2.position.set(2400, 1600, -800); this.scene.add(d2);

      const grid = new T.GridHelper(4000, 40, 0x232730, 0x171a20);
      grid.rotation.x = Math.PI / 2; grid.position.set(150, 375, -2); this.scene.add(grid);

      this.plane = new T.Plane(new T.Vector3(0, -1, 0), 520);
      this.mat = new T.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, side: T.DoubleSide });
      this.lmat = new T.LineBasicMaterial({ color: 0x2b3038, transparent: true, opacity: 0.9 });
      this.solid = null; this.wire = null;

      this.fixGlyphs = new T.Group(); this.loadGlyphs = new T.Group();
      this.scene.add(this.fixGlyphs); this.scene.add(this.loadGlyphs);
      const cy = new T.MeshBasicMaterial({ color: 0x58b7d6 }), or = new T.MeshBasicMaterial({ color: 0xf0824b });
      for (let a = 0; a < 3; a++) for (let b = 0; b < 4; b++) {
        const c = new T.Mesh(new T.ConeGeometry(38, 90, 4), cy);
        c.position.set(45 + a * 105, 55 + b * 100, -48); c.rotation.x = Math.PI; this.fixGlyphs.add(c);
      }
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
        const arrow = new T.Group();
        const sh = new T.Mesh(new T.CylinderGeometry(9, 9, 210, 8), or); sh.position.y = 105;
        const hd = new T.Mesh(new T.ConeGeometry(26, 70, 10), or); hd.position.y = -20; hd.rotation.x = Math.PI;
        arrow.add(sh); arrow.add(hd);
        arrow.rotation.set(Math.PI / 2, 0, 0); arrow.position.set(70 + a * 80, 445 + b * 130, 1815);
        this.loadGlyphs.add(arrow);
      }
      const triad = new T.Group();
      [[0xe05252, [1, 0, 0]], [0x5fbf8f, [0, 1, 0]], [0x58b7d6, [0, 0, 1]]].forEach(([c, v]) => {
        const geo = new T.BufferGeometry().setFromPoints([new T.Vector3(0, 0, 0), new T.Vector3(v[0] * 260, v[1] * 260, v[2] * 260)]);
        triad.add(new T.Line(geo, new T.LineBasicMaterial({ color: c })));
      });
      triad.position.set(-320, -160, 0); this.scene.add(triad);

      new ResizeObserver(() => this._resize()).observe(this);
      this._bindInput();
      this._ready = true; this._rebuild(); this._apply(); this._resize();
      const loop = () => { this._frame(); this._raf = requestAnimationFrame(loop); }; loop();
    }

    _rebuild() {
      const T = window.THREE;
      const shape = this.getAttribute('built') || 'corbel';
      if (this.solid) { this.scene.remove(this.solid); this.solid.geometry.dispose(); this.solid = null; }
      if (this.wire) { this.scene.remove(this.wire); this.wire.geometry.dispose(); this.wire = null; }
      this.data = null;
      if (shape === 'none') return;
      this.data = build(shape);
      const g = new T.BufferGeometry();
      this.pos = new Float32Array(this.data.base);
      this.col = new Float32Array(this.data.nN * 3);
      g.setAttribute('position', new T.BufferAttribute(this.pos, 3));
      g.setAttribute('color', new T.BufferAttribute(this.col, 3));
      g.setIndex(this.data.idx);
      this.solid = new T.Mesh(g, this.mat); this.scene.add(this.solid);
      const lg = new T.BufferGeometry();
      this.lpos = new Float32Array(this.data.lines.length * 3);
      lg.setAttribute('position', new T.BufferAttribute(this.lpos, 3));
      this.wire = new T.LineSegments(lg, this.lmat); this.scene.add(this.wire);
    }

    _bindInput() {
      const el = this.renderer.domElement;
      let drag = null;
      el.style.cursor = 'grab';
      el.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 1 }; el.setPointerCapture(e.pointerId); el.style.cursor = 'grabbing'; });
      el.addEventListener('pointerup', () => { drag = null; el.style.cursor = 'grab'; });
      el.addEventListener('pointermove', (e) => {
        if (drag) {
          const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
          if (drag.pan) { this.center.x -= dx * this.orbit.r * 0.0004; this.center.z += dy * this.orbit.r * 0.0004; }
          else { this.orbit.az -= dx * 0.006; this.orbit.el = Math.max(-1.45, Math.min(1.45, this.orbit.el + dy * 0.005)); }
        } else this._doProbe(e);
      });
      el.addEventListener('wheel', (e) => { e.preventDefault(); this.orbit.r = Math.max(900, Math.min(18000, this.orbit.r * (1 + Math.sign(e.deltaY) * 0.08))); }, { passive: false });
    }

    _doProbe(e) {
      const T = window.THREE;
      if (!this.solid) { this._probe.textContent = ''; return; }
      if (!this._ray) { this._ray = new T.Raycaster(); this._v2 = new T.Vector2(); }
      const r = this.getBoundingClientRect();
      this._v2.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this._ray.setFromCamera(this._v2, this.camera);
      const hit = this._ray.intersectObject(this.solid, false)[0];
      if (!hit) { this._probe.textContent = 'hover the model to probe'; return; }
      const n = hit.face.a, p = hit.point, results = (this.getAttribute('mode') || 'results') === 'results';
      const head = results ? '<span style="color:#c8cdd4">σ_vM</span> ' + (this.data.val[n] * 18.7).toFixed(2) + ' MPa &nbsp;·&nbsp; node ' + n : '<span style="color:#c8cdd4">face</span> ' + (p.z > 1795 ? (p.y > 400 ? 'bearing_top' : 'column_top') : p.z < 5 ? 'base' : p.y < 5 ? 'wall_back' : 'side');
      this._probe.innerHTML = head + ' &nbsp;·&nbsp; x ' + p.x.toFixed(0) + '  y ' + p.y.toFixed(0) + '  z ' + p.z.toFixed(0) + ' mm';
    }

    _apply() {
      const mode = this.getAttribute('mode') || 'results';
      const cm = this.getAttribute('colormap') || 'viridis';
      const dim = this.getAttribute('dim') === 'on';
      const glyphs = this.getAttribute('glyphs') || 'all';
      const meshed = this.getAttribute('meshed') !== 'off';
      this.fixGlyphs.visible = glyphs === 'fix' || glyphs === 'all';
      this.loadGlyphs.visible = glyphs === 'all';
      this.mat.clippingPlanes = this.getAttribute('clip') === 'on' ? [this.plane] : null;
      this.mat.needsUpdate = true;
      if (!this.solid) { this._probe.textContent = ''; return; }
      this._probe.textContent = 'hover the model to probe';
      this.wire.visible = meshed && mode !== 'results';
      this.lmat.color.set(mode === 'mesh' ? 0x5b6472 : 0x272b33);
      const d = this.data;
      if (mode === 'results') {
        for (let n = 0; n < d.nN; n++) {
          const c = sample(cm, d.val[n]), k = dim ? 0.42 : 1;
          this.col[n * 3] = c[0] * k; this.col[n * 3 + 1] = c[1] * k; this.col[n * 3 + 2] = c[2] * k;
        }
      } else {
        const g = mode === 'mesh' ? 0.46 : 0.58;
        for (let n = 0; n < d.nN; n++) { this.col[n * 3] = g; this.col[n * 3 + 1] = g * 1.02; this.col[n * 3 + 2] = g * 1.08; }
      }
      this.solid.geometry.attributes.color.needsUpdate = true;
      this._warp();
    }

    _warp() {
      if (!this.solid) return;
      const mode = this.getAttribute('mode') || 'results';
      let s = parseFloat(this.getAttribute('scale') || '0');
      if (mode !== 'results' || !isFinite(s)) s = 0;
      if (this.getAttribute('play') === 'on') s *= Math.sin(performance.now() / 420);
      const d = this.data;
      for (let n = 0; n < d.nN * 3; n++) this.pos[n] = d.base[n] + d.disp[n] * s;
      this.solid.geometry.attributes.position.needsUpdate = true;
      this.solid.geometry.computeVertexNormals();
      for (let i = 0; i < d.lines.length; i++) {
        const n = d.lines[i];
        this.lpos[i * 3] = this.pos[n * 3]; this.lpos[i * 3 + 1] = this.pos[n * 3 + 1]; this.lpos[i * 3 + 2] = this.pos[n * 3 + 2];
      }
      this.wire.geometry.attributes.position.needsUpdate = true;
    }

    _resize() {
      const w = this.clientWidth || 800, h = this.clientHeight || 600;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    }

    _frame() {
      if (this.getAttribute('play') === 'on') this._warp();
      const o = this.orbit;
      this.camera.position.set(
        this.center.x + o.r * Math.cos(o.el) * Math.cos(o.az),
        this.center.y + o.r * Math.cos(o.el) * Math.sin(o.az),
        this.center.z + o.r * Math.sin(o.el) + 400);
      this.camera.up.set(0, 0, 1);
      this.camera.lookAt(this.center);
      this.renderer.render(this.scene, this.camera);
    }
    disconnectedCallback() { if (this._raf) cancelAnimationFrame(this._raf); }
  }
  if (!window.customElements.get('fem-viewer')) window.customElements.define('fem-viewer', FemViewer);
})();
