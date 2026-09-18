import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { CameraRig } from './CameraRig';
import { Environment } from './Environment';
import { EdgeRenderer, type EdgeObject } from './EdgeRenderer';
import { buildNode, animateNode, ZONE_COLOR, type NodeObject } from './NodeFactory';
import { makeLabel } from './Labels';
import { TOP_NODES, NODE_BY_ID, childrenOf, topOf } from '../data/graph/nodes';
import { TOP_EDGES, SUB_EDGES } from '../data/graph/edges';
import { JOURNEYS } from '../data/graph/journeys';
import type { EdgeKind, Journey, WorldNode } from '../data/graph/types';

interface LiveNode { node: WorldNode; obj: NodeObject; pos: THREE.Vector3; label: THREE.Sprite; detail?: THREE.Sprite; isChild: boolean }

export interface WorldState {
  selected: string | null;
  stack: string[];
  expanded: string[];
  hover: string | null;
  trace: Journey | null;
  traceStep: number;
  filters: EdgeKind[];
  safe: boolean;
  labels: boolean;
  nodeCount: number; edgeCount: number;
}

export class WorldScene {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  rig: CameraRig;
  env: Environment;
  edges: EdgeRenderer;
  private composer: EffectComposer | null = null;
  private nodes = new Map<string, LiveNode>();
  private hits: THREE.Mesh[] = [];
  private expanded = new Set<string>();
  private stack: string[] = [];
  private hover: string | null = null;
  private trace: Journey | null = null;
  private traceStep = 0;
  private traceGroup: THREE.Group | null = null;
  private tracePoints: THREE.Points | null = null;
  private traceCurve: THREE.CatmullRomCurve3 | null = null;
  private traceMarkers: THREE.Sprite[] = [];
  private labelsOn = true;
  private ray = new THREE.Raycaster();
  private clock = new THREE.Clock();
  private t = 0;
  private liveSubEdges = new Set<string>();
  safe: boolean;
  onChange: ((s: WorldState) => void) | null = null;
  private seed = 1;

  constructor(canvas: HTMLCanvasElement, safe = false) {
    this.safe = safe;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !safe, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, safe ? 1 : 1.5));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.05;
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400);
    this.rig = new CameraRig(this.camera);
    this.env = new Environment(this.scene, safe);
    this.edges = new EdgeRenderer(this.scene, safe);
    this.buildTopLevel();
    this.resize();
    if (!safe) {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.32, 0.5, 0.78);
      this.composer.addPass(bloom);
    }
    this.applyVisibility(); this.emit();
  }

  // ---------------- build ----------------
  private buildTopLevel() {
    for (const n of TOP_NODES) this.spawnNode(n, new THREE.Vector3(...n.pos!), false);
    for (const e of TOP_EDGES) this.spawnEdge(e);
  }
  private spawnNode(n: WorldNode, pos: THREE.Vector3, isChild: boolean) {
    const obj = buildNode(n); obj.group.position.copy(pos); this.scene.add(obj.group); this.hits.push(obj.hit);
    const accent = n.kind === 'finance_engine' ? '#f5b400' : n.kind === 'external' ? '#a78bfa' : ZONE_COLOR[n.zone];
    const label = makeLabel({ title: isChild ? n.label : (n.short ?? n.label), sub: isChild ? undefined : (n.code ? `${n.code}${n.bp ? ' · BP-' + n.bp : ''}` : n.bp ? 'BP-' + n.bp : undefined), accent, scale: isChild ? 0.42 : 0.95, width: isChild ? 640 : 520 });
    label.position.copy(pos).add(new THREE.Vector3(0, obj.radius + (isChild ? 0.55 : 1.15), 0));
    this.scene.add(label);
    if (isChild) { obj.scale = 0.01; obj.targetScale = 1; }
    this.nodes.set(n.id, { node: n, obj, pos, label, isChild });
  }
  private spawnEdge(e: { id?: string; source: string; target: string; kind: EdgeKind; label: string; dir?: 'forward' | 'both'; ref?: string }): EdgeObject | null {
    const a = this.nodes.get(e.source), b = this.nodes.get(e.target); if (!a || !b) return null;
    const id = e.id ?? `${e.source}>${e.target}>${e.kind}`;
    if (this.edges.edges.has(id)) return this.edges.edges.get(id)!;
    return this.edges.add({ ...e, id }, a.pos, b.pos, a.obj.radius, b.obj.radius, this.seed++);
  }
  private despawnNode(id: string) {
    const ln = this.nodes.get(id); if (!ln) return;
    this.scene.remove(ln.obj.group); this.scene.remove(ln.label); if (ln.detail) this.scene.remove(ln.detail);
    this.hits = this.hits.filter(h => h !== ln.obj.hit);
    ln.obj.group.traverse(c => { const m = c as THREE.Mesh; if (m.geometry) m.geometry.dispose(); });
    this.nodes.delete(id);
  }

  // ---------------- expansion ----------------
  expand(parentId: string) {
    if (this.expanded.has(parentId)) return;
    const parent = this.nodes.get(parentId); if (!parent) return;
    const kids = childrenOf(parentId); if (!kids.length) return;
    this.expanded.add(parentId);
    const n = kids.length; const r = n <= 6 ? 3.6 : n <= 9 ? 4.3 : 5.0;
    // ring in a plane facing the presenter (camera basis at expansion time)
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0).normalize();
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1).normalize();
    kids.forEach((k, i) => {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const p = parent.pos.clone().addScaledVector(right, Math.cos(a) * r * 1.15).addScaledVector(up, Math.sin(a) * r * 0.85);
      this.spawnNode(k, p, true);
    });
    this.refreshSubEdges();
  }
  collapse(parentId: string) {
    if (!this.expanded.has(parentId)) return;
    this.expanded.delete(parentId);
    for (const k of childrenOf(parentId)) this.despawnNode(k.id);
    this.refreshSubEdges();
  }
  private refreshSubEdges() {
    for (const e of SUB_EDGES) {
      const id = e.id!; const present = this.nodes.has(e.source) && this.nodes.has(e.target);
      if (present && !this.liveSubEdges.has(id)) { if (this.spawnEdge(e)) this.liveSubEdges.add(id); }
      else if (!present && this.liveSubEdges.has(id)) { this.edges.remove(id); this.liveSubEdges.delete(id); }
    }
  }

  // ---------------- interaction API (mouse / keyboard / gesture all call these) ----------------
  hoverAt(nx: number, ny: number): string | null {
    this.ray.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    const hit = this.ray.intersectObjects(this.hits, false)[0];
    const id = hit ? (hit.object.userData.nodeId as string) : null;
    if (id !== this.hover) { this.setHover(id); }
    return id;
  }
  private setHover(id: string | null) {
    if (this.hover) { const ln = this.nodes.get(this.hover); if (ln) { ln.obj.hover = false; if (ln.detail && this.stackTop() !== this.hover) { this.scene.remove(ln.detail); ln.detail = undefined; } } }
    this.hover = id;
    if (id) { const ln = this.nodes.get(id); if (ln) { ln.obj.hover = true; this.ensureDetail(ln); } }
    this.emit();
  }
  private ensureDetail(ln: LiveNode) {
    if (ln.detail || !ln.node.purpose) return;
    const accent = ln.node.kind === 'finance_engine' ? '#f5b400' : ZONE_COLOR[ln.node.zone];
    ln.detail = makeLabel({ title: ln.node.label, sub: ln.node.purpose, accent, scale: ln.isChild ? 0.62 : 0.85, width: 760 });
    ln.detail.position.copy(ln.pos).add(new THREE.Vector3(0, -(ln.obj.radius + (ln.isChild ? 0.7 : 1.3)), 0));
    this.scene.add(ln.detail);
  }
  hoveredId() { return this.hover; }

  select(id: string | null) {
    if (!id) { this.reset(); return; }
    const ln = this.nodes.get(id); if (!ln) return;
    const top = this.stackTop();
    if (top) { const prev = this.nodes.get(top); if (prev) { prev.obj.selected = false; if (prev.detail && this.hover !== top) { this.scene.remove(prev.detail); prev.detail = undefined; } } }
    if (this.stack[this.stack.length - 1] !== id) this.stack.push(id);
    ln.obj.selected = true; this.ensureDetail(ln);
    if (!ln.isChild) this.expand(id);
    const radius = ln.node.kind === 'ai_core' ? 14 : ln.isChild ? 7 : 11.5;
    this.rig.focus(ln.pos, radius, 1.3);
    this.clearTrace(false);
    this.applyVisibility(); this.emit();
  }
  selectHovered() { if (this.hover) this.select(this.hover); }
  back() {
    if (this.trace) { this.clearTrace(true); this.applyVisibility(); this.emit(); return; }
    const cur = this.stack.pop(); if (!cur) { this.reset(); return; }
    const ln = this.nodes.get(cur); if (ln) { ln.obj.selected = false; if (ln.detail) { this.scene.remove(ln.detail); ln.detail = undefined; } }
    const parentStillNeeded = this.stack.some(s => topOf(s) === topOf(cur));
    if (!parentStillNeeded) this.collapse(topOf(cur));
    const next = this.stackTop();
    if (next) { const nl = this.nodes.get(next)!; nl.obj.selected = true; this.rig.focus(nl.pos, nl.isChild ? 7 : 11.5, 1.1); }
    else this.rig.reset();
    this.applyVisibility(); this.emit();
  }
  reset() {
    this.clearTrace(true);
    for (const s of this.stack) { const ln = this.nodes.get(s); if (ln) { ln.obj.selected = false; if (ln.detail) { this.scene.remove(ln.detail); ln.detail = undefined; } } }
    this.stack = [];
    for (const p of Array.from(this.expanded)) this.collapse(p);
    this.rig.reset();
    this.applyVisibility(); this.emit();
  }
  stackTop() { return this.stack[this.stack.length - 1] ?? null; }

  // ---------------- trace mode ----------------
  traceJourney(journeyId: string | null) {
    this.clearTrace(true);
    if (!journeyId) { this.applyVisibility(); this.emit(); return; }
    const j = JOURNEYS.find(x => x.id === journeyId); if (!j) return;
    // expand every parent needed
    for (const s of j.steps) { const p = NODE_BY_ID[s]?.parent; if (p) this.expand(p); }
    const pts = j.steps.map(s => this.nodes.get(s)?.pos).filter((p): p is THREE.Vector3 => !!p);
    if (pts.length < 2) return;
    this.trace = j; this.traceStep = 0;
    this.traceCurve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.35);
    const g = new THREE.Group();
    const tube = new THREE.Mesh(new THREE.TubeGeometry(this.traceCurve, pts.length * 14, 0.05, 8, false),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.42, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    g.add(tube);
    const halo = new THREE.Mesh(new THREE.TubeGeometry(this.traceCurve, pts.length * 14, 0.16, 8, false),
      new THREE.MeshBasicMaterial({ color: 0x38d9ff, transparent: true, opacity: 0.07, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    g.add(halo);
    const n = 60; const pos = new Float32Array(n * 3); const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.tracePoints = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.28, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    g.add(this.tracePoints);
    // numbered markers
    j.steps.forEach((s, i) => {
      const ln = this.nodes.get(s); if (!ln) return;
      const m = makeLabel({ title: `${i + 1}`, accent: '#ffffff', color: '#ffffff', scale: 0.42, width: 96 });
      m.position.copy(ln.pos).add(new THREE.Vector3(0.9, ln.obj.radius + 0.35, 0)); g.add(m); this.traceMarkers.push(m);
    });
    this.scene.add(g); this.traceGroup = g;
    // frame the path
    const box = new THREE.Box3().setFromPoints(pts); const c = box.getCenter(new THREE.Vector3()); const size = box.getSize(new THREE.Vector3()).length();
    this.rig.flyTo({ target: c, radius: Math.max(14, size * 0.75), theta: this.rig.theta, phi: 1.15 }, 1.6);
    this.applyVisibility(); this.emit();
  }
  traceNext(dir = 1) {
    if (!this.trace) return;
    this.traceStep = (this.traceStep + dir + this.trace.steps.length) % this.trace.steps.length;
    const ln = this.nodes.get(this.trace.steps[this.traceStep]); if (ln) this.rig.focus(ln.pos, 8, 0.9);
    this.emit();
  }
  private clearTrace(collapse: boolean) {
    if (this.traceGroup) { this.scene.remove(this.traceGroup); this.traceGroup.traverse(c => { const m = c as THREE.Mesh; if (m.geometry) m.geometry.dispose(); }); }
    this.traceGroup = null; this.tracePoints = null; this.traceCurve = null; this.traceMarkers = [];
    const had = this.trace; this.trace = null;
    if (collapse && had) { for (const p of Array.from(this.expanded)) if (!this.stack.some(s => topOf(s) === p)) this.collapse(p); }
  }

  setFilter(kind: EdgeKind, on: boolean) { this.edges.setFilter(kind, on); this.emit(); }
  soloFilter(kind: EdgeKind | null) { for (const k of Object.keys(this.edges.filters) as EdgeKind[]) void k; const all: EdgeKind[] = ['process', 'financial', 'approval', 'master_data', 'document', 'event', 'audit', 'notification', 'ai_knowledge', 'ai_tool', 'integration', 'security']; for (const k of all) this.edges.setFilter(k, kind ? k === kind : true); this.emit(); }
  toggleLabels() { this.labelsOn = !this.labelsOn; this.emit(); }

  // ---------------- visibility model ----------------
  private neighborsOf(id: string): Set<string> {
    const s = new Set<string>();
    for (const e of this.edges.edges.values()) { if (e.edge.source === id) s.add(e.edge.target); if (e.edge.target === id) s.add(e.edge.source); }
    return s;
  }
  private applyVisibility() {
    const sel = this.stackTop();
    if (this.trace) {
      const path = new Set(this.trace.steps); const parents = new Set(this.trace.steps.map(s => topOf(s)));
      for (const [id, ln] of this.nodes) ln.obj.targetAlpha = path.has(id) ? 1 : parents.has(id) ? 0.55 : 0.12;
      for (const e of this.edges.edges.values()) {
        const onPath = path.has(e.edge.source) && path.has(e.edge.target);
        e.targetAlpha = onPath ? 1 : 0.05;
      }
      return;
    }
    if (sel) {
      const kids = new Set(childrenOf(topOf(sel)).map(k => k.id)); const nb = this.neighborsOf(sel); const top = topOf(sel);
      for (const [id, ln] of this.nodes) {
        ln.obj.targetAlpha = id === sel || id === top ? 1 : kids.has(id) ? 0.95 : nb.has(id) ? 0.8 : ln.isChild ? 0.5 : 0.16;
      }
      for (const e of this.edges.edges.values()) {
        const inc = e.edge.source === sel || e.edge.target === sel;
        const kidInc = kids.has(e.edge.source) || kids.has(e.edge.target) || e.edge.source === top || e.edge.target === top;
        e.targetAlpha = inc ? 1 : kidInc ? 0.85 : (nb.has(e.edge.source) && nb.has(e.edge.target)) ? 0.3 : 0.07;
      }
      return;
    }
    for (const ln of this.nodes.values()) ln.obj.targetAlpha = 1;
    for (const e of this.edges.edges.values()) e.targetAlpha = 1;
  }

  // ---------------- frame loop ----------------
  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    if (!w || !h) return; // hidden / zero-size viewport — keep last valid projection
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.composer?.setSize(w, h);
  }
  /** Advance one frame. dtOverride enables deterministic stepping (tests / presenter scripts). */
  frame(dtOverride?: number) {
    const dt = dtOverride ?? Math.min(0.05, this.clock.getDelta()); this.t += dt;
    this.rig.update(dt); this.env.update(dt); this.edges.update(dt);
    const camPos = this.camera.position;
    for (const ln of this.nodes.values()) {
      animateNode(ln.obj, dt, this.t);
      const d = camPos.distanceTo(ln.pos);
      const fadeFar = ln.isChild ? 30 : 58; const fade = THREE.MathUtils.clamp(1 - (d - fadeFar * 0.55) / (fadeFar * 0.45), 0, 1);
      const a = this.labelsOn ? ln.obj.alpha * fade * (ln.obj.alpha < 0.3 && !ln.obj.hover ? 0 : 1) : 0;
      ln.label.material.opacity = a; ln.label.visible = a > 0.02;
      const s = ln.isChild ? 0.42 : 0.95; const ds = THREE.MathUtils.clamp(d / 34, 0.75, 1.6);
      ln.label.scale.set((ln.isChild ? 640 : 520) / 128 * s * ds, (ln.isChild ? 96 : 148) / 128 * s * ds, 1);
      if (ln.detail) { ln.detail.material.opacity = Math.min(1, ln.obj.alpha * 1.2); const dd = THREE.MathUtils.clamp(d / 30, 0.7, 1.4); ln.detail.scale.set(760 / 128 * (ln.isChild ? 0.62 : 0.85) * dd, 148 / 128 * (ln.isChild ? 0.62 : 0.85) * dd, 1); }
    }
    if (this.tracePoints && this.traceCurve) {
      const pos = this.tracePoints.geometry.attributes.position as THREE.BufferAttribute; const n = pos.count;
      for (let i = 0; i < n; i++) { const t = (this.t * 0.12 + i / n) % 1; const p = this.traceCurve.getPoint(t); pos.setXYZ(i, p.x, p.y, p.z); }
      pos.needsUpdate = true;
    }
    if (this.composer) this.composer.render(); else this.renderer.render(this.scene, this.camera);
  }

  private emit() {
    this.onChange?.({
      selected: this.stackTop(), stack: [...this.stack], expanded: Array.from(this.expanded), hover: this.hover,
      trace: this.trace, traceStep: this.traceStep, filters: Array.from(this.edges.filters), safe: this.safe, labels: this.labelsOn,
      nodeCount: this.nodes.size, edgeCount: this.edges.edges.size,
    });
  }
  sync() { this.emit(); }
  dispose() { this.renderer.dispose(); }
}
