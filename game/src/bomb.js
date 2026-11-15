// bomb.js — pure bomb state machine. No DOM, no three.js, so the rules
// unit-test in Node. The bomb is the tactic: it turns a deathmatch into a
// game about two 6x6 m patches of ground.
//
// States: carried -> dropped -> carried -> planted -> done (exploded)
//                                     planted -> defused
// The carrier is 'player' or a bot id. Planting takes 3 s inside a site,
// the fuse runs 40 s, defusing takes 5 s and is a Slate-only act.

export const PLANT_TIME = 3;
export const DEFUSE_TIME = 5;
export const FUSE_TIME = 40;
export const PICKUP_RADIUS = 1.4;
export const SITE_HALF = 3; // sites are 6 x 6 m around their centre

export const SITES = {
  A: { id: 'A', name: 'Crane Bay', x: -17, z: -12 },
  B: { id: 'B', name: 'Silo Row', x: 17, z: -12 },
};

export function createBomb() {
  return {
    state: 'carried', // carried | dropped | planted | done | defused
    carrier: 'player',
    site: null, // 'A' | 'B' once planted
    x: 0,
    z: 0,
    fuse: FUSE_TIME,
    plantProgress: 0,
    defuseProgress: 0,
  };
}

// Which site, if any, is this ground position inside?
export function siteAt(x, z) {
  for (const key of Object.keys(SITES)) {
    const s = SITES[key];
    if (Math.abs(x - s.x) <= SITE_HALF && Math.abs(z - s.z) <= SITE_HALF) return key;
  }
  return null;
}

export function inSite(x, z, siteId) {
  const s = SITES[siteId];
  if (!s) return false;
  return Math.abs(x - s.x) <= SITE_HALF && Math.abs(z - s.z) <= SITE_HALF;
}

// The carrier died: the bomb falls where they stood.
export function dropBomb(bomb, x, z) {
  bomb.state = 'dropped';
  bomb.carrier = null;
  bomb.x = x;
  bomb.z = z;
  bomb.plantProgress = 0;
  bomb.defuseProgress = 0;
}

// Someone walked over a dropped bomb.
export function pickupBomb(bomb, carrier) {
  if (bomb.state !== 'dropped') return false;
  bomb.state = 'carried';
  bomb.carrier = carrier;
  return true;
}

export function isCarriedBy(bomb, carrier) {
  return bomb.state === 'carried' && bomb.carrier === carrier;
}

// Hold-to-plant: call every tick while the carrier channels inside a site.
// Returns true the tick the plant completes.
export function tickPlant(bomb, dt, siteId) {
  if (bomb.state !== 'carried' || !siteId) {
    bomb.plantProgress = 0;
    return false;
  }
  bomb.plantProgress += dt;
  if (bomb.plantProgress >= PLANT_TIME) {
    bomb.state = 'planted';
    bomb.site = siteId;
    bomb.x = SITES[siteId].x;
    bomb.z = SITES[siteId].z;
    bomb.fuse = FUSE_TIME;
    bomb.plantProgress = 0;
    return true;
  }
  return false;
}

// The fuse only runs while planted. Returns true the tick it hits zero.
export function tickFuse(bomb, dt) {
  if (bomb.state !== 'planted') return false;
  bomb.fuse -= dt;
  if (bomb.fuse <= 0) {
    bomb.fuse = 0;
    bomb.state = 'done';
    return true;
  }
  return false;
}

// Hold-to-defuse: Slate only (the player is always Ember and can never
// defuse their own bomb). Returns true the tick the defuse completes.
export function tickDefuse(bomb, dt) {
  if (bomb.state !== 'planted') {
    bomb.defuseProgress = 0;
    return false;
  }
  bomb.defuseProgress += dt;
  if (bomb.defuseProgress >= DEFUSE_TIME) {
    bomb.state = 'defused';
    bomb.defuseProgress = 0;
    return true;
  }
  return false;
}

export function resetBomb(bomb) {
  bomb.state = 'carried';
  bomb.carrier = 'player';
  bomb.site = null;
  bomb.x = 0;
  bomb.z = 0;
  bomb.fuse = FUSE_TIME;
  bomb.plantProgress = 0;
  bomb.defuseProgress = 0;
}
