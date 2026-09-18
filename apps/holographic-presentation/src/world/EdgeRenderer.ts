import * as THREE from 'three';
import type { EdgeKind, WorldEdge } from '../data/graph/types';
import { EDGE_KIND_META } from '../data/graph/types';

/** Visual grammar per edge kind — behaviour, not only colour. */
interface KindStyle { tube?: number; dash?: [number, number]; double?: boolean; particles: number; speed: number; opacity: number; width: number; burst?: boolean }
const STYLE: Record<EdgeKind, KindStyle> = {
  process:      { tube: 0.035, particles: 4, speed: 0.22, opacity: 0.55, width: 1 },
  financial:    { tube: 0.05, particles: 7, speed: 0.30, opacity: 0.55, width: 1 },
  approval:     { dash: [0.55, 0.35], particles: 2, speed: 0.16, opacity: 0.75, width: 1 },
  master_data:  { double: true, particles: 0, speed: 0, opacity: 0.45, width: 1 },
  document:     { dash: [1.4, 0.5], double: true, particles: 1, speed: 0.12, opacity: 0.55, width: 1 },
  event:        { dash: [0.9, 0.5], particles: 3, speed: 0.28, opacity: 0.5, width: 1 },
  audit:        { particles: 0, speed: 0, opacity: 0.22, width: 1 },
  notification: { dash: [0.3, 0.9], particles: 2, speed: 0.6, opacity: 0.55, width: 1, burst: true },
  ai_knowledge: { tube: 0.028, particles: 6, speed: 0.34, opacity: 0.55, width: 1 },
  ai_tool:      { tube: 0.032, particles: 5, speed: 0.34, opacity: 0.6, width: 1 },
  integration:  { tube: 0.04, particles: 3, speed: 0.24, opacity: 0.5, width: 1 },
  security:     { dash: [0.25, 0.25], particles: 1, speed: 0.1, opacity: 0.6, width: 1 },
};

export interface EdgeObject {
  edge: WorldEdge;
  group: THREE.Group;
  curve: THREE.QuadraticBezierCurve3;
  mats: (THREE.Material & { opacity: number })[];
  baseOpacity: number;
  alpha: number; targetAlpha: number;
  particleStart: number; particleCount: number;
  speed: number; reverseHalf: boolean; burst: boolean;
  kind: EdgeKind;
  tOffset: number;
}

const MAX_PARTICLES = 6000;

export class EdgeRenderer {
  group = new THREE.Group();
  edges = new Map<string, EdgeObject>();
  private pPositions = new Float32Array(MAX_PARTICLES * 3);
  private pColors = new Float32Array(MAX_PARTICLES * 3);
  private pUsed = 0;
  private free: { start: number; count: number }[] = [];
  private points: THREE.Points;
  private pGeo: THREE.BufferGeometry;
  private time = 0;
  particleScale = 1;
  filters = new Set<EdgeKind>(Object.keys(STYLE) as EdgeKind[]);

  constructor(scene: THREE.Scene, safe: boolean) {
    this.pGeo = new THREE.BufferGeometry();
    this.pGeo.setAttribute('position', new THREE.BufferAttribute(this.pPositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.pGeo.setAttribute('color', new THREE.BufferAttribute(this.pColors, 3).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(this.pGeo, new THREE.PointsMaterial({ size: safe ? 0.14 : 0.17, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    this.points.frustumCulled = false; this.points.renderOrder = 10;
    this.group.add(this.points);
    this.particleScale = safe ? 0.5 : 1;
    scene.add(this.group);
  }

  /** Build the curve between two world points, arcing away from the origin / upward. */
  static curveFor(a: THREE.Vector3, b: THREE.Vector3, ra: number, rb: number, seed: number): THREE.QuadraticBezierCurve3 {
    const dir = b.clone().sub(a); const len = dir.length(); dir.normalize();
    const start = a.clone().addScaledVector(dir, ra * 0.85); const end = b.clone().addScaledVector(dir, -rb * 0.85);
    const mid = start.clone().add(end).multiplyScalar(0.5);
    const up = new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3().crossVectors(dir, up).normalize();
    const bend = Math.min(3.2, len * 0.16);
    const wobble = ((seed * 9301 + 49297) % 233280) / 233280 - 0.5;
    mid.addScaledVector(up, bend * 0.9).addScaledVector(side, wobble * bend * 1.4);
    return new THREE.QuadraticBezierCurve3(start, mid, end);
  }

  add(edge: WorldEdge, a: THREE.Vector3, b: THREE.Vector3, ra: number, rb: number, seed: number): EdgeObject {
    const kind = edge.kind; const st = STYLE[kind]; const meta = EDGE_KIND_META[kind];
    const color = new THREE.Color(meta.color);
    const curve = EdgeRenderer.curveFor(a, b, ra, rb, seed);
    const g = new THREE.Group(); const mats: (THREE.Material & { opacity: number })[] = [];
    const segs = 40;
    if (st.tube) {
      const geo = new THREE.TubeGeometry(curve, segs, st.tube, 6, false);
      const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: st.opacity, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
      g.add(new THREE.Mesh(geo, m)); mats.push(m);
      if (kind === 'financial') { // outer soft halo
        const m2 = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: st.opacity * 0.14, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
        g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, segs, st.tube * 2.4, 6, false), m2)); mats.push(m2);
      }
    } else {
      const pts = curve.getPoints(segs);
      const mk = (offset: number) => {
        const p = offset ? pts.map(v => v.clone().add(new THREE.Vector3(0, offset, 0))) : pts;
        const geo = new THREE.BufferGeometry().setFromPoints(p);
        const m = st.dash
          ? new THREE.LineDashedMaterial({ color, transparent: true, opacity: st.opacity, dashSize: st.dash[0], gapSize: st.dash[1], depthWrite: false, toneMapped: false })
          : new THREE.LineBasicMaterial({ color, transparent: true, opacity: st.opacity, depthWrite: false, toneMapped: false });
        const line = new THREE.Line(geo, m); line.computeLineDistances(); g.add(line); mats.push(m);
      };
      if (st.double) { mk(0.07); mk(-0.07); } else mk(0);
    }
    // arrow head at the end (direction cue)
    const end = curve.getPoint(1), tan = curve.getTangent(1);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.34, 8), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: Math.min(1, st.opacity + 0.25), toneMapped: false }));
    cone.position.copy(end); cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tan); g.add(cone); mats.push(cone.material as THREE.MeshBasicMaterial);
    if (edge.dir === 'both') {
      const c2 = cone.clone(); c2.position.copy(curve.getPoint(0)); c2.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), curve.getTangent(0).negate()); g.add(c2);
    }
    this.group.add(g);
    const count = Math.round(st.particles * this.particleScale);
    let start: number, got: number;
    const fi = this.free.findIndex(f => f.count >= count);
    if (count > 0 && fi >= 0) { const f = this.free.splice(fi, 1)[0]; start = f.start; got = count; if (f.count > count) this.free.push({ start: f.start + count, count: f.count - count }); }
    else { start = this.pUsed; this.pUsed = Math.min(MAX_PARTICLES, this.pUsed + count); got = this.pUsed - start; }
    for (let i = start; i < start + got; i++) { this.pColors.set([color.r, color.g, color.b], i * 3); }
    const obj: EdgeObject = { edge, group: g, curve, mats, baseOpacity: st.opacity, alpha: 1, targetAlpha: 1, particleStart: start, particleCount: got, speed: st.speed, reverseHalf: edge.dir === 'both', burst: !!st.burst, kind, tOffset: (seed % 97) / 97 };
    this.edges.set(edge.id!, obj);
    return obj;
  }

  remove(id: string) {
    const o = this.edges.get(id); if (!o) return;
    this.group.remove(o.group);
    o.group.traverse(c => { const m = c as THREE.Mesh; if (m.geometry) m.geometry.dispose(); });
    // park particles far away
    for (let i = o.particleStart; i < o.particleStart + o.particleCount; i++) this.pPositions.set([0, -999, 0], i * 3);
    if (o.particleCount > 0) this.free.push({ start: o.particleStart, count: o.particleCount });
    this.edges.delete(id);
  }

  setFilter(kind: EdgeKind, on: boolean) { if (on) this.filters.add(kind); else this.filters.delete(kind); }

  update(dt: number) {
    this.time += dt;
    const far = new THREE.Vector3(0, -999, 0);
    for (const o of this.edges.values()) {
      const filtered = this.filters.has(o.kind);
      const ta = filtered ? o.targetAlpha : 0.03;
      o.alpha += (ta - o.alpha) * Math.min(1, dt * 5);
      o.group.visible = o.alpha > 0.02;
      o.mats.forEach(m => { m.opacity = o.baseOpacity * o.alpha * (o.alpha > 0.9 ? 1.25 : 1); });
      const n = o.particleCount; if (!n) continue;
      const active = o.alpha > 0.35 && filtered;
      for (let i = 0; i < n; i++) {
        const idx = o.particleStart + i;
        if (!active) { this.pPositions.set([far.x, far.y, far.z], idx * 3); continue; }
        let t = (this.time * o.speed * (o.alpha > 0.9 ? 1.6 : 1) + i / n + o.tOffset) % 1;
        if (o.burst) { const phase = (this.time * 0.5 + o.tOffset) % 1; if (phase > 0.45) { this.pPositions.set([far.x, far.y, far.z], idx * 3); continue; } }
        if (o.reverseHalf && i % 2) t = 1 - t;
        const p = o.curve.getPoint(t);
        this.pPositions.set([p.x, p.y, p.z], idx * 3);
      }
    }
    this.pGeo.setDrawRange(0, this.pUsed);
    (this.pGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.pGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }
}
