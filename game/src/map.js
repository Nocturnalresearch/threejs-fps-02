// map.js — Ember Yard, a freight yard at dusk, 46 x 38 m. Attackers spawn
// south, defenders north; site A "Crane Bay" west, site B "Silo Row" east,
// mid is a container row with a gap. Three lanes: A-long west, B-long east,
// mid.
//
// The nav graph is 30 hand-placed waypoints; edges are made by testing
// straight 2D segments against colliders inflated by the agent radius
// (0.45 m), max edge 14 m, and BFS finds the shortest path. Two layout
// constraints keep the graph connected: no waypoint sits inside an inflated
// collider, and the A/B lanes run at x = +/-20.5, clear of the site
// containers, so bots route lane -> link node -> site instead of straight
// through a container.

import * as THREE from 'three';
import { SITES } from './bomb.js';

export const MAP = { halfX: 23, halfZ: 19, wallHeight: 5 };
export const AGENT_RADIUS = 0.45;
export const MAX_EDGE = 14;

// Spawns: Ember south (player is ember[0]), Slate north by their holds.
export const SPAWNS = {
  ember: [
    [0, 16], [-3, 16], [3, 16], [-6, 15.5], [6, 15.5],
  ],
  slate: [
    [-18, -8], [-14, -8], [18, -8], [14, -8], [0, -14],
  ],
};

// 30 waypoints. Lanes at x = +/-20.5; 25/26 are the site link nodes;
// 27/28 are the site centres; 29 is the north-mid hold.
export const WAYPOINTS = [
  [0, 16], [-10, 16], [10, 16], [-20.5, 14], [20.5, 14],
  [-20.5, 8], [20.5, 8], [0, 12], [-10, 10], [10, 10],
  [-20.5, 2], [20.5, 2], [-8, 5], [8, 5], [0, 2],
  [0, -3], [-8, -5], [8, -5], [0, -9], [-10, -9],
  [10, -9], [-20.5, -4], [-20.5, -10], [20.5, -4], [20.5, -10],
  [-17, -7], [17, -7], [-17, -12], [17, -12], [0, -14],
];

export const HOLD_WPS = { A: [25, 27], B: [26, 28], mid: [29] };

// Colliders are axis-aligned boxes: {x0, z0, x1, z1, y0, y1, kind}.
// The crane jib beam rides high (y0 6.3) so it never blocks a walker.
export function buildColliders() {
  const c = [];
  const box = (cx, cz, hx, hz, y1, kind, y0 = 0) => {
    c.push({ x0: cx - hx, z0: cz - hz, x1: cx + hx, z1: cz + hz, y0, y1, kind });
  };
  // Perimeter walls (5 m).
  box(0, -19, 23.5, 0.5, 5, 'wall');
  box(0, 19, 23.5, 0.5, 5, 'wall');
  box(-23, 0, 0.5, 19.5, 5, 'wall');
  box(23, 0, 0.5, 19.5, 5, 'wall');
  // Site A: crane legs + jib beam, teal container guarding A-long, rust
  // container at the back, low crate at the site corner.
  box(-19.5, -12, 0.3, 0.55, 6.5, 'crane');
  box(-14.5, -12, 0.3, 0.55, 6.5, 'crane');
  box(-16.95, -12, 4.05, 0.4, 6.6, 'beam', 6.3);
  box(-18.5, -3, 1.2, 3, 2.6, 'container-teal');
  box(-17, -16.8, 2, 1.2, 2.6, 'container-rust');
  box(-13.5, -14.5, 0.6, 0.6, 1.2, 'crate');
  // Site B: two grain silos, rust container guarding B-long, teal container
  // at the back, low crate at the site corner.
  box(13, -16.8, 1.7, 1.7, 6.5, 'silo');
  box(21, -16.8, 1.7, 1.7, 6.5, 'silo');
  box(18.5, -3, 1.2, 3, 2.6, 'container-rust');
  box(17, -16.8, 2, 1.2, 2.6, 'container-teal');
  box(13.5, -14.5, 0.6, 0.6, 1.2, 'crate');
  // Mid: container row with a gap (west one stacked two levels), a cover
  // crate east of the gap, A-long / B-long crates, jumpable platform.
  box(-8, 0, 3, 1.2, 5.2, 'container-rust');
  box(8, 0, 3, 1.2, 2.6, 'container-teal');
  box(4.3, -0.5, 0.7, 0.7, 1.4, 'crate');
  box(-14, 2, 0.7, 0.7, 1.4, 'crate');
  box(14, 2, 0.7, 0.7, 1.4, 'crate');
  box(0, 7, 3, 2, 0.5, 'platform');
  return c;
}

// A collider blocks walking (and nav) when a standing body overlaps it.
export function blocksNav(c) {
  return c.y0 < 1.2 && c.y1 > 0.3;
}

// 2D segment vs inflated AABB, slab method. A graze on the boundary does
// not count — only a real pass through the inflated box blocks the edge.
export function segmentBlocked(x0, z0, x1, z1, colliders, inflate = AGENT_RADIUS) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  for (const c of colliders) {
    if (!blocksNav(c)) continue;
    const bx0 = c.x0 - inflate;
    const bx1 = c.x1 + inflate;
    const bz0 = c.z0 - inflate;
    const bz1 = c.z1 + inflate;
    let tmin = 0;
    let tmax = 1;
    if (dx === 0) {
      if (x0 < bx0 || x0 > bx1) continue;
    } else {
      let ta = (bx0 - x0) / dx;
      let tb = (bx1 - x0) / dx;
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      tmin = Math.max(tmin, ta);
      tmax = Math.min(tmax, tb);
      if (tmin >= tmax) continue;
    }
    if (dz === 0) {
      if (z0 < bz0 || z0 > bz1) continue;
    } else {
      let ta = (bz0 - z0) / dz;
      let tb = (bz1 - z0) / dz;
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      tmin = Math.max(tmin, ta);
      tmax = Math.min(tmax, tb);
      if (tmin >= tmax) continue;
    }
    return true;
  }
  return false;
}

export function buildNavGraph(colliders) {
  const n = WAYPOINTS.length;
  const graph = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const [ax, az] = WAYPOINTS[i];
      const [bx, bz] = WAYPOINTS[j];
      const d = Math.hypot(bx - ax, bz - az);
      if (d > MAX_EDGE) continue;
      if (segmentBlocked(ax, az, bx, bz, colliders)) continue;
      graph[i].push(j);
      graph[j].push(i);
    }
  }
  return graph;
}

// BFS shortest path of waypoint indices, inclusive of both ends.
export function findPath(graph, from, to) {
  if (from === to) return [from];
  const prev = new Array(graph.length).fill(-1);
  const queue = [from];
  prev[from] = from;
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const next of graph[cur]) {
      if (prev[next] !== -1) continue;
      prev[next] = cur;
      if (next === to) {
        const path = [to];
        let node = to;
        while (node !== from) {
          node = prev[node];
          path.unshift(node);
        }
        return path;
      }
      queue.push(next);
    }
  }
  return [];
}

export function nearestWaypoint(x, z) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < WAYPOINTS.length; i++) {
    const d = Math.hypot(WAYPOINTS[i][0] - x, WAYPOINTS[i][1] - z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export function waypointInsideCollider(colliders, inflate = AGENT_RADIUS) {
  const bad = [];
  for (let i = 0; i < WAYPOINTS.length; i++) {
    const [x, z] = WAYPOINTS[i];
    for (const c of colliders) {
      if (!blocksNav(c)) continue;
      if (x > c.x0 - inflate && x < c.x1 + inflate
        && z > c.z0 - inflate && z < c.z1 + inflate) {
        bad.push(i);
        break;
      }
    }
  }
  return bad;
}

// Line of sight between two 3D points, raycast against the world meshes.
// True when nothing solid stands between them.
const _ray = new THREE.Raycaster();
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _dir = new THREE.Vector3();

export function hasLineOfSight(losMeshes, ax, ay, az, bx, by, bz) {
  _from.set(ax, ay, az);
  _to.set(bx, by, bz);
  _dir.subVectors(_to, _from);
  const dist = _dir.length();
  if (dist < 0.001) return true;
  _dir.multiplyScalar(1 / dist);
  _ray.set(_from, _dir);
  _ray.far = dist - 0.05;
  const hits = _ray.intersectObjects(losMeshes, false);
  return hits.length === 0;
}

// Distance from a ray origin along a direction to the nearest world mesh
// (Infinity when the ray escapes the yard). Used for bullet wall stops.
export function rayWorldDist(losMeshes, ox, oy, oz, dx, dy, dz, maxDist) {
  _from.set(ox, oy, oz);
  _dir.set(dx, dy, dz).normalize();
  _ray.set(_from, _dir);
  _ray.far = maxDist;
  const hits = _ray.intersectObjects(losMeshes, false);
  return hits.length > 0 ? hits[0].distance : Infinity;
}

// ---- Visual world -------------------------------------------------------

const COL = {
  ground: 0x201b15,
  wall: 0x2a2721,
  rust: 0x8a4a26,
  teal: 0x2e6f6a,
  steel: 0x5a5f66,
  crate: 0x6b5433,
  platform: 0x3a352c,
  silo: 0x7d94a0,
  line: 0xf08a2e,
};

function std(color, roughness = 0.9, metalness = 0.05) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function addBox(group, losMeshes, cx, cy, cz, sx, sy, sz, mat, shadow = true) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
  m.position.set(cx, cy, cz);
  m.castShadow = shadow;
  m.receiveShadow = true;
  group.add(m);
  losMeshes.push(m);
  return m;
}

// Builds the visible yard into `scene` and returns the sim data.
export function createWorld(scene) {
  const group = new THREE.Group();
  const losMeshes = [];
  const colliders = buildColliders();

  scene.fog = new THREE.Fog(0x1a1712, 26, 70);
  scene.background = new THREE.Color(0x1a1712);

  // Ground.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(48, 40),
    std(COL.ground, 1, 0),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);

  // Painted centre line + site borders (amber decals, flat on the ground).
  const decal = new THREE.MeshBasicMaterial({
    color: 0x9a6420, transparent: true, opacity: 0.85,
  });
  const line = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 38), decal);
  line.rotation.x = -Math.PI / 2;
  line.position.set(0, 0.02, 0);
  group.add(line);
  for (const key of Object.keys(SITES)) {
    const s = SITES[key];
    const border = new THREE.Mesh(
      new THREE.PlaneGeometry(6.6, 6.6),
      new THREE.MeshBasicMaterial({
        color: key === 'A' ? 0xf08a2e : 0x3fb8ae,
        transparent: true, opacity: 0.16,
      }),
    );
    border.rotation.x = -Math.PI / 2;
    border.position.set(s.x, 0.03, s.z);
    group.add(border);
  }

  // Perimeter walls.
  const wallMat = std(COL.wall, 1, 0);
  addBox(group, losMeshes, 0, 2.5, -19, 47, 5, 1, wallMat);
  addBox(group, losMeshes, 0, 2.5, 19, 47, 5, 1, wallMat);
  addBox(group, losMeshes, -23, 2.5, 0, 1, 5, 39, wallMat);
  addBox(group, losMeshes, 23, 2.5, 0, 1, 5, 39, wallMat);

  // Site A crane: two legs + the 8.1 m jib beam at 6.4 m.
  const steel = std(COL.steel, 0.6, 0.5);
  addBox(group, losMeshes, -19.5, 3.25, -12, 0.6, 6.5, 1.1, steel);
  addBox(group, losMeshes, -14.5, 3.25, -12, 0.6, 6.5, 1.1, steel);
  const beam = addBox(group, losMeshes, -16.95, 6.45, -12, 8.1, 0.3, 0.8, steel);
  beam.castShadow = true;

  // Containers.
  const rustMat = std(COL.rust, 0.85, 0.1);
  const tealMat = std(COL.teal, 0.85, 0.1);
  addBox(group, losMeshes, -18.5, 1.3, -3, 2.4, 2.6, 6, tealMat);
  addBox(group, losMeshes, -17, 1.3, -16.8, 4, 2.6, 2.4, rustMat);
  addBox(group, losMeshes, 18.5, 1.3, -3, 2.4, 2.6, 6, rustMat);
  addBox(group, losMeshes, 17, 1.3, -16.8, 4, 2.6, 2.4, tealMat);
  // Mid row: west container stacked two levels, east one level.
  addBox(group, losMeshes, -8, 1.3, 0, 6, 2.6, 2.4, rustMat);
  addBox(group, losMeshes, -8, 3.9, 0, 6, 2.6, 2.4, tealMat);
  addBox(group, losMeshes, 8, 1.3, 0, 6, 2.6, 2.4, tealMat);

  // Grain silos at B (cylinders; the collider is their square footprint).
  const siloMat = std(COL.silo, 0.5, 0.6);
  for (const sx of [13, 21]) {
    const silo = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 6.5, 20), siloMat);
    silo.position.set(sx, 3.25, -16.8);
    silo.castShadow = true;
    silo.receiveShadow = true;
    group.add(silo);
    losMeshes.push(silo);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(1.7, 1, 20), steel);
    cap.position.set(sx, 6.9, -16.8);
    cap.castShadow = true;
    group.add(cap);
  }

  // Crates + jumpable mid platform.
  const crateMat = std(COL.crate, 0.95, 0);
  addBox(group, losMeshes, 4.3, 0.7, -0.5, 1.4, 1.4, 1.4, crateMat);
  addBox(group, losMeshes, -14, 0.7, 2, 1.4, 1.4, 1.4, crateMat);
  addBox(group, losMeshes, 14, 0.7, 2, 1.4, 1.4, 1.4, crateMat);
  addBox(group, losMeshes, -13.5, 0.6, -14.5, 1.2, 1.2, 1.2, crateMat);
  addBox(group, losMeshes, 13.5, 0.6, -14.5, 1.2, 1.2, 1.2, crateMat);
  const plat = addBox(group, losMeshes, 0, 0.25, 7, 6, 0.5, 4, std(COL.platform, 0.9, 0.1));
  plat.castShadow = true;

  // Site beacons: glowing poles + point lights (amber A, teal B).
  for (const key of Object.keys(SITES)) {
    const s = SITES[key];
    const color = key === 'A' ? 0xf08a2e : 0x3fb8ae;
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.09, 3.4, 8),
      std(0x3a352c, 0.7, 0.3),
    );
    pole.position.set(s.x + 2.6, 1.7, s.z + 2.6);
    group.add(pole);
    const lamp = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 12, 10),
      new THREE.MeshBasicMaterial({ color }),
    );
    lamp.position.set(s.x + 2.6, 3.5, s.z + 2.6);
    group.add(lamp);
    const light = new THREE.PointLight(color, 18, 16, 1.8);
    light.position.set(s.x + 2.6, 3.4, s.z + 2.6);
    group.add(light);
  }

  // Light: warm hemisphere fill, low amber sun from the west, cool fill.
  const hemi = new THREE.HemisphereLight(0x8fa8bf, 0x8a6a42, 0.85);
  group.add(hemi);
  const sun = new THREE.DirectionalLight(0xffb36b, 2.6);
  sun.position.set(-30, 22, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -26;
  sun.shadow.camera.right = 26;
  sun.shadow.camera.top = 26;
  sun.shadow.camera.bottom = -26;
  sun.shadow.camera.far = 90;
  group.add(sun);
  group.add(sun.target);
  const fill = new THREE.DirectionalLight(0x9fb8cc, 0.5);
  fill.position.set(25, 18, -12);
  group.add(fill);

  scene.add(group);
  return { group, colliders, losMeshes, graph: buildNavGraph(colliders) };
}
