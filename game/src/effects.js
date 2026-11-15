// effects.js — pooled, zero hot-loop allocation. 24 tracers, 16 impact
// bursts of 10 particles, one explosion sphere + light. Everything is
// created once and reused; step() only moves numbers around.
// The scene is optional: with no scene the pools still step without
// throwing, which is how the Node logic tests exercise this module.

import * as THREE from 'three';

const TRACERS = 24;
const BURSTS = 16;
const PARTICLES = 10;

export function createEffects(scene) {
  const fx = {
    scene: scene || null,
    tracers: [],
    bursts: [],
    explosion: null,
    explosionLight: null,
    explosionT: 0,

    init() {
      if (!this.scene) return;
      const tracerGeo = new THREE.BoxGeometry(0.02, 0.02, 1);
      const tracerMat = new THREE.MeshBasicMaterial({ color: 0xffd27a });
      for (let i = 0; i < TRACERS; i++) {
        const mesh = new THREE.Mesh(tracerGeo, tracerMat);
        mesh.visible = false;
        this.scene.add(mesh);
        this.tracers.push({ mesh, life: 0 });
      }
      const pGeo = new THREE.BoxGeometry(0.07, 0.07, 0.07);
      for (let i = 0; i < BURSTS; i++) {
        const parts = [];
        for (let j = 0; j < PARTICLES; j++) {
          const mesh = new THREE.Mesh(
            pGeo,
            new THREE.MeshBasicMaterial({ color: 0xffc46b }),
          );
          mesh.visible = false;
          this.scene.add(mesh);
          parts.push({ mesh, vx: 0, vy: 0, vz: 0, life: 0 });
        }
        this.bursts.push({ parts, life: 0 });
      }
      this.explosion = new THREE.Mesh(
        new THREE.SphereGeometry(1, 20, 14),
        new THREE.MeshBasicMaterial({
          color: 0xff9a3c, transparent: true, opacity: 0,
        }),
      );
      this.explosion.visible = false;
      this.scene.add(this.explosion);
      this.explosionLight = new THREE.PointLight(0xff8a2e, 0, 18, 1.5);
      this.scene.add(this.explosionLight);
    },

    tracer(from, to) {
      if (!this.scene) return;
      const slot = this.tracers.find((t) => t.life <= 0);
      if (!slot) return;
      const len = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
      if (len < 0.1) return;
      slot.mesh.position.set(
        (from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2,
      );
      slot.mesh.lookAt(to.x, to.y, to.z);
      slot.mesh.scale.set(1, 1, len);
      slot.mesh.visible = true;
      slot.life = 0.07;
    },

    impact(pos) {
      if (!this.scene) return;
      const burst = this.bursts.find((b) => b.life <= 0);
      if (!burst) return;
      burst.life = 0.4;
      for (const p of burst.parts) {
        p.mesh.position.set(pos.x, pos.y, pos.z);
        p.mesh.visible = true;
        const a = Math.random() * Math.PI * 2;
        const up = Math.random() * 2.5 + 1;
        const sp = Math.random() * 2.5 + 1;
        p.vx = Math.cos(a) * sp;
        p.vy = up;
        p.vz = Math.sin(a) * sp;
        p.life = 0.4;
      }
    },

    explosionAt(pos) {
      if (!this.scene) return;
      this.explosion.position.set(pos.x, pos.y, pos.z);
      this.explosion.visible = true;
      this.explosion.scale.setScalar(0.3);
      this.explosion.material.opacity = 0.95;
      this.explosionLight.position.set(pos.x, pos.y + 1, pos.z);
      this.explosionLight.intensity = 90;
      this.explosionT = 0.6;
    },

    step(dt) {
      for (const t of this.tracers) {
        if (t.life <= 0) continue;
        t.life -= dt;
        if (t.life <= 0) t.mesh.visible = false;
      }
      for (const b of this.bursts) {
        if (b.life <= 0) continue;
        b.life -= dt;
        for (const p of b.parts) {
          if (p.life <= 0) continue;
          p.life -= dt;
          if (p.life <= 0) {
            p.mesh.visible = false;
            continue;
          }
          p.vy -= 12 * dt;
          p.mesh.position.x += p.vx * dt;
          p.mesh.position.y += p.vy * dt;
          p.mesh.position.z += p.vz * dt;
        }
      }
      if (this.explosionT > 0) {
        this.explosionT -= dt;
        const k = Math.max(0, this.explosionT / 0.6);
        this.explosion.scale.setScalar(0.3 + (1 - k) * 5.5);
        this.explosion.material.opacity = 0.95 * k;
        this.explosionLight.intensity = 90 * k;
        if (this.explosionT <= 0) {
          this.explosion.visible = false;
          this.explosionLight.intensity = 0;
        }
      }
    },
  };
  fx.init();
  return fx;
}
