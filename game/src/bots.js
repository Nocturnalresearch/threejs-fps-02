// bots.js — the nine bots. One seeded RNG drives them all, so a round is
// reproducible from its seed. Think tick 10 Hz, movement every fixed step.
//
// States: route -> hold -> engage -> investigate -> plant / defuse ->
// rotate. A bot sees 42 m inside a ~55 degree half-angle cone with a real
// line-of-sight raycast, reacts 0.35-0.7 s after first sighting, and shoots
// in bursts of 3-5 at 0.11 s with a 0.5-1.0 s pause. Getting shot snaps its
// attention to the shooter. Gunshots within 30 m (explosions 45 m) pull the
// nearest two bots of the hearing team to investigate.
//
// Shooting is an angular error on a ray plus a ray-sphere test against the
// target's chest (r 0.42) and head (r 0.2); the same ray stops at walls and
// at other bots, so bots cannot shoot through cover or teammates.

import * as THREE from 'three';
import {
  WAYPOINTS, SPAWNS, HOLD_WPS, findPath, nearestWaypoint,
  hasLineOfSight,
} from './map.js';
import { siteAt } from './bomb.js';

export const BOT_NAMES = {
  ember: ['Vex', 'Rook', 'Iris', 'Moth'],
  slate: ['Ash', 'Brine', 'Cinder', 'Flint', 'Gale'],
};

export const BOT = {
  hp: 100,
  visionRange: 42,
  visionHalfAngle: 0.96, // ~55 degrees
  eyeHeight: 1.55,
  reactionMin: 0.35,
  reactionMax: 0.7,
  burstMin: 3,
  burstMax: 5,
  shotInterval: 0.11,
  pauseMin: 0.5,
  pauseMax: 1.0,
  hitBase: 0.46,
  hitPerMetre: 0.008,
  hitMin: 0.06,
  hitMax: 0.6,
  damage: 26,
  headMult: 4,
  walkSpeed: 4.6,
  hearShot: 30,
  hearBoom: 45,
};

const CHEST_Y = 1.15;
const CHEST_R = 0.42;
const HEAD_Y = 1.62;
const HEAD_R = 0.2;

// Ray-sphere test. Returns the distance along the ray, or Infinity.
function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {  const lx = cx - ox;
  const ly = cy - oy;
  const lz = cz - oz;
  const tca = lx * dx + ly * dy + lz * dz;
  if (tca < 0) return Infinity;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  const r2 = r * r;
  if (d2 > r2) return Infinity;
  return tca - Math.sqrt(r2 - d2);
}

// Nearest bot body hit along a ray (chest or head), excluding one id.
// The direction is normalised here so callers cannot pass a scaled one.
// Walls are checked by the caller through the LOS meshes.
export function rayHitBots(ox, oy, oz, dx, dy, dz, maxDist, bots, excludeId) {
  const len = Math.hypot(dx, dy, dz) || 1;
  dx /= len;
  dy /= len;
  dz /= len;
  let best = null;
  for (const b of bots) {
    if (!b.alive || b.id === excludeId) continue;
    const tc = raySphere(ox, oy, oz, dx, dy, dz, b.x, CHEST_Y, b.z, CHEST_R);
    const th = raySphere(ox, oy, oz, dx, dy, dz, b.x, HEAD_Y, b.z, HEAD_R);
    const t = Math.min(tc, th);
    if (t < maxDist && (!best || t < best.dist)) {
      best = { bot: b, dist: t, part: th <= tc ? 'head' : 'chest' };
    }
  }
  return best;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function angDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function hitProbability(dist, targetSpeed, targetCrouched, botMoving) {
  let p = BOT.hitBase - dist * BOT.hitPerMetre;
  p = clamp(p, BOT.hitMin, BOT.hitMax);
  if (targetSpeed > 3.5) p *= 0.6;
  if (targetCrouched) p *= 1.15;
  if (botMoving) p *= 0.7;
  return clamp(p, 0.02, 0.8);
}

function makeBot(id, team, name, x, z) {
  return {
    id, team, name,
    x, z, y: 0, yaw: team === 'ember' ? 0 : Math.PI,
    hp: BOT.hp, alive: true,
    state: 'route',
    path: [], pathIdx: 0,
    holdWp: -1, holdYaw: 0, holdT: 0,
    target: null, // {kind:'player'} or {kind:'bot', id}
    reactT: 0, burstLeft: 0, shotT: 0, pauseT: 0,
    thinkT: 0, moving: false,
    channelT: 0, deathT: 0, fadeT: 0,
    mesh: null,
  };
}

export function createBotManager(mapData, rng, hooks = {}) {
  const colliders = mapData.colliders;
  const graph = mapData.graph;
  const losMeshes = mapData.losMeshes || [];

  const mgr = {
    bots: [],
    planSite: 'A',

    spawnRound(planSite) {
      this.planSite = planSite;
      this.bots = [];
      // Ember teammates take spawns 1-4 (the player holds spawn 0).
      BOT_NAMES.ember.forEach((name, i) => {
        const [x, z] = SPAWNS.ember[i + 1];
        this.bots.push(makeBot(`ember-${i}`, 'ember', name, x, z));
      });
      BOT_NAMES.slate.forEach((name, i) => {
        const [x, z] = SPAWNS.slate[i];
        this.bots.push(makeBot(`slate-${i}`, 'slate', name, x, z));
      });
      this.assignRoutes(planSite);
      return this.bots;
    },

    assignRoutes(planSite) {
      const other = planSite === 'A' ? 'B' : 'A';
      const ember = this.bots.filter((b) => b.team === 'ember');
      const slate = this.bots.filter((b) => b.team === 'slate');
      const siteWp = { A: 27, B: 28 };
      const laneWp = { A: 22, B: 24 };
      ember.forEach((b, i) => {
        const dest = i < 2 ? siteWp[planSite] : i < 4 ? siteWp[other] : 15;
        b.path = findPath(graph, nearestWaypoint(b.x, b.z), dest);
        b.pathIdx = 0;
        b.state = 'route';
        b.holdWp = dest;
      });
      slate.forEach((b, i) => {
        const dest = i < 2 ? HOLD_WPS.A[i] : i < 4 ? HOLD_WPS.B[i - 2] : HOLD_WPS.mid[0];
        b.path = findPath(graph, nearestWaypoint(b.x, b.z), dest);
        b.pathIdx = 0;
        b.state = 'route';
        b.holdWp = dest;
      });
    },

    aliveOf(team) {
      return this.bots.filter((b) => b.team === team && b.alive);
    },

    botById(id) {
      return this.bots.find((b) => b.id === id) || null;
    },

    // A bot took damage. Snap its attention to the shooter, track the hit.
    damageBot(bot, dmg, head, srcId) {
      if (!bot.alive) return null;
      bot.hp -= dmg;
      if (srcId) {
        const src = srcId === 'player' ? { kind: 'player' } : { kind: 'bot', id: srcId };
        if (bot.target === null || bot.target.kind !== src.kind
          || (src.kind === 'bot' && bot.target.id !== src.id)) {
          bot.target = src;
          bot.reactT = 0; // shot at: no reaction delay
          if (bot.state !== 'plant' && bot.state !== 'defuse') bot.state = 'engage';
        }
      }
      if (bot.hp <= 0) {
        bot.hp = 0;
        bot.alive = false;
        bot.deathT = 0;
        bot.fadeT = 0;
        bot.target = null;
        return { killed: true, head };
      }
      return { killed: false, head };
    },

    // Gunshot / explosion heard: the nearest two alive bots of the team
    // walk over to look. Returns how many were sent.
    hearNoise(x, z, radius, team) {
      const near = this.bots
        .filter((b) => b.team === team && b.alive && b.state !== 'plant' && b.state !== 'defuse')
        .map((b) => ({ b, d: Math.hypot(b.x - x, b.z - z) }))
        .filter((e) => e.d <= radius)
        .sort((a, b) => a.d - b.d)
        .slice(0, 2);
      for (const { b } of near) {
        b.state = 'investigate';
        b.path = findPath(graph, nearestWaypoint(b.x, b.z), nearestWaypoint(x, z));
        b.pathIdx = 0;
        b.holdT = 0;
      }
      return near.length;
    },

    canSee(bot, tx, ty, tz) {
      const dx = tx - bot.x;
      const dz = tz - bot.z;
      const dist = Math.hypot(dx, dz);
      if (dist > BOT.visionRange) return false;
      const want = Math.atan2(-dx, -dz); // yaw 0 faces -Z
      if (Math.abs(angDiff(want, bot.yaw)) > BOT.visionHalfAngle) return false;
      return hasLineOfSight(losMeshes, bot.x, BOT.eyeHeight, bot.z, tx, ty, tz);
    },

    // One bot's shot at its current target. Returns a shot record for the
    // caller (sound / tracer), or null when it did not fire.
    botShoot(bot, view) {
      const target = this.resolveTarget(bot, view);
      if (!target) return null;
      const dist = Math.hypot(target.x - bot.x, target.z - bot.z);
      const p = hitProbability(dist, target.speed || 0, !!target.crouched, bot.moving);
      // Angular error shrinks as the hit chance grows.
      const err = (1 - p) * 0.09;
      const baseYaw = Math.atan2(-(target.x - bot.x), -(target.z - bot.z));
      const basePitch = Math.atan2((target.y || CHEST_Y) - BOT.eyeHeight, dist);
      const yaw = baseYaw + (rng() * 2 - 1) * err;
      const pitch = basePitch + (rng() * 2 - 1) * err * 0.6;
      const dx = -Math.sin(yaw) * Math.cos(pitch);
      const dy = Math.sin(pitch);
      const dz = -Math.cos(yaw) * Math.cos(pitch);
      const wallDist = this.wallDist(bot, dx, dy, dz, dist + 30);
      const hit = rayHitBots(
        bot.x, BOT.eyeHeight, bot.z, dx, dy, dz,
        Math.min(wallDist, dist + 30), this.bots, bot.id,
      );
      // The intended target may be the player (not in this.bots), and the
      // ray stops at the first body it meets — a teammate in the way takes
      // the hit instead of the target behind them.
      let result = { bot, target, hit: false, head: false, dmg: 0, dist, hitBot: null };
      if (target.kind === 'player') {
        const t = raySphere(
          bot.x, BOT.eyeHeight, bot.z, dx, dy, dz,
          target.x, CHEST_Y, target.z, CHEST_R,
        );
        const th = raySphere(
          bot.x, BOT.eyeHeight, bot.z, dx, dy, dz,
          target.x, HEAD_Y, target.z, HEAD_R,
        );
        const best = Math.min(t, th);
        if (best < wallDist && best < dist + 2) {
          const head = th <= t;
          const fall = Math.max(0, 1 - dist / 140);
          result = {
            bot, target, hit: true, head, hitBot: null,
            dmg: BOT.damage * (head ? BOT.headMult : 1) * fall, dist,
          };
        }
      } else if (hit) {
        const head = hit.part === 'head';
        const fall = Math.max(0, 1 - dist / 140);
        result = {
          bot, target, hit: true, head, hitBot: hit.bot,
          dmg: BOT.damage * (head ? BOT.headMult : 1) * fall, dist,
        };
      }
      if (hooks.onShot) hooks.onShot(result);
      return result;
    },

    wallDist(bot, dx, dy, dz, maxDist) {
      if (!losMeshes.length) return maxDist;
      const ray = new THREE.Raycaster(
        new THREE.Vector3(bot.x, BOT.eyeHeight, bot.z),
        new THREE.Vector3(dx, dy, dz),
      );
      ray.far = maxDist;
      const hits = ray.intersectObjects(losMeshes, false);
      return hits.length > 0 ? hits[0].distance : maxDist;
    },

    resolveTarget(bot, view) {
      if (!bot.target) return null;
      if (bot.target.kind === 'player') {
        const p = view.player;
        if (!p || !p.alive) return null;
        return {
          kind: 'player', x: p.x, z: p.z, y: p.crouched ? 1.02 : CHEST_Y,
          speed: p.speed || 0, crouched: !!p.crouched,
        };
      }
      const b = this.botById(bot.target.id);
      if (!b || !b.alive) return null;
      return { kind: 'bot', id: b.id, x: b.x, z: b.z, y: CHEST_Y, speed: b.moving ? 4 : 0 };
    },

    // Visible enemies, nearest first. Player first if visible at all.
    scan(bot, view) {
      const found = [];
      const p = view.player;
      if (p && p.alive) {
        const eyeY = p.crouched ? 1.02 : 1.6;
        if (this.canSee(bot, p.x, eyeY, p.z)) {
          found.push({ kind: 'player', dist: Math.hypot(p.x - bot.x, p.z - bot.z) });
        }
      }
      for (const other of this.bots) {
        if (!other.alive || other.team === bot.team) continue;
        if (this.canSee(bot, other.x, CHEST_Y, other.z)) {
          found.push({
            kind: 'bot', id: other.id,
            dist: Math.hypot(other.x - bot.x, other.z - bot.z),
          });
        }
      }
      found.sort((a, b) => a.dist - b.dist);
      return found;
    },

    // Walk toward the current path node, with circle-vs-AABB collision.
    moveAlongPath(bot, dt) {
      if (bot.pathIdx >= bot.path.length) {
        bot.moving = false;
        return true;
      }
      const [wx, wz] = WAYPOINTS[bot.path[bot.pathIdx]];
      const dx = wx - bot.x;
      const dz = wz - bot.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.35) {
        bot.pathIdx += 1;
        return bot.pathIdx >= bot.path.length;
      }
      const step = Math.min(d, BOT.walkSpeed * dt);
      const mx = (dx / d) * step;
      const mz = (dz / d) * step;
      bot.moving = true;
      bot.yaw = Math.atan2(-(dx), -(dz));
      this.tryMove(bot, mx, mz);
      return false;
    },

    tryMove(bot, mx, mz) {
      const r = 0.34;
      const blocked = (x, z) => {
        for (const c of colliders) {
          if (c.y1 <= 0.34 || c.y0 >= 1.72) continue;
          if (x + r > c.x0 && x - r < c.x1 && z + r > c.z0 && z - r < c.z1) return true;
        }
        return false;
      };
      if (!blocked(bot.x + mx, bot.z + mz)) {
        bot.x += mx;
        bot.z += mz;
      } else if (!blocked(bot.x + mx, bot.z)) {
        bot.x += mx;
      } else if (!blocked(bot.x, bot.z + mz)) {
        bot.z += mz;
      } else {
        bot.moving = false;
      }
    },

    update(dt, view) {
      for (const bot of this.bots) {
        if (!bot.alive) {
          bot.deathT += dt;
          bot.fadeT += dt;
          continue;
        }
        bot.thinkT -= dt;
        if (bot.thinkT <= 0) {
          bot.thinkT = 0.1; // think tick 10 Hz
          this.think(bot, view);
        }
        this.act(bot, dt, view);
      }
    },

    think(bot, view) {
      const bomb = view.bomb;
      // The carrier plants: the transition tests the REAL bomb state —
      // carried by this bot — never a phase value.
      if (bomb && bomb.state === 'carried' && bomb.carrier === bot.id) {
        const site = siteAt(bot.x, bot.z);
        if (site) {
          bot.state = 'plant';
          bot.channelT = 0;
          return;
        }
        if (bot.state !== 'route') {
          bot.state = 'route';
          bot.path = findPath(graph, nearestWaypoint(bot.x, bot.z),
            this.planSite === 'A' ? 27 : 28);
          bot.pathIdx = 0;
        }
        return;
      }
      // A planted bomb pulls defenders in to defuse.
      if (bomb && bomb.state === 'planted' && bot.team === 'slate') {
        if (bot.state !== 'defuse' && bot.state !== 'rotate') {
          bot.state = 'rotate';
          bot.path = findPath(graph, nearestWaypoint(bot.x, bot.z),
            bomb.site === 'A' ? 27 : 28);
          bot.pathIdx = 0;
        }
        return;
      }
      // Vision: nearest visible enemy becomes the target.
      const seen = this.scan(bot, view);
      if (seen.length > 0) {
        const first = seen[0];
        if (!bot.target
          || bot.target.kind !== first.kind
          || (first.kind === 'bot' && bot.target.id !== first.id)) {
          bot.target = first.kind === 'player'
            ? { kind: 'player' }
            : { kind: 'bot', id: first.id };
          bot.reactT = BOT.reactionMin + rng() * (BOT.reactionMax - BOT.reactionMin);
          bot.burstLeft = 0;
          bot.pauseT = 0;
        }
        if (bot.state !== 'plant' && bot.state !== 'defuse') bot.state = 'engage';
        return;
      }
      // Lost sight: drop the target, go back to the job.
      if (bot.state === 'engage') {
        bot.target = null;
        bot.burstLeft = 0;
        bot.state = bot.holdWp >= 0 ? 'hold' : 'route';
        if (bot.state === 'route' && bot.pathIdx >= bot.path.length) {
          bot.state = 'hold';
        }
      }
    },

    act(bot, dt, view) {
      const bomb = view.bomb;
      switch (bot.state) {
        case 'route': {
          const done = this.moveAlongPath(bot, dt);
          if (done) {
            bot.state = 'hold';
            bot.holdYaw = bot.yaw;
            bot.holdT = 0;
          }
          break;
        }
        case 'hold': {
          bot.moving = false;
          bot.holdT += dt;
          // Slow yaw sweep while holding a position.
          bot.yaw = bot.holdYaw + Math.sin(bot.holdT * 0.5) * 0.9;
          break;
        }
        case 'investigate': {
          const done = this.moveAlongPath(bot, dt);
          if (done) {
            bot.holdT += dt;
            bot.yaw += dt * 1.2;
            if (bot.holdT > 2.5) {
              bot.state = 'hold';
              bot.holdYaw = bot.yaw;
            }
          }
          break;
        }
        case 'engage': {
          bot.moving = false;
          const target = this.resolveTarget(bot, view);
          if (!target) {
            bot.state = 'hold';
            break;
          }
          // Face the target.
          bot.yaw = Math.atan2(-(target.x - bot.x), -(target.z - bot.z));
          if (bot.reactT > 0) {
            bot.reactT -= dt;
            break;
          }
          if (bot.burstLeft <= 0) {
            if (bot.pauseT > 0) {
              bot.pauseT -= dt;
              break;
            }
            bot.burstLeft = BOT.burstMin
              + Math.floor(rng() * (BOT.burstMax - BOT.burstMin + 1));
            bot.shotT = 0;
          }
          bot.shotT -= dt;
          if (bot.shotT <= 0) {
            bot.shotT = BOT.shotInterval;
            bot.burstLeft -= 1;
            this.botShoot(bot, view);
            if (bot.burstLeft <= 0) {
              bot.pauseT = BOT.pauseMin + rng() * (BOT.pauseMax - BOT.pauseMin);
            }
          }
          break;
        }
        case 'plant': {
          bot.moving = false;
          if (hooks.tickPlant) {
            const done = hooks.tickPlant(dt, siteAt(bot.x, bot.z));
            if (done) bot.state = 'hold';
          }
          break;
        }
        case 'rotate': {
          const done = this.moveAlongPath(bot, dt);
          if (done) {
            bot.state = 'defuse';
            bot.channelT = 0;
          }
          break;
        }
        case 'defuse': {
          bot.moving = false;
          if (hooks.tickDefuse) {
            const done = hooks.tickDefuse(dt);
            if (done) bot.state = 'hold';
          }
          break;
        }
        default:
          bot.moving = false;
          break;
      }
    },
  };
  return mgr;
}

// ---- Bot bodies ---------------------------------------------------------
// Box-built humanoids: legs, torso, team-coloured shoulder stripe, head +
// team-coloured visor, gun. Death is a fall-over (rotate -1.45 rad over
// 0.35 s) and a fade after 5 s — the render sync in main.js drives both.

const TEAM_HEX_LOCAL = { ember: 0xf08a2e, slate: 0x3fb8ae };

export function buildBotMesh(bot) {
  const g = new THREE.Group();
  // YXZ so the death fall (rotation.x) tips the body forward in its own
  // facing direction instead of around the world X axis.
  g.rotation.order = 'YXZ';
  const dark = new THREE.MeshStandardMaterial({ color: 0x2e2a24, roughness: 0.9 });
  const team = new THREE.MeshStandardMaterial({
    color: TEAM_HEX_LOCAL[bot.team], roughness: 0.6,
  });
  const skin = new THREE.MeshStandardMaterial({ color: 0xc9a37e, roughness: 0.8 });
  const add = (w, h, d, x, y, z, mat) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);
    return m;
  };
  add(0.16, 0.75, 0.16, -0.11, 0.375, 0, dark); // legs
  add(0.16, 0.75, 0.16, 0.11, 0.375, 0, dark);
  add(0.52, 0.62, 0.3, 0, 1.06, 0, dark); // torso
  add(0.54, 0.1, 0.32, 0, 1.32, 0, team); // shoulder stripe
  add(0.3, 0.3, 0.3, 0, 1.55, 0, skin); // head
  add(0.32, 0.08, 0.06, 0, 1.58, -0.16, team); // visor
  add(0.08, 0.08, 0.62, 0.18, 1.15, -0.3, dark); // gun
  g.position.set(bot.x, 0, bot.z);
  g.rotation.y = bot.yaw;
  return g;
}
