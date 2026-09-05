// The three.js viewer of plan B §7.2, in the visual treatment of docs/design/README.md: dark
// ground grid, flat grey geometry, quad edges, axis triad, z-up, hemisphere plus two
// directional lights. It draws what the engine hands it and never changes Model state — every
// change of view arrives as a `view.*` Command, every pick leaves as `selection.set`.
import {
  AxesHelper,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  EdgesGeometry,
  GridHelper,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshLambertMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Plane,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
  WireframeGeometry,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { ViewMode } from '../store';
import type { AppSurface } from '../worker-transport';
import { type ColormapName, sample } from './colormap';

export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
  up?: [number, number, number];
}
export type ViewPreset = 'iso' | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';
export interface Pick {
  face: string | null;
  body: string | null;
  point: [number, number, number];
}

const GREY_GEOMETRY = 0.58;
const GREY_MESH = 0.46;
const EDGE_GEOMETRY = 0x272b33;
const EDGE_MESH = 0x5b6472;
const HIGHLIGHT = new Color(0x58b7d6);

const DIRECTIONS: Record<ViewPreset, [number, number, number]> = {
  iso: [1, -1.35, 0.9],
  front: [0, -1, 0],
  back: [0, 1, 0],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, 0, 1],
  bottom: [0, 0, -1],
};

/** A stable hue per body, mixed into the flat grey just enough to tell two bodies apart. */
function bodyTint(i: number): Color {
  return new Color().setHSL((i * 0.137) % 1, 0.45, 0.5);
}

/** The round 1/2/5·10^k tick that puts roughly twenty divisions across `extent`. */
export function niceTick(extent: number): number {
  if (!(extent > 0)) return 1;
  const raw = extent / 20;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * pow;
}

export class Viewer {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly perspective: PerspectiveCamera;
  private readonly orthographic: OrthographicCamera;
  private camera: PerspectiveCamera | OrthographicCamera;
  private readonly controls: OrbitControls;
  private readonly raycaster = new Raycaster();
  private readonly layers = new Group();
  private readonly material = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
  private grid: GridHelper | null = null;
  private triad: AxesHelper | null = null;
  private mesh: Mesh | null = null;
  private edges: LineSegments | null = null;

  private surface: AppSurface | null = null;
  /** Original triangle index per drawn triangle, and original vertex index per drawn vertex. */
  private tri = new Uint32Array(0);
  private vert = new Uint32Array(0);
  /** Undeformed drawn positions. */
  private base = new Float32Array(0);
  private mode: ViewMode = 'geometry';
  private colormap: ColormapName = 'viridis';
  private field: Float32Array | null = null;
  private range: [number, number] = [0, 1];
  private hoverFace: string | null = null;
  private readonly hidden = new Set<string>();
  private box = new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
  private pickCb: ((p: Pick | null) => void) | null = null;
  private frame = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
    this.renderer.localClippingEnabled = true;
    this.scene.background = new Color(0x0d0f13);

    this.perspective = new PerspectiveCamera(38, 1, 0.01, 1e6);
    this.orthographic = new OrthographicCamera(-1, 1, 1, -1, -1e6, 1e6);
    for (const c of [this.perspective, this.orthographic]) c.up.set(0, 0, 1);
    this.camera = this.perspective;

    this.scene.add(new HemisphereLight(0xdfe6f0, 0x14161b, 0.85));
    const key = new DirectionalLight(0xffffff, 0.75);
    key.position.set(-1.8, -2.6, 3.2);
    const fill = new DirectionalLight(0x9fc4d8, 0.35);
    fill.position.set(2.4, 1.6, -0.8);
    this.scene.add(key, fill, this.layers);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false;
    this.controls.addEventListener('change', () => this.render());

    canvas.addEventListener('click', (e) => this.pickCb?.(this.pick(e.clientX, e.clientY)));
    canvas.addEventListener('pointermove', (e) => this.hoverAt(e));
    this.setChrome();
    this.resize();
    this.fit();
  }

  onPick(cb: (p: Pick | null) => void): void {
    this.pickCb = cb;
  }

  resize(): void {
    const w = this.canvas.clientWidth || 640;
    const h = this.canvas.clientHeight || 480;
    this.renderer.setSize(w, h, false);
    this.perspective.aspect = w / h;
    this.perspective.updateProjectionMatrix();
    this.frameOrtho();
    this.render();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  // ── geometry ────────────────────────────────────────────────────────────────────────────
  /**
   * The surface arrives indexed; we expand it so every triangle owns its three vertices. That
   * buys flat shading, a per-triangle colour (body tint, face-set highlight) and a `faceIndex`
   * that is a triangle index, all without a custom shader. Hidden bodies are simply not built.
   */
  setSurface(s: AppSurface): void {
    this.surface = s;
    const total = s.indices.length / 3;
    const keep: number[] = [];
    for (let t = 0; t < total; t++) if (!this.hidden.has(s.bodyNames[s.triBody[t]!] ?? '')) keep.push(t);

    this.tri = Uint32Array.from(keep);
    this.vert = new Uint32Array(keep.length * 3);
    const pos = new Float32Array(keep.length * 9);
    keep.forEach((t, i) => {
      for (let k = 0; k < 3; k++) {
        const v = s.indices[t * 3 + k]!;
        this.vert[i * 3 + k] = v;
        pos[(i * 3 + k) * 3] = s.positions[v * 3]!;
        pos[(i * 3 + k) * 3 + 1] = s.positions[v * 3 + 1]!;
        pos[(i * 3 + k) * 3 + 2] = s.positions[v * 3 + 2]!;
      }
    });
    this.base = pos;

    const geom = new BufferGeometry();
    geom.setAttribute('position', new BufferAttribute(pos.slice(), 3));
    geom.setAttribute('color', new BufferAttribute(new Float32Array(pos.length), 3));
    geom.computeVertexNormals();
    geom.computeBoundingBox();
    if (geom.boundingBox && keep.length > 0) this.box = geom.boundingBox.clone();

    for (const old of [this.mesh, this.edges]) {
      if (!old) continue;
      this.layers.remove(old);
      old.geometry.dispose();
    }
    this.mesh = new Mesh(geom, this.material);
    this.edges = this.buildEdges();
    this.layers.add(this.mesh, this.edges);
    this.paint();
    this.setChrome();
    this.render();
  }

  private buildEdges(): LineSegments {
    const indexed = new BufferGeometry();
    indexed.setAttribute('position', new BufferAttribute(this.base.slice(), 3));
    // ponytail: the mesh wireframe shows the triangulation diagonals; drop them when the engine
    // exposes element faces instead of a triangle soup.
    const geom = this.mode === 'mesh' ? new WireframeGeometry(indexed) : new EdgesGeometry(indexed, 1);
    indexed.dispose();
    return new LineSegments(geom, new LineBasicMaterial({ color: this.mode === 'mesh' ? EDGE_MESH : EDGE_GEOMETRY }));
  }

  /** Vertex colours for the current mode: body tint, mesh grey, or the field through the LUT. */
  private paint(): void {
    const s = this.surface;
    const geom = this.mesh?.geometry;
    if (!s || !geom) return;
    const colour = geom.getAttribute('color') as BufferAttribute;
    const grey = this.mode === 'mesh' ? GREY_MESH : GREY_GEOMETRY;
    const [lo, hi] = this.range;
    const span = hi - lo || 1;
    const c = new Color();
    for (let i = 0; i < this.tri.length; i++) {
      const t = this.tri[i]!;
      const faceName = s.faceNames[s.triFace[t]!] ?? null;
      const hot = faceName !== null && faceName === this.hoverFace;
      for (let k = 0; k < 3; k++) {
        const vertex = i * 3 + k;
        if (this.mode === 'results' && this.field) {
          const [r, g, b] = sample(this.colormap, (this.field[this.vert[vertex]!]! - lo) / span);
          c.setRGB(r, g, b);
        } else if (this.mode === 'mesh') {
          c.setScalar(grey);
        } else {
          c.setScalar(grey).lerp(bodyTint(s.triBody[t]!), 0.14);
        }
        if (hot) c.lerp(HIGHLIGHT, 0.45);
        colour.setXYZ(vertex, c.r, c.g, c.b);
      }
    }
    colour.needsUpdate = true;
  }

  /** Ground grid at the model's scale with round ticks, and an axis triad beside it. */
  private setChrome(): void {
    for (const old of [this.grid, this.triad]) if (old) this.scene.remove(old);
    const size = this.box.getSize(new Vector3());
    const extent = Math.max(size.x, size.y, size.z, 1e-6) * 3;
    const tick = niceTick(extent);
    const divisions = Math.max(8, Math.round(extent / tick));
    const grid = new GridHelper(tick * divisions, divisions, 0x232730, 0x171a20);
    grid.rotation.x = Math.PI / 2;
    const centre = this.box.getCenter(new Vector3());
    grid.position.set(centre.x, centre.y, this.box.min.z - tick * 0.05);
    const triad = new AxesHelper(tick * 2);
    triad.position.set(this.box.min.x - tick, this.box.min.y - tick, this.box.min.z);
    this.grid = grid;
    this.triad = triad;
    this.scene.add(grid, triad);
  }

  // ── view Commands ───────────────────────────────────────────────────────────────────────
  setMode(mode: ViewMode): void {
    this.mode = mode;
    if (this.edges) {
      this.layers.remove(this.edges);
      this.edges.geometry.dispose();
      this.edges = this.buildEdges();
      this.layers.add(this.edges);
    }
    this.paint();
    this.render();
  }

  setColormap(name: ColormapName): void {
    this.colormap = name;
    this.paint();
    this.render();
  }

  setField(values: Float32Array | null, range: [number, number]): void {
    this.field = values;
    this.range = range;
    this.paint();
    this.render();
  }

  /** `position = X + scale·u`, on the CPU; the Result never changes, only the drawing. */
  setDeformed(displacement: Float32Array | null, scale: number): void {
    const geom = this.mesh?.geometry;
    if (!geom) return;
    const pos = geom.getAttribute('position') as BufferAttribute;
    for (let v = 0; v < this.vert.length; v++) {
      const src = this.vert[v]! * 3;
      for (let k = 0; k < 3; k++) {
        (pos.array as Float32Array)[v * 3 + k] = this.base[v * 3 + k]! + (displacement ? scale * displacement[src + k]! : 0);
      }
    }
    pos.needsUpdate = true;
    geom.computeVertexNormals();
    this.render();
  }

  setClip(plane: { normal: [number, number, number]; offset: number } | null): void {
    this.material.clippingPlanes = plane ? [new Plane(new Vector3(...plane.normal).normalize(), -plane.offset)] : [];
    this.material.needsUpdate = true;
    this.render();
  }

  setLayer(layer: string, on: boolean): void {
    const target = layer === 'grid' ? this.grid : layer === 'axes' ? this.triad : layer === 'edges' ? this.edges : layer === 'mesh' ? this.mesh : null;
    if (target) target.visible = on;
    this.render();
  }

  setVisible(bodies: string[], on: boolean): void {
    for (const b of bodies) {
      if (on) this.hidden.delete(b);
      else this.hidden.add(b);
    }
    if (this.surface) this.setSurface(this.surface);
  }

  setProjection(p: 'perspective' | 'orthographic'): void {
    const state = this.getCamera();
    this.camera = p === 'orthographic' ? this.orthographic : this.perspective;
    this.controls.object = this.camera;
    this.frameOrtho();
    this.setCamera(state);
  }

  setTheme(theme: 'dark' | 'light'): void {
    this.scene.background = new Color(theme === 'dark' ? 0x0d0f13 : 0xf3f4f6);
    this.render();
  }

  /** Keeps rendering while something moves; the Command exists so the play button is callable. */
  animate(playing: boolean): void {
    cancelAnimationFrame(this.frame);
    if (!playing) return;
    const step = () => {
      this.render();
      this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }

  fit(): void {
    this.preset('iso');
  }

  preset(view: ViewPreset): void {
    const size = this.box.getSize(new Vector3());
    const centre = this.box.getCenter(new Vector3());
    const radius = Math.max(size.length() * 0.5, 1e-6);
    const eye = centre.clone().add(new Vector3(...DIRECTIONS[view]).normalize().multiplyScalar(radius * 3.2));
    this.setCamera({ position: [eye.x, eye.y, eye.z], target: [centre.x, centre.y, centre.z] });
  }

  setCamera(c: CameraState): void {
    this.camera.position.set(...c.position);
    if (c.up) this.camera.up.set(...c.up);
    this.controls.target.set(...c.target);
    this.frameOrtho();
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    this.render();
  }

  getCamera(): CameraState {
    const p = this.camera.position;
    const t = this.controls.target;
    const u = this.camera.up;
    return { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z], up: [u.x, u.y, u.z] };
  }

  /** A PNG data URL of exactly what is on screen (`preserveDrawingBuffer`). */
  screenshot(): string {
    this.render();
    return this.canvas.toDataURL('image/png');
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.controls.dispose();
    this.renderer.dispose();
  }

  // ── picking ─────────────────────────────────────────────────────────────────────────────
  pick(x: number, y: number): Pick | null {
    const s = this.surface;
    if (!this.mesh || !s) return null;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.mesh, false)[0];
    if (!hit || hit.faceIndex === undefined || hit.faceIndex === null) return null;
    const t = this.tri[hit.faceIndex]!;
    return {
      face: s.faceNames[s.triFace[t]!] ?? null,
      body: s.bodyNames[s.triBody[t]!] ?? null,
      point: [hit.point.x, hit.point.y, hit.point.z],
    };
  }

  private hoverAt(e: MouseEvent): void {
    const next = this.pick(e.clientX, e.clientY)?.face ?? null;
    if (next === this.hoverFace) return;
    this.hoverFace = next;
    this.paint();
    this.render();
  }

  private frameOrtho(): void {
    const h = Math.max(this.box.getSize(new Vector3()).length() * 0.7, 1e-6);
    const aspect = (this.canvas.clientWidth || 640) / (this.canvas.clientHeight || 480);
    Object.assign(this.orthographic, { left: -h * aspect, right: h * aspect, top: h, bottom: -h });
    this.orthographic.updateProjectionMatrix();
  }
}
