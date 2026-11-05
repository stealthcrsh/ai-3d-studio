import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export type ViewMode = 'material' | 'clay' | 'wire' | 'parts' | 'stretch' | 'collision';
export type CameraView = 'front' | 'back' | 'left' | 'right' | 'three' | 'reset';

export interface ScenePart {
  id: string;
  label: string;
  material: string;
  simulated: boolean;
  vertexCount: number;
  triangles: number;
  offset: number;
}

export interface SceneMeta {
  parts: ScenePart[];
  seams: { name: string; parts: [string, string]; polyline: number[] }[];
  pattern: { part: string; width: number; height: number; outline: [number, number][] }[];
  appearanceVertices: number;
  simVertices: number;
  simTriangles: number;
  massKg: number;
  quality: string;
  tier: string;
  diagnostics?: Record<string, number | boolean>;
  textureSources?: { size: number; sources: Record<string, string> };
}

const PART_COLORS = ['#e8b44c', '#5fb0c9', '#d77a61', '#87b56a', '#b48ad6', '#e2d36b', '#6f8fe0', '#d58cb0', '#59bba2', '#c9a37a', '#ededed', '#bdbdbd'];

function heatColor(t: number, c: THREE.Color) {
  // Blue to green to yellow to red. Value is already 0..1.
  const k = Math.min(1, Math.max(0, t));
  c.setHSL((1 - k) * 0.62, 0.85, 0.5);
}

export class Viewport {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(28, 1, 0.05, 50);
  controls: OrbitControls;
  // Parsed from memory, with embedded textures read through image elements. This needs no network-style fetch of
  // blob URLs, which strict content security policies block.
  private loader = new GLTFLoader().register((parser) => {
    parser.textureLoader = new THREE.TextureLoader(parser.options.manager);
    return { name: 'studio-image-textures' };
  });
  private model: THREE.Object3D | null = null;
  parts = new Map<string, THREE.Mesh>();
  private original = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private avatar: THREE.Object3D | null = null;
  private avatarVisible = true;
  private mixer: THREE.AnimationMixer | null = null;
  private clips: THREE.AnimationClip[] = [];
  private action: THREE.AnimationAction | null = null;
  private mode: ViewMode = 'material';
  private selected: string | null = null;
  private isolated: string | null = null;
  private hidden = new Set<string>();
  private meta: SceneMeta | null = null;
  private heat: Float32Array | null = null;
  private seams: THREE.Group | null = null;
  private loadToken = 0;
  private raf = 0;
  private lastTick = performance.now();
  private resizeObs: ResizeObserver;
  private ground: THREE.Mesh;
  private pointerDown: [number, number] | null = null;
  private basePositions = new Map<string, Float32Array>();
  private baseNormals = new Map<string, Float32Array>();
  motion: { clip: string; fps: number; frames: number; vertices: number; data: Float32Array } | null = null;
  time = 0;
  playing = false;
  speed = 1;
  onTime?: (t: number, frame: number) => void;
  onSelect?: (part: string | null) => void;
  onFrameRate?: (fps: number) => void;
  private fpsAcc = { n: 0, t: 0 };
  reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.domElement.tabIndex = 0;
    this.renderer.domElement.setAttribute('aria-label', '3D model viewport. Arrow keys orbit, plus and minus zoom, R resets the camera.');
    host.appendChild(this.renderer.domElement);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.62;
    const key = new THREE.DirectionalLight('#fff5e8', 2.3);
    key.position.set(2.2, 4.2, 3.4);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -1.4;
    key.shadow.camera.right = 1.4;
    key.shadow.camera.top = 2.2;
    key.shadow.camera.bottom = -0.4;
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 12;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.012;
    key.shadow.radius = 5;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight('#f2f4ff', 1.5);
    rim.position.set(-2.4, 2.8, -3.6);
    this.scene.add(rim);
    const fill = new THREE.DirectionalLight('#ffffff', 0.5);
    fill.position.set(-3, 1, 2.4);
    this.scene.add(fill);
    this.ground = new THREE.Mesh(new THREE.CircleGeometry(4, 64), new THREE.ShadowMaterial({ opacity: 0.34 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.74, 0.748, 96), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.06 }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.001;
    this.scene.add(ring);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = !this.reducedMotion;
    this.controls.dampingFactor = 0.09;
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 9;
    this.controls.target.set(0, 1.08, 0);
    this.setCamera('three');
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(host);
    this.resize();
    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', (e) => (this.pointerDown = [e.clientX, e.clientY]));
    dom.addEventListener('pointerup', (e) => {
      if (this.pointerDown && Math.hypot(e.clientX - this.pointerDown[0], e.clientY - this.pointerDown[1]) < 4) this.pick(e);
      this.pointerDown = null;
    });
    dom.addEventListener('keydown', (e) => this.key(e));
    this.tick();
  }

  private key(e: KeyboardEvent) {
    const step = 0.12;
    const handlers: Record<string, () => void> = {
      ArrowLeft: () => this.orbit(-step, 0), ArrowRight: () => this.orbit(step, 0), ArrowUp: () => this.orbit(0, -step), ArrowDown: () => this.orbit(0, step),
      '+': () => this.zoom(0.88), '=': () => this.zoom(0.88), '-': () => this.zoom(1.14), r: () => this.setCamera('reset'), R: () => this.setCamera('reset'),
      '1': () => this.setCamera('front'), '2': () => this.setCamera('back'), '3': () => this.setCamera('left'), '4': () => this.setCamera('right'), Escape: () => this.select(null, true),
    };
    if (handlers[e.key]) {
      e.preventDefault();
      handlers[e.key]();
    }
  }

  orbit(dAz: number, dEl: number) {
    const off = this.camera.position.clone().sub(this.controls.target);
    const s = new THREE.Spherical().setFromVector3(off);
    s.theta += dAz;
    s.phi = Math.min(Math.PI - 0.05, Math.max(0.05, s.phi + dEl));
    this.camera.position.copy(this.controls.target).add(off.setFromSpherical(s));
  }

  zoom(f: number) {
    const off = this.camera.position.clone().sub(this.controls.target).multiplyScalar(f);
    if (off.length() > 0.5 && off.length() < 9) this.camera.position.copy(this.controls.target).add(off);
  }

  setCamera(view: CameraView) {
    const d = 4.1;
    const t = new THREE.Vector3(0, 1.08, 0);
    const dirs: Record<CameraView, [number, number, number]> = { front: [0, 0.06, 1], back: [0, 0.06, -1], left: [1, 0.06, 0], right: [-1, 0.06, 0], three: [0.52, 0.16, 0.84], reset: [0.52, 0.16, 0.84] };
    const v = new THREE.Vector3(...dirs[view]).normalize().multiplyScalar(d).add(t);
    this.controls.target.copy(t);
    this.camera.position.copy(v);
    this.controls.update();
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private pick(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const meshes = [...this.parts.values()].filter((m) => m.visible);
    const hit = ray.intersectObjects(meshes, false)[0];
    this.select(hit ? hit.object.name : null, true);
  }

  select(part: string | null, notify = false) {
    this.selected = part;
    this.applyMaterials();
    if (notify) this.onSelect?.(part);
  }

  async loadModel(glb: Uint8Array, meta: SceneMeta | null, heat: Float32Array | null) {
    const token = ++this.loadToken;
    const buffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer;
    const gltf = await this.loader.parseAsync(buffer, '');
    if (token !== this.loadToken) return false;
    // The previous asset stays on screen until the new one is ready, so inspection is never interrupted.
    if (this.model) this.scene.remove(this.model);
    this.parts.clear();
    this.original.clear();
    this.basePositions.clear();
    this.baseNormals.clear();
    this.motion = null;
    this.model = gltf.scene;
    this.meta = meta;
    this.clips = gltf.animations;
    this.mixer = new THREE.AnimationMixer(gltf.scene);
    this.action = null;
    this.avatar = gltf.scene.getObjectByName('Avatar') ?? null;
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      m.receiveShadow = true;
      if ((m as THREE.SkinnedMesh).isSkinnedMesh) {
        m.frustumCulled = false;
        return;
      }
      this.parts.set(m.name, m);
      m.frustumCulled = false;
      this.original.set(m, m.material);
      this.basePositions.set(m.name, (m.geometry.attributes.position.array as Float32Array).slice());
      this.baseNormals.set(m.name, (m.geometry.attributes.normal.array as Float32Array).slice());
      const mat = m.material as THREE.MeshStandardMaterial;
      if (mat.map) mat.map.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      if (mat.normalMap) mat.normalScale.set(0.7, 0.7);
    });
    this.scene.add(gltf.scene);
    this.heat = heat;
    this.applyVisibility();
    this.applyMaterials();
    return true;
  }

  setMode(mode: ViewMode) {
    this.mode = mode;
    this.applyMaterials();
  }

  private matCache = new Map<string, THREE.Material>();
  private applyMaterials() {
    const clay = this.cached('clay', () => new THREE.MeshStandardMaterial({ color: '#b7b4ad', roughness: 0.82, side: THREE.DoubleSide }));
    let index = 0;
    for (const [name, mesh] of this.parts) {
      const original = this.original.get(mesh)!;
      let mat: THREE.Material | THREE.Material[] = original;
      const color = PART_COLORS[index++ % PART_COLORS.length];
      if (this.mode === 'clay') mat = clay;
      if (this.mode === 'wire') mat = this.cached(`wire:${name}`, () => new THREE.MeshBasicMaterial({ color: '#c6d3e0', wireframe: true, transparent: true, opacity: 0.75 }));
      if (this.mode === 'parts') mat = this.cached(`part:${name}`, () => new THREE.MeshStandardMaterial({ color, roughness: 0.8, side: THREE.DoubleSide }));
      if (this.mode === 'stretch' || this.mode === 'collision') {
        this.writeHeat(name, mesh);
        mat = this.cached('heat', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide }));
      }
      if (this.selected === name) {
        const base = (Array.isArray(mat) ? mat[0] : mat) as THREE.MeshStandardMaterial;
        if ('emissive' in base) {
          mat = this.cached(`sel:${this.mode}:${name}`, () => {
            const c = base.clone();
            c.emissive = new THREE.Color('#e9a93c');
            c.emissiveIntensity = 0.32;
            return c;
          });
        }
      }
      mesh.material = mat;
    }
  }

  private cached(key: string, make: () => THREE.Material) {
    let m = this.matCache.get(key);
    if (!m) {
      m = make();
      this.matCache.set(key, m);
    }
    return m;
  }

  private writeHeat(name: string, mesh: THREE.Mesh) {
    const count = mesh.geometry.attributes.position.count;
    const arr = new Float32Array(count * 3);
    const c = new THREE.Color();
    const part = this.meta?.parts.find((p) => p.id === name);
    for (let i = 0; i < count; i++) {
      let v = 0;
      if (this.heat && part) {
        const h = (part.offset + i) * 2;
        v = this.mode === 'stretch' ? (this.heat[h] - 1) / 0.3 : this.heat[h + 1] / 0.006;
      }
      heatColor(v, c);
      arr.set([c.r, c.g, c.b], i * 3);
    }
    mesh.geometry.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  }

  setHidden(hidden: Set<string>) {
    this.hidden = hidden;
    this.applyVisibility();
  }

  setIsolated(part: string | null) {
    this.isolated = part;
    this.applyVisibility();
  }

  setAvatarVisible(v: boolean) {
    this.avatarVisible = v;
    this.applyVisibility();
  }

  private applyVisibility() {
    for (const [name, mesh] of this.parts) mesh.visible = !this.hidden.has(name) && (!this.isolated || this.isolated === name);
    if (this.avatar) {
      const show = this.avatarVisible && !this.isolated;
      this.avatar.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) o.visible = show;
      });
    }
  }

  showSeams(seams: SceneMeta['seams'] | null, highlight: string | null) {
    if (this.seams) {
      this.scene.remove(this.seams);
      this.seams.traverse((o) => (o as THREE.Line).geometry?.dispose());
      this.seams = null;
    }
    if (!seams) return;
    const g = new THREE.Group();
    for (const s of seams) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(s.polyline), 3));
      const on = highlight === s.name;
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: on ? '#ffd166' : '#ff5d8f', transparent: true, opacity: on ? 1 : highlight ? 0.2 : 0.85, depthTest: !on }));
      line.renderOrder = 10;
      g.add(line);
    }
    this.seams = g;
    this.scene.add(g);
  }

  loadMotion(clip: string, meta: { fps: number; frames: number; vertices: number }, data: Float32Array) {
    this.motion = { clip, fps: meta.fps, frames: meta.frames, vertices: meta.vertices, data };
    const animClip = this.clips.find((c) => c.name === clip);
    this.action?.stop();
    if (animClip && this.mixer) {
      this.action = this.mixer.clipAction(animClip);
      this.action.play();
      this.action.paused = true;
    }
    this.time = 0;
    this.applyFrame(0);
  }

  clearMotion() {
    this.motion = null;
    this.playing = false;
    this.action?.stop();
    this.action = null;
    for (const [name, mesh] of this.parts) {
      (mesh.geometry.attributes.position.array as Float32Array).set(this.basePositions.get(name)!);
      (mesh.geometry.attributes.normal.array as Float32Array).set(this.baseNormals.get(name)!);
      mesh.geometry.attributes.position.needsUpdate = true;
      mesh.geometry.attributes.normal.needsUpdate = true;
    }
  }

  get duration() {
    return this.motion ? this.motion.frames / this.motion.fps : 0;
  }

  seek(t: number) {
    if (!this.motion) return;
    const d = this.duration;
    this.time = ((t % d) + d) % d;
    this.applyFrame(this.time);
  }

  private applyFrame(t: number) {
    const m = this.motion;
    if (!m || !this.meta) return;
    const f = t * m.fps;
    const f0 = Math.floor(f) % m.frames;
    const f1 = (f0 + 1) % m.frames;
    const k = f - Math.floor(f);
    const stride = m.vertices * 6;
    for (const part of this.meta.parts) {
      const mesh = this.parts.get(part.id);
      if (!mesh) continue;
      const pos = mesh.geometry.attributes.position.array as Float32Array;
      const nor = mesh.geometry.attributes.normal.array as Float32Array;
      const a = f0 * stride + part.offset * 6;
      const b = f1 * stride + part.offset * 6;
      for (let i = 0; i < part.vertexCount; i++) {
        const ia = a + i * 6;
        const ib = b + i * 6;
        for (let c = 0; c < 3; c++) {
          pos[i * 3 + c] = m.data[ia + c] + (m.data[ib + c] - m.data[ia + c]) * k;
          nor[i * 3 + c] = m.data[ia + 3 + c] + (m.data[ib + 3 + c] - m.data[ia + 3 + c]) * k;
        }
      }
      mesh.geometry.attributes.position.needsUpdate = true;
      mesh.geometry.attributes.normal.needsUpdate = true;
    }
    if (this.action && this.mixer) {
      this.action.time = Math.min(t, this.action.getClip().duration - 1e-3);
      this.mixer.update(0);
    }
    this.onTime?.(t, f0);
  }

  /** Render a garment-only silhouette from a matched flat camera, then compare it with the reference mask. */
  silhouette(view: 'front' | 'back', size: number) {
    const box = new THREE.Box3();
    for (const m of this.parts.values()) box.expandByObject(m);
    if (box.isEmpty()) return null;
    const c = box.getCenter(new THREE.Vector3());
    const s = box.getSize(new THREE.Vector3());
    const half = Math.max(s.x, s.y) / 2;
    const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.01, 20);
    cam.position.set(c.x, c.y, c.z + (view === 'front' ? 5 : -5));
    cam.lookAt(c);
    const rt = new THREE.WebGLRenderTarget(size, size);
    const prev = { bg: this.scene.background, over: this.scene.overrideMaterial, ground: this.ground.visible, seams: this.seams?.visible };
    const white = new THREE.MeshBasicMaterial({ color: '#ffffff', side: THREE.DoubleSide });
    this.scene.overrideMaterial = white;
    this.ground.visible = false;
    if (this.seams) this.seams.visible = false;
    const shown: THREE.Object3D[] = [];
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.visible && !this.parts.has(m.name)) {
        m.visible = false;
        shown.push(m);
      }
    });
    const clear = new THREE.Color();
    this.renderer.getClearColor(clear);
    const alpha = this.renderer.getClearAlpha();
    this.renderer.setClearColor('#000000', 1);
    this.renderer.setRenderTarget(rt);
    this.renderer.clear();
    this.renderer.render(this.scene, cam);
    const px = new Uint8Array(size * size * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, size, size, px);
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(clear, alpha);
    for (const m of shown) m.visible = true;
    this.scene.overrideMaterial = prev.over;
    this.ground.visible = prev.ground;
    if (this.seams) this.seams.visible = prev.seams ?? true;
    rt.dispose();
    white.dispose();
    const mask = new Uint8Array(size * size);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const o = (y * size + x) * 4;
        // Pixels are bottom-up; store top-down, and mirror the back view to the image the photo shows.
        const tx = x;
        mask[(size - 1 - y) * size + tx] = px[o] > 40 ? 1 : 0;
      }
    return mask;
  }

  snapshot(view: 'front' | 'back', size: number): string {
    const save = { pos: this.camera.position.clone(), tgt: this.controls.target.clone() };
    const prevSize = this.renderer.getSize(new THREE.Vector2());
    const prevAspect = this.camera.aspect;
    this.camera.aspect = 1;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(size, size, false);
    const t = new THREE.Vector3(0, 1.12, 0);
    this.camera.position.set(0, 1.16, view === 'front' ? 2.1 : -2.1);
    this.camera.lookAt(t);
    this.renderer.render(this.scene, this.camera);
    const data = this.renderer.domElement.toDataURL('image/png');
    this.renderer.setSize(prevSize.x, prevSize.y);
    this.camera.aspect = prevAspect;
    this.camera.updateProjectionMatrix();
    this.camera.position.copy(save.pos);
    this.controls.target.copy(save.tgt);
    this.controls.update();
    return data;
  }

  private tick = () => {
    this.raf = requestAnimationFrame(this.tick);
    const now = performance.now();
    const dt = Math.min(0.5, (now - this.lastTick) / 1000);
    this.lastTick = now;
    this.controls.update();
    if (this.playing && this.motion) {
      this.time = (this.time + dt * this.speed) % this.duration;
      this.applyFrame(this.time);
    }
    this.renderer.render(this.scene, this.camera);
    this.fpsAcc.n++;
    this.fpsAcc.t += dt;
    if (this.fpsAcc.t > 1) {
      this.onFrameRate?.(this.fpsAcc.n / this.fpsAcc.t);
      this.fpsAcc = { n: 0, t: 0 };
    }
  };

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
