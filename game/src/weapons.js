// weapons.js — pure gunplay. No DOM, no three.js, so every number below
// unit-tests in Node. Accuracy beats speed: spread punishes movement,
// recoil punishes holding the trigger, the DMR rewards stopping.
//
// Two rules this module exists to protect (found by review, fixed here):
//  1. switchTo() NEVER resets the fire cooldown — switching weapons,
//     including re-selecting the one already held, must not let the
//     player fire faster than the fire gap allows.
//  2. resetMatch() clears EVERY per-weapon ammo cache, then re-seeds the
//     pistol to 12/48 — a stale cache must never resurrect old ammo.

export const WEAPONS = {
  pistol: {
    id: 'pistol', name: 'P9 Sidearm', price: 0,
    damage: 26, headMult: 4, auto: false, fireGap: 0.16,
    mag: 12, reserve: 48, reloadTime: 1.4,
    spreadStill: 0.003, spreadMove: 0.020, recoil: 0.007, range: 60,
  },
  smg: {
    id: 'smg', name: 'Hornet SMG', price: 1500,
    damage: 22, headMult: 4, auto: true, fireGap: 0.067,
    mag: 32, reserve: 96, reloadTime: 1.8,
    spreadStill: 0.004, spreadMove: 0.034, recoil: 0.006, range: 45,
  },
  rifle: {
    id: 'rifle', name: 'VK-7 Rifle', price: 2700,
    damage: 32, headMult: 4, auto: true, fireGap: 0.1,
    mag: 30, reserve: 90, reloadTime: 2.1,
    spreadStill: 0.0022, spreadMove: 0.028, recoil: 0.011, range: 80,
  },
  dmr: {
    id: 'dmr', name: 'Longbow DMR', price: 4750,
    damage: 88, headMult: 2, auto: false, fireGap: 1.15,
    mag: 5, reserve: 15, reloadTime: 2.8,
    spreadStill: 0.0004, spreadMove: 0.06, recoil: 0.03, range: 120,
    scoped: true,
  },
};

export const WEAPON_ORDER = ['pistol', 'smg', 'rifle', 'dmr'];

export const GEAR = {
  grenade: { id: 'grenade', name: 'Sparrow Frag', price: 300, max: 2 },
  kevlar: { id: 'kevlar', name: 'Kevlar Vest', price: 650, armor: 50 },
};

export function createWeaponState() {
  const s = {
    current: 'pistol',
    owned: ['pistol'],
    cooldown: 0,
    reloading: 0,
    reloadWeapon: null,
    mag: {},
    reserve: {},
    grenades: 0,
    armor: 0,
  };
  s.mag.pistol = WEAPONS.pistol.mag;
  s.reserve.pistol = WEAPONS.pistol.reserve;
  return s;
}

export function weaponDef(id) {
  return WEAPONS[id] || null;
}

export function currentDef(state) {
  return WEAPONS[state.current];
}

// Spread grows with speed; a scoped DMR uses 0.4x its still-spread.
export function spreadFor(def, speed, scoped) {
  const still = def.spreadStill * (scoped && def.scoped ? 0.4 : 1);
  return still + Math.min(1, speed / 5.2) * def.spreadMove;
}

// Damage falloff: the player's shots keep at least 55% at long range.
export function damageAt(def, dist, isPlayer = true) {
  const fall = isPlayer
    ? Math.max(0.55, 1 - dist / 160)
    : Math.max(0, 1 - dist / 140);
  return def.damage * fall;
}

export function ready(state) {
  return state.cooldown <= 0 && state.reloading <= 0;
}

// Switching preserves the outstanding cooldown and cancels a reload
// without losing ammo. Selecting the current weapon is a no-op.
export function switchTo(state, id) {
  if (id === state.current) return false;
  if (!WEAPONS[id] || !state.owned.includes(id)) return false;
  state.current = id;
  state.reloading = 0;
  state.reloadWeapon = null;
  return true;
}

export function cycleWeapon(state) {
  const owned = WEAPON_ORDER.filter((id) => state.owned.includes(id));
  if (owned.length < 2) return false;
  const i = owned.indexOf(state.current);
  return switchTo(state, owned[(i + 1) % owned.length]);
}

export function tickWeapons(state, dt) {
  if (state.cooldown > 0) state.cooldown -= dt;
  if (state.reloading > 0) {
    state.reloading -= dt;
    if (state.reloading <= 0) {
      state.reloading = 0;
      const id = state.reloadWeapon;
      state.reloadWeapon = null;
      if (id && WEAPONS[id]) {
        const def = WEAPONS[id];
        const need = def.mag - (state.mag[id] || 0);
        const take = Math.min(need, state.reserve[id] || 0);
        state.mag[id] = (state.mag[id] || 0) + take;
        state.reserve[id] = (state.reserve[id] || 0) - take;
      }
    }
  }
}

export function startReload(state) {
  if (state.reloading > 0) return false;
  const def = currentDef(state);
  const mag = state.mag[state.current] || 0;
  const reserve = state.reserve[state.current] || 0;
  if (mag >= def.mag || reserve <= 0) return false;
  state.reloading = def.reloadTime;
  state.reloadWeapon = state.current;
  return true;
}

// Fires one shot if able. Returns the weapon def, or null (not ready or
// empty — the caller plays the dry-fire click on an empty mag).
export function fire(state) {
  if (!ready(state)) return null;
  const def = currentDef(state);
  if ((state.mag[state.current] || 0) <= 0) return null;
  state.mag[state.current] -= 1;
  state.cooldown = def.fireGap;
  return def;
}

// Pure buy decisions: the caller (economy) moves the money.
export function buyWeapon(state, id, money) {
  const def = WEAPONS[id];
  if (!def) return { ok: false, reason: 'unknown' };
  if (state.owned.includes(id)) return { ok: false, reason: 'owned' };
  if (money < def.price) return { ok: false, reason: 'poor' };
  state.owned.push(id);
  state.mag[id] = def.mag;
  state.reserve[id] = def.reserve;
  return { ok: true, cost: def.price };
}

export function buyGear(state, id, money) {
  const gear = GEAR[id];
  if (!gear) return { ok: false, reason: 'unknown' };
  if (id === 'grenade' && state.grenades >= GEAR.grenade.max) {
    return { ok: false, reason: 'max' };
  }
  if (id === 'kevlar' && state.armor > 0) return { ok: false, reason: 'owned' };
  if (money < gear.price) return { ok: false, reason: 'poor' };
  if (id === 'grenade') state.grenades += 1;
  if (id === 'kevlar') state.armor = GEAR.kevlar.armor;
  return { ok: true, cost: gear.price };
}

// Full match reset: wipe every per-weapon ammo cache, then seed the pistol.
// A new match must never inherit a half-empty magazine from the last one.
export function resetMatch(state) {
  state.current = 'pistol';
  state.owned = ['pistol'];
  state.cooldown = 0;
  state.reloading = 0;
  state.reloadWeapon = null;
  state.mag = {};
  state.reserve = {};
  state.mag.pistol = WEAPONS.pistol.mag;
  state.reserve.pistol = WEAPONS.pistol.reserve;
  state.grenades = 0;
  state.armor = 0;
}

// A lost round costs the loadout; a survivor keeps everything.
export function resetRoundLoadout(state, survived) {
  if (survived) return;
  resetMatch(state);
}
