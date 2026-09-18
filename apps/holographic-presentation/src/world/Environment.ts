import * as THREE from 'three';
import { makeLabel } from './Labels';

/**
 * Cinematic dark control-room: floor grid, dust, and large curved wall screens showing the
 * AL-BERUNIY architectural render behind the holographic network (never in front of it).
 */
export class Environment {
  group = new THREE.Group();
  private screens: THREE.Mesh[] = [];
  private dust: THREE.Points | null = null;
  private t = 0;

  constructor(scene: THREE.Scene, safe: boolean) {
    scene.background = new THREE.Color(0x03060d);
    scene.fog = new THREE.FogExp2(0x03060d, 0.0105);

    // lights
    scene.add(new THREE.AmbientLight(0x6fa6d8, 0.35));
    const hemi = new THREE.HemisphereLight(0x3a7bd5, 0x02040a, 0.55); scene.add(hemi);
    const core = new THREE.PointLight(0x38d9ff, 2.2, 60, 1.6); core.position.set(0, 1, 0); scene.add(core);
    const gold = new THREE.PointLight(0xf5b400, 0.9, 40, 1.8); gold.position.set(0, -3, 9); scene.add(gold);

    // floor — radial glow disc + grid
    const disc = new THREE.Mesh(new THREE.CircleGeometry(60, 96), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { c1: { value: new THREE.Color(0x0a2a4a) } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader: 'uniform vec3 c1; varying vec2 vUv; void main(){ float d=distance(vUv,vec2(0.5)); float a=smoothstep(0.5,0.05,d)*0.55; gl_FragColor=vec4(c1,a);}',
    }));
    disc.rotation.x = -Math.PI / 2; disc.position.y = -9; this.group.add(disc);
    const grid = new THREE.GridHelper(120, 60, 0x1e6f8c, 0x0d2f45);
    (grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = 0.32;
    grid.position.y = -8.98; this.group.add(grid);
    for (const r of [12, 22, 32]) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(r - 0.06, r + 0.06, 128), new THREE.MeshBasicMaterial({ color: 0x38d9ff, transparent: true, opacity: 0.16, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = -8.96; this.group.add(ring);
    }

    // wall screens — arc behind the world
    const loader = new THREE.TextureLoader();
    const specs = [
      { a: -0.62, w: 26, h: 11, off: 0.0 }, { a: -0.31, w: 26, h: 11, off: 0.25 },
      { a: 0.0, w: 30, h: 12.5, off: 0.5 }, { a: 0.31, w: 26, h: 11, off: 0.75 }, { a: 0.62, w: 26, h: 11, off: 1.0 },
    ];
    const R = 52;
    specs.forEach((s, i) => {
      const geo = new THREE.PlaneGeometry(s.w, s.h);
      const mat = new THREE.MeshBasicMaterial({ color: 0x9fd0ff, transparent: true, opacity: 0.0, depthWrite: false, toneMapped: false });
      const m = new THREE.Mesh(geo, mat);
      m.position.set(Math.sin(s.a) * R, 9 + (i === 2 ? 1.2 : 0), -Math.cos(s.a) * R);
      m.lookAt(0, 8, 0);
      this.group.add(m); this.screens.push(m);
      // frame
      const frame = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x38d9ff, transparent: true, opacity: 0.35 }));
      frame.position.copy(m.position); frame.quaternion.copy(m.quaternion); this.group.add(frame);
      const bar = new THREE.Mesh(new THREE.PlaneGeometry(s.w, 0.35), new THREE.MeshBasicMaterial({ color: 0x38d9ff, transparent: true, opacity: 0.5 }));
      bar.position.copy(m.position).add(new THREE.Vector3(0, s.h / 2 + 0.3, 0)); bar.quaternion.copy(m.quaternion); this.group.add(bar);
    });
    loader.load('/assets/al-beruniy-background.jpg',
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        this.screens.forEach((m, i) => {
          const t = tex.clone(); t.needsUpdate = true;
          const s = specs[i]; const aspect = s.w / s.h; const imgAspect = 2.5;
          const rep = aspect / imgAspect; // fraction of image width shown
          t.repeat.set(rep, 1); t.offset.set((1 - rep) * s.off, 0); t.wrapS = THREE.ClampToEdgeWrapping;
          const mat = m.material as THREE.MeshBasicMaterial; mat.map = t; mat.opacity = 0.46; mat.needsUpdate = true;
        });
      },
      undefined,
      () => { // asset missing → procedural skyline placeholder keeps composition
        this.screens.forEach(m => { const mat = m.material as THREE.MeshBasicMaterial; mat.map = skylineTexture(); mat.opacity = 0.5; mat.needsUpdate = true; });
      });

    // headline on the centre screen
    const title = makeLabel({ title: 'AL-BERUNIY OPERATING SYSTEM', sub: 'ONE PLATFORM · ONE INTELLIGENT WHOLE', accent: '#38d9ff', scale: 2.4, width: 900 });
    title.position.set(0, 18.4, -R + 2); this.group.add(title);
    const l = makeLabel({ title: 'AL-BERUNIY DEVELOPMENTS', sub: 'PEOPLE · PROJECTS · PROGRESS', accent: '#f5b400', scale: 1.5, width: 640 });
    l.position.set(Math.sin(-0.62) * R + 1, 16.2, -Math.cos(-0.62) * R + 2); this.group.add(l);
    const r2 = makeLabel({ title: 'REAL ESTATE · REAL GROWTH', sub: 'REAL IMPACT', accent: '#f5b400', scale: 1.5, width: 640 });
    r2.position.set(Math.sin(0.62) * R - 1, 16.2, -Math.cos(0.62) * R + 2); this.group.add(r2);

    // dust
    if (!safe) {
      const n = 1400; const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { pos[i * 3] = (Math.random() - 0.5) * 90; pos[i * 3 + 1] = Math.random() * 30 - 9; pos[i * 3 + 2] = (Math.random() - 0.5) * 90; }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.dust = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x7fd8ff, size: 0.09, transparent: true, opacity: 0.35, depthWrite: false }));
      this.group.add(this.dust);
    }
    scene.add(this.group);
  }

  update(dt: number) {
    this.t += dt;
    if (this.dust) this.dust.rotation.y += dt * 0.01;
  }
}

function skylineTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 410; const g = c.getContext('2d')!;
  const grd = g.createLinearGradient(0, 0, 0, 410); grd.addColorStop(0, '#0b3a6b'); grd.addColorStop(0.6, '#1d5a92'); grd.addColorStop(1, '#0a1a2c');
  g.fillStyle = grd; g.fillRect(0, 0, 1024, 410);
  g.fillStyle = '#0a1626';
  let x = 0; while (x < 1024) { const w = 40 + Math.random() * 90, h = 120 + Math.random() * 220; g.fillRect(x, 410 - h, w, h); x += w + 12; }
  g.fillStyle = 'rgba(245,180,0,0.5)'; g.font = 'bold 40px Segoe UI'; g.fillText('AL-BERUNIY DEVELOPMENTS — drop assets/al-beruniy-background.jpg', 30, 60);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
