import * as THREE from 'three';
import type { WorldNode, Zone } from '../data/graph/types';

export const ZONE_COLOR: Record<Zone, string> = {
  core: '#38d9ff', governance: '#5aa9ff', revenue: '#3b8bff', delivery: '#ff7a59',
  people: '#f0c24a', finance: '#f5b400', intelligence: '#22e3c8', external: '#59c1ff',
};

export interface NodeObject {
  id: string;
  group: THREE.Group;
  hit: THREE.Mesh;
  color: THREE.Color;
  radius: number;                 // visual radius for edge socket offset
  parts: THREE.Object3D[];        // animated parts
  mats: THREE.Material[];         // all materials (for alpha)
  baseOpacity: number[];
  alpha: number; targetAlpha: number;
  scale: number; targetScale: number;
  hover: boolean; selected: boolean;
}

const glass = (color: THREE.Color, opacity = 0.16) => new THREE.MeshPhysicalMaterial({
  color, transparent: true, opacity, roughness: 0.15, metalness: 0.1, transmission: 0.0,
  emissive: color, emissiveIntensity: 0.25, depthWrite: false, side: THREE.DoubleSide,
});
const wire = (color: THREE.Color, opacity = 0.75) => new THREE.LineBasicMaterial({ color, transparent: true, opacity });
const glow = (color: THREE.Color, opacity = 0.9) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, toneMapped: false });
const ringMat = (color: THREE.Color, opacity = 0.8) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, toneMapped: false });

function edges(geo: THREE.BufferGeometry, m: THREE.Material) { return new THREE.LineSegments(new THREE.EdgesGeometry(geo, 12), m); }

export function buildNode(n: WorldNode): NodeObject {
  const color = new THREE.Color(n.kind === 'finance_engine' ? '#f5b400' : n.kind === 'sub' ? ZONE_COLOR[n.zone] : ZONE_COLOR[n.zone]);
  const g = new THREE.Group(); g.name = n.id;
  const parts: THREE.Object3D[] = []; const mats: THREE.Material[] = [];
  let radius = 1.3;
  const add = (o: THREE.Object3D, animated = false) => { g.add(o); if (animated) parts.push(o); const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined; if (m) (Array.isArray(m) ? m : [m]).forEach(mm => mats.push(mm)); return o; };

  switch (n.kind) {
    case 'ai_core': {
      radius = 2.6;
      add(new THREE.Mesh(new THREE.IcosahedronGeometry(1.35, 3), new THREE.MeshPhysicalMaterial({ color: 0x0b2a3a, emissive: 0x2fd8ff, emissiveIntensity: 0.85, roughness: 0.25, metalness: 0.2 })), true);
      add(new THREE.Mesh(new THREE.IcosahedronGeometry(1.75, 1), glass(color, 0.12)), true);
      add(edges(new THREE.IcosahedronGeometry(2.05, 1), wire(color, 0.7)), true);
      const r1 = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.045, 10, 128), ringMat(color, 0.95)); r1.rotation.x = Math.PI / 2; add(r1, true);
      const r2 = new THREE.Mesh(new THREE.TorusGeometry(3.05, 0.03, 10, 128), ringMat(new THREE.Color('#a78bfa'), 0.8)); r2.rotation.x = Math.PI / 3; r2.rotation.y = 0.4; add(r2, true);
      const r3 = new THREE.Mesh(new THREE.TorusGeometry(3.5, 0.025, 10, 128), ringMat(new THREE.Color('#22e3c8'), 0.7)); r3.rotation.x = -Math.PI / 3; r3.rotation.z = 0.7; add(r3, true);
      // security shield layer
      add(new THREE.Mesh(new THREE.SphereGeometry(3.9, 32, 24), new THREE.MeshBasicMaterial({ color: 0xff9f43, transparent: true, opacity: 0.045, wireframe: true })), true);
      // inner point cloud (knowledge)
      const np = 420, pos = new Float32Array(np * 3);
      for (let i = 0; i < np; i++) { const v = new THREE.Vector3().randomDirection().multiplyScalar(1.4 + Math.random() * 0.6); pos.set([v.x, v.y, v.z], i * 3); }
      const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      add(new THREE.Points(pg, new THREE.PointsMaterial({ color: 0xbfefff, size: 0.05, transparent: true, opacity: 0.9, depthWrite: false })), true);
      break;
    }
    case 'finance_engine': {
      radius = 1.9;
      const body = new THREE.Mesh(new THREE.CylinderGeometry(1.55, 1.55, 1.7, 6, 1), glass(color, 0.2)); add(body);
      add(edges(new THREE.CylinderGeometry(1.55, 1.55, 1.7, 6, 1), wire(color, 0.95)));
      add(edges(new THREE.CylinderGeometry(1.95, 1.95, 0.25, 6, 1), wire(color, 0.5)), true);
      const r = new THREE.Mesh(new THREE.TorusGeometry(2.3, 0.05, 8, 96), ringMat(color, 0.9)); r.rotation.x = Math.PI / 2; add(r, true);
      // ledger bars
      for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; const b = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.5 + (i % 3) * 0.3, 0.16), glow(color, 0.85)); b.position.set(Math.cos(a) * 0.95, -0.4 + b.geometry.parameters.height / 2, Math.sin(a) * 0.95); add(b); }
      add(new THREE.Mesh(new THREE.SphereGeometry(0.4, 16, 12), glow(color, 1)), true);
      break;
    }
    case 'control': {
      radius = 1.45;
      const plate = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.35, 0.22, 6, 1), glass(color, 0.2)); add(plate);
      add(edges(new THREE.CylinderGeometry(1.35, 1.35, 0.22, 6, 1), wire(color, 0.95)));
      const r = new THREE.Mesh(new THREE.TorusGeometry(1.7, 0.035, 8, 80), ringMat(color, 0.75)); r.rotation.x = Math.PI / 2; add(r, true);
      add(edges(new THREE.OctahedronGeometry(0.75, 0), wire(color, 0.9)), true);
      add(new THREE.Mesh(new THREE.SphereGeometry(0.28, 14, 10), glow(color, 1)), true);
      break;
    }
    case 'channel': {
      radius = 1.5;
      const r = new THREE.Mesh(new THREE.TorusGeometry(1.3, 0.09, 12, 96), ringMat(color, 0.95)); add(r);
      add(new THREE.Mesh(new THREE.CircleGeometry(1.15, 48), glass(color, 0.22)));
      const r2 = new THREE.Mesh(new THREE.TorusGeometry(1.75, 0.03, 8, 96), ringMat(color, 0.6)); add(r2, true);
      add(edges(new THREE.ConeGeometry(0.55, 0.9, 4), wire(color, 0.95)), true);
      break;
    }
    case 'external': {
      radius = 1.5;
      add(edges(new THREE.DodecahedronGeometry(1.35, 0), wire(new THREE.Color('#a78bfa'), 0.9)), true);
      add(new THREE.Mesh(new THREE.DodecahedronGeometry(1.35, 0), glass(new THREE.Color('#a78bfa'), 0.1)));
      add(new THREE.Mesh(new THREE.SphereGeometry(0.45, 16, 12), glow(new THREE.Color('#c4b5fd'), 0.95)), true);
      color.set('#a78bfa');
      break;
    }
    case 'sub': {
      radius = 0.62;
      add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 1), glass(color, 0.28)));
      add(edges(new THREE.IcosahedronGeometry(0.46, 1), wire(color, 0.9)), true);
      const r = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.02, 6, 48), ringMat(color, 0.7)); r.rotation.x = Math.PI / 2; add(r, true);
      add(new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), glow(color, 1)), true);
      break;
    }
    default: { // module — layered glass block with zone silhouette
      radius = 1.55;
      const box = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.5, 2.2), glass(color, 0.14)); add(box);
      add(edges(new THREE.BoxGeometry(2.2, 1.5, 2.2), wire(color, 0.9)));
      const cap = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.08, 2.5), glow(color, 0.55)); cap.position.y = 0.85; add(cap);
      const r = new THREE.Mesh(new THREE.TorusGeometry(1.75, 0.03, 8, 80), ringMat(color, 0.65)); r.rotation.x = Math.PI / 2; add(r, true);
      const inner = n.zone === 'revenue' ? new THREE.OctahedronGeometry(0.55, 0)
        : n.zone === 'delivery' ? new THREE.CylinderGeometry(0.42, 0.42, 0.9, 6)
        : n.zone === 'people' ? new THREE.CapsuleGeometry(0.3, 0.5, 4, 10)
        : n.zone === 'intelligence' ? new THREE.TorusKnotGeometry(0.34, 0.1, 64, 8)
        : new THREE.TetrahedronGeometry(0.6, 0);
      add(edges(inner, wire(color, 0.95)), true);
      add(new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), glow(color, 1)), true);
      break;
    }
  }
  const hit = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.05, 12, 10), new THREE.MeshBasicMaterial({ visible: false }));
  hit.userData.nodeId = n.id; g.add(hit);
  const baseOpacity = mats.map(m => (m as THREE.Material & { opacity: number }).opacity ?? 1);
  return { id: n.id, group: g, hit, color, radius, parts, mats, baseOpacity, alpha: 1, targetAlpha: 1, scale: 1, targetScale: 1, hover: false, selected: false };
}

export function animateNode(o: NodeObject, dt: number, t: number) {
  o.alpha += (o.targetAlpha - o.alpha) * Math.min(1, dt * 5);
  o.scale += (o.targetScale - o.scale) * Math.min(1, dt * 6);
  const hoverBoost = o.hover ? 1.12 : 1; const sel = o.selected ? 1.08 : 1;
  o.group.scale.setScalar(o.scale * hoverBoost * sel);
  o.parts.forEach((p, i) => {
    const s = 0.25 + (i % 3) * 0.18;
    p.rotation.y += dt * s * (i % 2 ? 1 : -1);
    if (i % 4 === 1) p.rotation.x += dt * s * 0.6;
  });
  const pulse = 1 + Math.sin(t * 2.2 + o.group.position.x) * 0.04;
  const last = o.parts[o.parts.length - 1]; if (last) last.scale.setScalar(pulse);
  const boost = (o.hover || o.selected) ? 1.35 : 1;
  o.mats.forEach((m, i) => { const mm = m as THREE.Material & { opacity: number }; mm.opacity = Math.min(1, o.baseOpacity[i] * o.alpha * boost); });
}
