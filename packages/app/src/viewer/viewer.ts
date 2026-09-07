// The three.js viewer of plan B §7.2, in the visual treatment of docs/design/README.md: dark
// ground grid, flat grey geometry, quad edges, axis triad, z-up, hemisphere plus two
// directional lights. It draws what the engine hands it and never changes Model state — every
// change of view arrives as a `view.*` Command, every pick leaves as `selection.set`.
import { FemError } from '@femlab/registry';
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
import type { AppSurface } from '../surface';
import { MAPS, type ColormapName, sample } from './colormap';
import { fitsSurface, nice, niceTick } from './scale';

export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
  up?: [number, number, number];
}
export interface AnimationState {
  playing: boolean;
  phase: number;
  speed: number;
}
export type ViewPreset = 'iso' | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';
export interface Pick {
  face: string | null;
  body: string | null;
  point: [number, number, number];
  /** The mesh node nearest the hit, and the contoured value there; `null` off a Result. */
  node: number | null;
  value: number | null;
}

/** What `screenshot` burns into the corner of the image, so a saved PNG can be read alone. */
export interface LegendBurn {
  title: string;
  unit: string;
  min: number;
  max: number;
  colormap: ColormapName;
}

const GREY_GEOMETRY = 0.58;
const GREY_MESH = 0.46;
const EDGE_GEOMETRY = 0x272b33;
const EDGE_MESH = 0x5b6472;
/** The undeformed outline under an exaggerated shape: visible, but plainly not the body (#42). */
const EDGE_GHOST = 0x4a5260;
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
  private outlines: LineSegments | null = null;
  private readonly outlineMaterial = new LineBasicMaterial({ vertexColors: true });
  /** Original edge index per drawn outline segment. */
  private line = new Uint32Array(0);

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
  /** Design state 6: a stale Result keeps its contours, at 42 % so nobody trusts them. */
  private dim = false;
  private hoverFace: string | null = null;
  private selectedBodies = new Set<string>();
  private selectedFaces = new Set<string>();
  private highlightedBodies = new Set<string>();
  private highlightedFaces = new Set<string>();
  private readonly hidden = new Set<string>();
  /** Visibility survives the replacement of mesh, edge, grid and axis objects. */
  private readonly layerVisibility = new Map<string, boolean>();
  private box = new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
  private pickCb: ((p: Pick | null) => void) | null = null;
  private frame = 0;
  private disposed = false;
  private animation: AnimationState = { playing: false, phase: 0.25, speed: 1 };
  private readonly click = (e: MouseEvent) => this.pickCb?.(this.pick(e.clientX, e.clientY));
  private readonly pointerMove = (e: PointerEvent) => this.hoverAt(e);
  /** The last displacement handed to `setDeformed`, and the scale it was drawn at, so the
   *  animation can sweep the same array without the host re-fetching it every frame. */
  private deformation: Float32Array | null = null;
  private deformScale = 0;

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

    canvas.addEventListener('click', this.click);
    canvas.addEventListener('pointermove', this.pointerMove);
    this.setChrome();
    this.resize();
    this.fit();
  }

  onPick(cb: (p: Pick | null) => void): void {
    this.pickCb = cb;
  }

  /** Persistent selection and transient Journal hover share the same drawable name boundary. */
  setSelection(s: { bodies: string[]; faces: string[]; sets: string[] }): void {
    this.selectedBodies = new Set(s.bodies);
    this.selectedFaces = new Set([...s.faces, ...s.sets]);
    this.paint();
    this.render();
  }

  setHighlight(s: { bodies?: string[]; faces?: string[]; sets?: string[] }): void {
    this.highlightedBodies = new Set(s.bodies ?? []);
    this.highlightedFaces = new Set([...(s.faces ?? []), ...(s.sets ?? [])]);
    this.paint();
    this.render();
  }

  private matchesSet(surface: AppSurface, triangle: number, names: Set<string>): boolean {
    const start = surface.triSetOffsets?.[triangle];
    const end = surface.triSetOffsets?.[triangle + 1];
    if (start === undefined || end === undefined || !surface.triSets || !surface.setNames) return false;
    for (let i = start; i < end; i++) if (names.has(surface.setNames[surface.triSets[i]!] ?? '')) return true;
    return false;
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
    if (!this.disposed) this.renderer.render(this.scene, this.camera);
  }

  /** False until the first `setSurface`: until then `this.box` is a placeholder. */
  get hasSurface(): boolean {
    return this.surface !== null;
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
    // Rebuilding the geometry from `base` would otherwise wipe an existing deformation. Keep it
    // only when the new surface has the same vertex shape; a changed mesh must redraw undeformed.
    if (!fitsSurface(this.deformation, s.positions)) this.deformation = null;

    const geom = new BufferGeometry();
    geom.setAttribute('position', new BufferAttribute(pos.slice(), 3));
    geom.setAttribute('color', new BufferAttribute(new Float32Array(pos.length), 3));
    geom.computeVertexNormals();
    geom.computeBoundingBox();
    if (geom.boundingBox && keep.length > 0) this.box = geom.boundingBox.clone();

    this.disposeSurface();
    this.mesh = new Mesh(geom, this.material);
    this.edges = this.buildEdges();
    this.outlines = this.buildOutlines(s);
    this.layers.add(this.mesh, this.edges, this.outlines);
    const outlineBox = this.outlines.geometry.boundingBox;
    if (outlineBox && this.line.length > 0) {
      this.box = keep.length > 0 ? this.box.union(outlineBox) : outlineBox.clone();
    }
    this.applyLayerVisibility();
    this.paint();
    this.setChrome();
    this.drawDeformed(this.deformation, this.deformScale);
  }

  /** The engine supplies the actual Sheet boundaries, including hole edges and their names. */
  private buildOutlines(s: AppSurface): LineSegments {
    const keep: number[] = [];
    for (let i = 0; i < (s.edges?.length ?? 0) / 2; i++) {
      if (!this.hidden.has(s.bodyNames[s.edgeBody?.[i] ?? -1] ?? '')) keep.push(i);
    }
    this.line = Uint32Array.from(keep);
    const positions = new Float32Array(keep.length * 6);
    keep.forEach((edge, i) => {
      for (let k = 0; k < 2; k++) {
        const node = s.edges![edge * 2 + k]!;
        positions.set(s.positions.subarray(node * 3, node * 3 + 3), i * 6 + k * 3);
      }
    });
    const geom = new BufferGeometry();
    geom.setAttribute('position', new BufferAttribute(positions, 3));
    geom.setAttribute('color', new BufferAttribute(new Float32Array(positions.length), 3));
    geom.computeBoundingBox();
    return new LineSegments(geom, this.outlineMaterial);
  }

  /** Surface meshes share the viewer material; edges own theirs. */
  private disposeSurface(): void {
    if (this.mesh) {
      this.layers.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    this.disposeEdges();
    if (this.outlines) {
      this.layers.remove(this.outlines);
      this.outlines.geometry.dispose();
      this.outlines = null;
    }
  }

  private disposeEdges(): void {
    if (!this.edges) return;
    this.layers.remove(this.edges);
    this.edges.geometry.dispose();
    const materials = Array.isArray(this.edges.material) ? this.edges.material : [this.edges.material];
    for (const material of materials) material.dispose();
    this.edges = null;
  }

  private disposeChrome(): void {
    for (const helper of [this.grid, this.triad]) {
      if (!helper) continue;
      this.scene.remove(helper);
      helper.dispose();
    }
    this.grid = null;
    this.triad = null;
  }

  /** Colour the undeformed mesh edge as a ghost while an exaggerated shape is shown. */
  private edgeColour(): number {
    if (this.deformation !== null && this.deformScale !== 1) return EDGE_GHOST;
    return this.mode === 'mesh' ? EDGE_MESH : EDGE_GEOMETRY;
  }

  private buildEdges(): LineSegments {
    const indexed = new BufferGeometry();
    indexed.setAttribute('position', new BufferAttribute(this.base.slice(), 3));
    // ponytail: the mesh wireframe shows the triangulation diagonals; drop them when the engine
    // exposes element faces instead of a triangle soup.
    const geom = this.mode === 'mesh' ? new WireframeGeometry(indexed) : new EdgesGeometry(indexed, 1);
    indexed.dispose();
    return new LineSegments(geom, new LineBasicMaterial({ color: this.edgeColour() }));
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
      const bodyName = s.bodyNames[s.triBody[t]!] ?? null;
      const selected = (bodyName !== null && this.selectedBodies.has(bodyName)) || (faceName !== null && this.selectedFaces.has(faceName)) || this.matchesSet(s, t, this.selectedFaces);
      const hot =
        (faceName !== null && (faceName === this.hoverFace || this.highlightedFaces.has(faceName))) ||
        (bodyName !== null && this.highlightedBodies.has(bodyName)) ||
        this.matchesSet(s, t, this.highlightedFaces);
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
        if (selected) c.lerp(HIGHLIGHT, 0.28);
        if (hot) c.lerp(HIGHLIGHT, 0.45);
        if (this.dim) c.multiplyScalar(0.42);
        colour.setXYZ(vertex, c.r, c.g, c.b);
      }
    }
    colour.needsUpdate = true;
    const outlineColour = this.outlines?.geometry.getAttribute('color') as BufferAttribute | undefined;
    if (outlineColour) {
      for (let i = 0; i < this.line.length; i++) {
        const edge = this.line[i]!;
        const hot = (s.faceNames[s.edgeFace?.[edge] ?? -1] ?? null) === this.hoverFace && this.hoverFace !== null;
        c.set(hot ? HIGHLIGHT : 0xbac3d0);
        for (let k = 0; k < 2; k++) outlineColour.setXYZ(i * 2 + k, c.r, c.g, c.b);
      }
      outlineColour.needsUpdate = true;
    }
  }

  /** Ground grid at the model's scale with round ticks, and an axis triad beside it. */
  private setChrome(): void {
    this.disposeChrome();
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
    this.applyLayerVisibility();
  }

  private layerTarget(layer: string): GridHelper | AxesHelper | Mesh | LineSegments | null {
    return layer === 'grid' ? this.grid : layer === 'axes' ? this.triad : layer === 'edges' ? this.edges : layer === 'mesh' ? this.mesh : null;
  }

  private applyLayerVisibility(): void {
    for (const layer of ['grid', 'axes', 'edges', 'mesh']) {
      const target = this.layerTarget(layer);
      if (target) target.visible = this.layerVisibility.get(layer) ?? true;
    }
    if (this.outlines) this.outlines.visible = this.layerVisibility.get('edges') ?? true;
  }

  // ── view Commands ───────────────────────────────────────────────────────────────────────
  setMode(mode: ViewMode): void {
    this.mode = mode;
    if (this.edges) {
      this.disposeEdges();
      this.edges = this.buildEdges();
      this.layers.add(this.edges);
      this.applyLayerVisibility();
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

  /** Design state 6: dim the contours without throwing them away. */
  setDim(on: boolean): void {
    if (this.dim === on) return;
    this.dim = on;
    this.paint();
    this.render();
  }

  /**
   * `"auto"`: the exaggeration that makes the largest displacement a twentieth of the model —
   * modest enough to still read as the body — snapped to a round 1/2/5·10^k.
   */
  autoScale(displacement: Float32Array): number {
    let max = 0;
    for (let n = 0; n < displacement.length; n += 3) {
      const d = Math.hypot(displacement[n]!, displacement[n + 1]!, displacement[n + 2]!);
      if (d > max) max = d;
    }
    const diagonal = this.box.getSize(new Vector3()).length();
    if (!(max > 0)) return 1;
    // A mass-normalised mode shape is already about the size of the model, so the exaggeration
    // it wants is a fraction: rounding that to an integer would draw it at zero.
    const want = (0.05 * diagonal) / max;
    return want >= 1 ? nice(want) : Number(want.toPrecision(2));
  }

  /** `position = X + scale·u`, on the CPU; the Result never changes, only the drawing. */
  setDeformed(displacement: Float32Array | null, scale: number): void {
    this.deformation = displacement;
    this.deformScale = scale;
    (this.edges?.material as LineBasicMaterial | undefined)?.color.setHex(this.edgeColour());
    this.drawDeformed(displacement, scale);
  }

  /** Preview a host gesture using the existing displacement; the host commits on release. */
  previewDeformScale(scale: number): void {
    this.deformScale = scale;
    this.drawDeformed(this.deformation, scale);
  }

  private drawDeformed(displacement: Float32Array | null, scale: number): void {
    const geom = this.mesh?.geometry;
    const s = this.surface;
    if (!geom || !s) return;
    const active = s.source === 'mesh' && displacement?.length === s.positions.length ? displacement : null;
    const pos = geom.getAttribute('position') as BufferAttribute;
    for (let v = 0; v < this.vert.length; v++) {
      const src = this.vert[v]! * 3;
      for (let k = 0; k < 3; k++) {
        (pos.array as Float32Array)[v * 3 + k] = this.base[v * 3 + k]! + (active ? scale * active[src + k]! : 0);
      }
    }
    pos.needsUpdate = true;
    geom.computeVertexNormals();
    // Raycasting and frustum culling cache these bounds. They must follow the drawn shape;
    // `this.box` is a separate undeformed copy used for framing and auto exaggeration.
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
    const outlineGeom = this.outlines?.geometry;
    const outlinePos = outlineGeom?.getAttribute('position') as BufferAttribute | undefined;
    if (outlinePos) {
      for (let i = 0; i < this.line.length; i++) {
        const edge = this.line[i]!;
        for (let k = 0; k < 2; k++) {
          const node = s.edges?.[edge * 2 + k];
          if (node === undefined) continue;
          const src = node * 3;
          outlinePos.setXYZ(
            i * 2 + k,
            s.positions[src]! + (active ? scale * active[src]! : 0),
            s.positions[src + 1]! + (active ? scale * active[src + 1]! : 0),
            s.positions[src + 2]! + (active ? scale * active[src + 2]! : 0),
          );
        }
      }
      outlinePos.needsUpdate = true;
      // three.js caches both bounds. A result deformation can move the whole boundary outside
      // the original cache, where rendering and line raycasts would otherwise cull it.
      outlineGeom!.computeBoundingBox();
      outlineGeom!.computeBoundingSphere();
    }
    this.render();
  }

  setClip(plane: { normal: [number, number, number]; offset: number } | null): void {
    this.material.clippingPlanes = plane ? [new Plane(new Vector3(...plane.normal).normalize(), -plane.offset)] : [];
    this.material.needsUpdate = true;
    this.outlineMaterial.clippingPlanes = this.material.clippingPlanes;
    this.outlineMaterial.needsUpdate = true;
    this.render();
  }

  setLayer(layer: string, on?: boolean): boolean {
    const visible = on ?? !(this.layerVisibility.get(layer) ?? true);
    this.layerVisibility.set(layer, visible);
    const target = this.layerTarget(layer);
    if (target) target.visible = visible;
    if (layer === 'edges' && this.outlines) this.outlines.visible = visible;
    this.render();
    return visible;
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

  /**
   * The design's ▶ on the deformation bar: sweep the drawn deformation through
   * `A·sin(2π f t)` and back, one second a cycle at `speed` 1. That is exactly right for a
   * mode shape, which is defined only up to an amplitude; a transient Result keeps only its
   * final field (the engine stores no per-frame arrays), so there the sweep is the amplitude
   * growing and shrinking, not a replay of the history — the bar says so.
   *
   * Pausing puts the shape back where `setDeformed` left it, so a paused viewer and a viewer
   * that never played show the same picture.
   */
  animate(playing: boolean, speed = 1, phase?: number): void {
    cancelAnimationFrame(this.frame);
    if (!playing) {
      if (phase !== undefined) return this.setPhase(phase);
      this.animation = { playing: false, phase: 0.25, speed };
      return void this.drawDeformed(this.deformation, this.deformScale);
    }
    this.startAnimation(speed, phase ?? 0);
  }

  private startAnimation(speed: number, phase: number): void {
    this.animation = { playing: true, phase, speed };
    const t0 = performance.now() - (phase / speed) * 1000;
    const step = () => {
      const turns = (((performance.now() - t0) / 1000) * speed) % 1;
      this.animation.phase = turns;
      this.drawDeformed(this.deformation, this.deformScale * Math.sin(turns * 2 * Math.PI));
      this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }

  /** Where in one sweep the shape sits, as a phase in turns: what the scrub slider sets. */
  setPhase(turns: number): void {
    cancelAnimationFrame(this.frame);
    this.animation = { playing: false, phase: turns, speed: this.animation.speed };
    this.drawDeformed(this.deformation, this.deformScale * Math.sin(turns * 2 * Math.PI));
  }

  animationState(): AnimationState {
    return { ...this.animation };
  }

  restoreAnimation(state: AnimationState): void {
    cancelAnimationFrame(this.frame);
    if (state.playing) this.startAnimation(state.speed, state.phase);
    else this.setPhase(state.phase);
  }

  /** Render into an exact-size canvas while `task` records it, then restore the live viewport. */
  async atCaptureSize<T>(width: number, height: number, task: (canvas: HTMLCanvasElement) => Promise<T>): Promise<T> {
    const ratio = this.renderer.getPixelRatio();
    try {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(width, height, false);
      this.perspective.aspect = width / height;
      this.perspective.updateProjectionMatrix();
      this.frameOrtho(width / height);
      this.render();
      return await task(this.canvas);
    } finally {
      this.renderer.setPixelRatio(ratio);
      this.resize();
    }
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

  /**
   * A PNG data URL of exactly what is on screen (`preserveDrawingBuffer`), with the legend
   * painted into the right-hand edge when one is given: a saved image has to be readable on
   * its own, and the HTML legend is not part of the WebGL canvas.
   */
  screenshot(legend?: LegendBurn, options: { width?: number; height?: number; title?: string } = {}): string {
    const size = this.renderer.getDrawingBufferSize(new Vector2());
    const width = options.width ?? (options.height === undefined ? size.x : Math.max(1, Math.round(options.height * size.x / size.y)));
    const height = options.height ?? (options.width === undefined ? size.y : Math.max(1, Math.round(options.width * size.y / size.x)));
    const gl = this.renderer.getContext();
    const limit = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > limit || height > limit)
      throw new FemError('schema', `image dimensions must be positive whole pixels, at most ${limit} on this device`, 'query.screenshot', 'query.screenshot with a smaller width and height');
    const ratio = this.renderer.getPixelRatio();
    try {
      // Render at the requested pixel dimensions, including its aspect ratio. CSS size and
      // camera position stay untouched; finally restores the interactive backing buffer.
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(width, height, false);
      this.perspective.aspect = width / height;
      this.perspective.updateProjectionMatrix();
      this.frameOrtho(width / height);
      this.render();
      return this.burn(legend, options.title);
    } finally {
      this.renderer.setPixelRatio(ratio);
      this.resize();
    }
  }

  private burn(legend?: LegendBurn, title?: string): string {
    if (!legend && !title) return this.canvas.toDataURL('image/png');
    const out = document.createElement('canvas');
    out.width = this.canvas.width;
    out.height = this.canvas.height;
    const g = out.getContext('2d');
    if (!g) throw new FemError('unsupported', 'a 2D canvas is required to draw the requested legend or title', 'query.screenshot', 'query.screenshot without a legend or title');
    g.drawImage(this.canvas, 0, 0);
    // A title owns the first line. Start the legend beneath it so both remain distinct even in
    // a small requested image; the colour bar contracts before it clips at the bottom.
    if (legend) drawLegend(g, out.width, out.height, legend, title ? 78 : 56);
    if (title) {
      g.font = '16px sans-serif';
      g.fillStyle = '#101218ee';
      g.fillRect(12, 12, Math.max(0, Math.min(out.width - 24, g.measureText(title).width + 20)), 30);
      g.fillStyle = '#e9edf3';
      g.fillText(title, 22, 33, Math.max(1, out.width - 44));
    }
    return out.toDataURL('image/png');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.canvas.removeEventListener('click', this.click);
    this.canvas.removeEventListener('pointermove', this.pointerMove);
    this.pickCb = null;
    this.controls.dispose();
    this.disposeSurface();
    this.disposeChrome();
    this.material.dispose();
    this.scene.clear();
    this.surface = null;
    this.field = null;
    this.deformation = null;
    this.base = new Float32Array(0);
    this.vert = new Uint32Array(0);
    this.tri = new Uint32Array(0);
    this.renderer.dispose();
    this.outlineMaterial.dispose();
    this.line = new Uint32Array(0);
  }

  // ── picking ─────────────────────────────────────────────────────────────────────────────
  pick(x: number, y: number): Pick | null {
    const s = this.surface;
    if (!this.mesh || !s) return null;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    // A fixed screen-space picking tolerance remains usable at any zoom and model scale.
    const height = this.camera === this.orthographic
      ? (this.orthographic.top - this.orthographic.bottom) / this.orthographic.zoom
      : 2 * this.camera.position.distanceTo(this.box.getCenter(new Vector3())) * Math.tan(this.perspective.getEffectiveFOV() * Math.PI / 360);
    this.raycaster.params.Line.threshold = 6 * height / Math.max(rect.height, 1);
    const objects = this.outlines?.visible ? [this.mesh, this.outlines] : [this.mesh];
    const hits = this.raycaster.intersectObjects(objects, false);
    const triangle = hits.find((h) => h.object === this.mesh);
    const outline = hits.find((h) => h.object === this.outlines);
    // A Sheet outline is coplanar with its triangles. Prefer it when both hits are at the same
    // depth, so the named boundary wins without allowing a line hidden behind a nearer body.
    const sameDepth = outline && triangle
      ? outline.distance <= triangle.distance + 1e-6 * Math.max(1, outline.distance, triangle.distance)
      : false;
    const hit = outline && (!triangle || sameDepth) ? outline : triangle;
    if (!hit) return null;
    if (hit.object === this.outlines && hit.index !== undefined) {
      const segment = Math.floor(hit.index / 2);
      const edge = this.line[segment]!;
      const node = this.nearestOutlineNode(segment, edge, hit.point);
      return {
        face: s.faceNames[s.edgeFace?.[edge] ?? -1] ?? null,
        body: s.bodyNames[s.edgeBody?.[edge] ?? -1] ?? null,
        point: [hit.point.x, hit.point.y, hit.point.z],
        node,
        value: node !== null && this.field ? (this.field[node] ?? null) : null,
      };
    }
    if (hit.faceIndex === undefined || hit.faceIndex === null) return null;
    const t = this.tri[hit.faceIndex]!;
    const node = this.nearestNode(hit.faceIndex, hit.point);
    return {
      face: s.faceNames[s.triFace[t]!] ?? null,
      body: s.bodyNames[s.triBody[t]!] ?? null,
      point: [hit.point.x, hit.point.y, hit.point.z],
      node,
      value: node !== null && this.field ? (this.field[node] ?? null) : null,
    };
  }

  /** A meshed Sheet outline retains the original node ids carried by its indexed edge. */
  private nearestOutlineNode(segment: number, edge: number, at: Vector3): number | null {
    const s = this.surface;
    const pos = this.outlines?.geometry.getAttribute('position');
    if (!s || s.source !== 'mesh' || !pos) return null;
    let best: number | null = null;
    let nearest = Infinity;
    for (let k = 0; k < 2; k++) {
      const drawn = segment * 2 + k;
      const d = at.distanceToSquared(new Vector3(pos.getX(drawn), pos.getY(drawn), pos.getZ(drawn)));
      if (d < nearest) {
        nearest = d;
        best = s.edges?.[edge * 2 + k] ?? null;
      }
    }
    return best;
  }

  /**
   * The mesh node behind a hit: triangles are expanded, so the drawn triangle's three vertices
   * map back through `vert` to node ids and the nearest of the three is the one a probe means.
   */
  private nearestNode(faceIndex: number, at: Vector3): number | null {
    const pos = this.mesh?.geometry.getAttribute('position');
    if (!pos) return null;
    let best: number | null = null;
    let nearest = Infinity;
    for (let k = 0; k < 3; k++) {
      const drawn = faceIndex * 3 + k;
      const d = at.distanceToSquared(new Vector3(pos.getX(drawn), pos.getY(drawn), pos.getZ(drawn)));
      if (d < nearest) {
        nearest = d;
        best = this.vert[drawn] ?? null;
      }
    }
    return best;
  }

  private hoverAt(e: MouseEvent): void {
    const next = this.pick(e.clientX, e.clientY)?.face ?? null;
    if (next === this.hoverFace) return;
    this.hoverFace = next;
    this.paint();
    this.render();
  }

  private frameOrtho(aspect = (this.canvas.clientWidth || 640) / (this.canvas.clientHeight || 480)): void {
    const h = Math.max(this.box.getSize(new Vector3()).length() * 0.7, 1e-6);
    Object.assign(this.orthographic, { left: -h * aspect, right: h * aspect, top: h, bottom: -h });
    this.orthographic.updateProjectionMatrix();
  }
}

/** The legend the screenshot burns in: gradient bar, title, unit and six ticks, in one column. */
function drawLegend(g: CanvasRenderingContext2D, w: number, h: number, l: LegendBurn, top = 56): void {
  const x = w - 132;
  const barH = Math.max(24, Math.min(300, h - top - 104));
  const stops = MAPS[l.colormap];
  const grad = g.createLinearGradient(0, top + barH, 0, top);
  stops.forEach((c, i) => grad.addColorStop(i / (stops.length - 1), c));
  g.fillStyle = '#101218ee';
  g.fillRect(x - 14, top - 34, 146, barH + 52);
  g.fillStyle = grad;
  g.fillRect(x, top, 16, barH);
  g.fillStyle = '#e7e9ec';
  g.font = '13px ui-monospace, monospace';
  g.fillText(`${l.title} ${l.unit}`.trim(), x - 8, top - 14);
  g.font = '11px ui-monospace, monospace';
  const ticks = Math.max(2, Math.min(6, Math.floor(barH / 18) + 1));
  for (let i = 0; i < ticks; i++) {
    const t = i / (ticks - 1);
    g.fillStyle = i === 0 ? '#e2703a' : '#8b929d';
    g.fillText(String(Number((l.max - (l.max - l.min) * t).toPrecision(4))), x + 22, top + barH * t + 4);
  }
}
