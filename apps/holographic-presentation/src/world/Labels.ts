import * as THREE from 'three';

/** Camera-facing 3D text labels rendered to canvas sprites (crisp at 1080p, fade with distance). */
export interface LabelOptions { title: string; sub?: string; color?: string; accent?: string; scale?: number; width?: number }

export function makeLabel(o: LabelOptions): THREE.Sprite {
  const dpr = 2;
  const w = o.width ?? 512, h = o.sub ? 148 : 96;
  const c = document.createElement('canvas'); c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext('2d')!; g.scale(dpr, dpr);
  const accent = o.accent ?? '#38d9ff';
  // pill background
  g.fillStyle = 'rgba(4,10,22,0.66)';
  roundRect(g, 4, 4, w - 8, h - 8, 14); g.fill();
  g.strokeStyle = accent; g.globalAlpha = 0.55; g.lineWidth = 2; roundRect(g, 4, 4, w - 8, h - 8, 14); g.stroke(); g.globalAlpha = 1;
  g.fillStyle = accent; g.fillRect(4, 4, 6, h - 8);
  g.fillStyle = o.color ?? '#eaf6ff'; g.font = '700 40px "Segoe UI", Inter, Arial, sans-serif'; g.textBaseline = 'middle';
  g.fillText(fit(g, o.title, w - 40), 24, o.sub ? 46 : h / 2);
  if (o.sub) { g.fillStyle = '#9fd8e8'; g.font = '500 26px "Segoe UI", Inter, Arial, sans-serif'; g.fillText(fit(g, o.sub, w - 40), 24, 104); }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false });
  const s = new THREE.Sprite(mat);
  const sc = o.scale ?? 1;
  s.scale.set((w / 128) * sc, (h / 128) * sc, 1);
  s.renderOrder = 20;
  return s;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function fit(g: CanvasRenderingContext2D, t: string, max: number) {
  if (g.measureText(t).width <= max) return t;
  while (t.length > 3 && g.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}
