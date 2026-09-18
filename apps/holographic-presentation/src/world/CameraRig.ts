import * as THREE from 'three';

/**
 * CameraRig — a single spherical orbit controller with damping, inertia and cinematic fly-to.
 * Mouse, keyboard and hand gestures all call the same rotate / dolly / pan / flyTo API,
 * so every input device manipulates the SAME world camera.
 */
export interface CameraGoal { target: THREE.Vector3; radius: number; theta?: number; phi?: number }

export class CameraRig {
  camera: THREE.PerspectiveCamera;
  target = new THREE.Vector3(0, 0.6, 0);
  radius = 34;
  theta = 0.0;              // azimuth
  phi = 1.18;               // polar (0 = top)
  private vTheta = 0; private vPhi = 0; private vDolly = 0;
  private vPan = new THREE.Vector3();
  private goal: CameraGoal | null = null;
  private goalT = 0; private goalDur = 1.4;
  private from: CameraGoal | null = null;
  readonly home: CameraGoal = { target: new THREE.Vector3(0, 0.6, 0), radius: 34, theta: 0.0, phi: 1.18 };
  minRadius = 4.5; maxRadius = 60;
  damping = 6.5;

  constructor(camera: THREE.PerspectiveCamera) { this.camera = camera; this.apply(); }

  rotate(dTheta: number, dPhi: number) { this.vTheta += dTheta; this.vPhi += dPhi; this.goal = null; }
  dolly(factor: number) { this.vDolly += Math.log(factor); this.goal = null; }
  pan(dx: number, dy: number) {
    const right = new THREE.Vector3(); const up = new THREE.Vector3(0, 1, 0);
    right.setFromMatrixColumn(this.camera.matrix, 0);
    this.vPan.addScaledVector(right, dx * this.radius * 0.0018).addScaledVector(up, dy * this.radius * 0.0018);
    this.goal = null;
  }

  flyTo(goal: CameraGoal, duration = 1.4) {
    this.from = { target: this.target.clone(), radius: this.radius, theta: this.theta, phi: this.phi };
    this.goal = { target: goal.target.clone(), radius: goal.radius, theta: goal.theta ?? this.theta, phi: goal.phi ?? this.phi };
    // shortest angular path
    let d = this.goal.theta! - this.theta; d = Math.atan2(Math.sin(d), Math.cos(d)); this.goal.theta = this.theta + d;
    this.goalT = 0; this.goalDur = duration;
    this.vTheta = this.vPhi = this.vDolly = 0; this.vPan.set(0, 0, 0);
  }
  reset(duration = 1.6) { this.flyTo({ ...this.home, target: this.home.target.clone() }, duration); }

  /** Frame a node: keep current azimuth but look slightly from above. */
  focus(point: THREE.Vector3, radius = 11, duration = 1.3) {
    const theta = Math.atan2(point.x, point.z + 22); // bias azimuth toward the node side
    this.flyTo({ target: point.clone(), radius, theta: this.theta * 0.6 + theta * 0.4, phi: 1.22 }, duration);
  }

  update(dt: number) {
    const k = Math.min(1, dt * this.damping);
    if (this.goal && this.from) {
      this.goalT = Math.min(1, this.goalT + dt / this.goalDur);
      const e = this.goalT < 0.5 ? 4 * this.goalT ** 3 : 1 - Math.pow(-2 * this.goalT + 2, 3) / 2; // easeInOutCubic
      this.target.lerpVectors(this.from.target, this.goal.target, e);
      this.radius = THREE.MathUtils.lerp(this.from.radius, this.goal.radius, e);
      this.theta = THREE.MathUtils.lerp(this.from.theta!, this.goal.theta!, e);
      this.phi = THREE.MathUtils.lerp(this.from.phi!, this.goal.phi!, e);
      if (this.goalT >= 1) { this.goal = null; this.from = null; }
    } else {
      this.theta += this.vTheta * k * 1.0;
      this.phi += this.vPhi * k * 1.0;
      this.radius *= Math.exp(this.vDolly * k);
      this.target.addScaledVector(this.vPan, k);
      this.vTheta *= 1 - k; this.vPhi *= 1 - k; this.vDolly *= 1 - k; this.vPan.multiplyScalar(1 - k);
    }
    this.phi = THREE.MathUtils.clamp(this.phi, 0.25, 1.62);
    this.radius = THREE.MathUtils.clamp(this.radius, this.minRadius, this.maxRadius);
    this.apply();
  }

  private apply() {
    const sp = Math.sin(this.phi);
    this.camera.position.set(
      this.target.x + this.radius * sp * Math.sin(this.theta),
      this.target.y + this.radius * Math.cos(this.phi),
      this.target.z + this.radius * sp * Math.cos(this.theta),
    );
    this.camera.lookAt(this.target);
  }
}
