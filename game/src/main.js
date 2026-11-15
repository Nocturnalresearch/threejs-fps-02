// main.js — EMBERLINE. One state object (G) + a fixed 60 Hz simulation
// kept apart from rendering; the browser boot at the bottom wires the sim
// to three.js, the HUD, input and audio.
//
// The sim is deliberately importable in Node: createSim() takes its world
// (colliders / nav graph / LOS meshes) and its hooks (feed, tracers,
// sounds, wall raycast) as arguments, so the rules unit-test without a
// browser. The fixes from the first review live here:
//  - the HUD syncs once per rendered frame, after the sim steps;
//  - the Ember player can never defuse their own bomb (Slate bots only);
//  - a detonation result is authoritative BEFORE blast damage runs, so the
//    blast killing the last Ember cannot steal the round for Slate;
//  - live processing stops the moment the phase leaves 'live';
//  - a grenade never survives into the next round;
//  - bomb pickup runs during live play whether or not the player is alive;
//  - the player's death reaches the kill feed;
//  - the last Slate dying with the bomb planted triggers the explosion;
//  - damage interrupts a plant/defuse channel.

import * as THREE from 'three';
import { createInput } from './input.js';
import {
  createPlayer, stepPlayer, wishDir, eyeHeight, speedOf, MOVE,
} from './player.js';
import {
  WEAPONS, GEAR, createWeaponState, switchTo, cycleWeapon,
  tickWeapons, startReload, fire as fireWeapon, buyWeapon, buyGear,
  resetMatch, resetRoundLoadout, spreadFor, damageAt, currentDef,
} from './weapons.js';
import {
  createEconomy, spend, earn, roundReward,
  KILL_REWARD, PLANT_REWARD,
} from './economy.js';
import {
  createBomb, dropBomb, pickupBomb, tickPlant, tickFuse, tickDefuse,
  siteAt, resetBomb, SITES, PLANT_TIME, PICKUP_RADIUS,
} from './bomb.js';
import {
  SPAWNS, createWorld, rayWorldDist,
} from './map.js';
import { createBotManager, buildBotMesh, rayHitBots, BOT } from './bots.js';
import { createHud } from './hud.js';
import { createAudio } from './audio.js';
import { createEffects } from './effects.js';

export const STEP = 1 / 60;
export const BUY_TIME = 12;
export const ROUND_TIME = 100;
export const ROUND_END_TIME = 3.4;
export const WIN_ROUNDS = 5;
export const MAX_ROUNDS = 9;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const noop = () => {};
function withHooks(hooks) {
  return {
    feed: hooks.feed || noop,
    shot: hooks.shot || noop,
    explosion: hooks.explosion || noop,
    bounce: hooks.bounce || noop,
    hurt: hooks.hurt || noop,
    hitmark: hooks.hitmark || noop,
    killChime: hooks.killChime || noop,
    hitSound: hooks.hitSound || noop,
    dry: hooks.dry || noop,
    reloadSound: hooks.reloadSound || noop,
    buySound: hooks.buySound || noop,
    denySound: hooks.denySound || noop,
    beep: hooks.beep || noop,
    sting: hooks.sting || noop,
    damageFlash: hooks.damageFlash || noop,
    worldHit: hooks.worldHit || (() => Infinity),
  };
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

export function createSim(opts = {}) {
  const rng = opts.rng || Math.random;
  const mapData = opts.mapData;
  const hooks = withHooks(opts.hooks || {});

  const G = {
    phase: 'menu', // menu | buy | live | roundEnd | matchEnd
    round: 1,
    score: { ember: 0, slate: 0 },
    timer: 0,
    time: 0,
    player: createPlayer(SPAWNS.ember[0][0], SPAWNS.ember[0][1], 0),
    hp: 100,
    alive: true,
    weapons: createWeaponState(),
    econ: createEconomy(),
    bomb: createBomb(),
    bots: null,
    planSite: 'A',
    grenade: { active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, fuse: 0, bounced: false },
    channel: null, // {kind:'plant'|'defuse', frac}
    buyOpen: false,
    scoped: false,
    shake: 0,
    roundWinner: null,
    roundReason: '',
    matchWinner: null,
    pendingMatch: false,
    playerSurvived: true,
    resolvingDetonation: false,
    banner: null, // {title, sub, t}
  };

  const botHooks = {
    onShot: (result) => applyBotShot(result),
    tickPlant: (dt, site) => botPlantTick(dt, site),
    tickDefuse: (dt) => botDefuseTick(dt),
  };
  G.bots = createBotManager(mapData, rng, botHooks);

  function setBanner(title, sub, t = 3.2) {
    G.banner = { title, sub, t };
  }

  function startMatch() {
    G.score = { ember: 0, slate: 0 };
    G.round = 1;
    G.matchWinner = null;
    G.pendingMatch = false;
    G.playerSurvived = true;
    G.econ = createEconomy();
    G.weapons = createWeaponState();
    startRound(1);
  }

  function startRound(n) {
    G.round = n;
    G.planSite = rng() < 0.5 ? 'A' : 'B';
    const [sx, sz] = SPAWNS.ember[0];
    G.player = createPlayer(sx, sz, 0);
    G.hp = 100;
    G.alive = true;
    resetRoundLoadout(G.weapons, G.playerSurvived);
    resetBomb(G.bomb);
    G.grenade.active = false; // a grenade never survives into a new round
    G.channel = null;
    G.buyOpen = false;
    G.scoped = false;
    G.shake = 0;
    G.roundWinner = null;
    G.roundReason = '';
    G.resolvingDetonation = false;
    G.bots.spawnRound(G.planSite);
    G.phase = 'buy';
    G.timer = BUY_TIME;
    setBanner(`ROUND ${n}`, `First to ${WIN_ROUNDS} — ${G.planSite === 'A' ? 'Crane Bay' : 'Silo Row'} is the plan`);
  }

  function beginLive() {
    G.phase = 'live';
    G.timer = ROUND_TIME;
    G.banner = null;
  }

  function endRound(winner, reason) {
    if (G.phase === 'roundEnd' || G.phase === 'matchEnd') return;
    G.roundWinner = winner;
    G.roundReason = reason;
    G.score[winner] += 1;
    roundReward(G.econ, winner === 'ember');
    G.playerSurvived = G.alive;
    G.grenade.active = false; // a grenade never survives the round end
    G.channel = null;
    G.scoped = false;
    G.phase = 'roundEnd';
    G.timer = ROUND_END_TIME;
    const score = `EMBER ${G.score.ember} – ${G.score.slate} SLATE`;
    setBanner(
      winner === 'ember' ? 'ROUND WON' : 'ROUND LOST',
      `${reason}  •  ${score}`,
      ROUND_END_TIME,
    );
    hooks.sting(winner === 'ember');
    if (G.score.ember >= WIN_ROUNDS || G.score.slate >= WIN_ROUNDS || G.round >= MAX_ROUNDS) {
      G.pendingMatch = true;
      G.matchWinner = G.score.ember > G.score.slate ? 'ember' : 'slate';
    }
  }

  // The detonation is authoritative: the Ember win is decided BEFORE the
  // blast damage runs, and elimination checks are suppressed while it
  // resolves, so the blast killing the last Ember cannot hand Slate the
  // round.
  function detonate() {
    if (G.bomb.state !== 'planted' && G.bomb.state !== 'done') return;
    G.bomb.state = 'done';
    G.bomb.fuse = 0;
    G.resolvingDetonation = true;
    const pos = { x: G.bomb.x, y: 0.6, z: G.bomb.z };
    hooks.explosion(pos);
    G.shake = 1;
    applyBlast(pos, { self: false });
    G.resolvingDetonation = false;
    const siteName = G.bomb.site ? SITES[G.bomb.site].name : 'the site';
    endRound('ember', `The bomb went off — the fuse ran out at ${siteName}`);
  }

  function checkRoundEnd() {
    if (G.phase !== 'live' || G.resolvingDetonation) return;
    const emberAlive = G.alive || G.bots.aliveOf('ember').length > 0;
    const slateAlive = G.bots.aliveOf('slate').length > 0;
    if (!slateAlive) {
      if (G.bomb.state === 'planted') {
        detonate(); // last Slate dies with the bomb planted: it goes off
      } else {
        endRound('ember', 'Slate team eliminated');
      }
      return;
    }
    if (!emberAlive) {
      if (G.bomb.state === 'planted') return; // defenders must still defuse
      endRound('slate', 'Ember team eliminated');
    }
  }

  // Blast damage: radius 6 m, max 110, falloff (1 - d/6 * 0.7). The
  // thrower's own grenade hurts them half as much.
  function applyBlast(pos, { self } = {}) {
    const R = 6;
    const dmgAt = (d) => (d >= R ? 0 : 110 * (1 - (d / R) * 0.7));
    if (G.alive) {
      const d = Math.hypot(G.player.x - pos.x, (G.player.y + 1) - pos.y, G.player.z - pos.z);
      const dmg = dmgAt(d) * (self ? 0.5 : 1);
      if (dmg > 0) damagePlayer(dmg, false, null);
    }
    for (const bot of G.bots.bots) {
      if (!bot.alive) continue;
      const d = Math.hypot(bot.x - pos.x, 1.15 - pos.y, bot.z - pos.z);
      const dmg = dmgAt(d);
      if (dmg > 0) damageBotRecord(bot, dmg, false, 'bomb');
    }
  }

  function damagePlayer(dmg, head, srcBot) {
    if (!G.alive || G.phase !== 'live') return;
    // Damage interrupts any plant/defuse channel: stand still, don't get hit.
    G.channel = null;
    G.bomb.plantProgress = 0;
    let hpLoss = dmg;
    if (G.weapons.armor > 0) {
      const absorbed = Math.min(G.weapons.armor, dmg * 0.5);
      G.weapons.armor -= absorbed;
      hpLoss = dmg - absorbed;
    }
    G.hp -= hpLoss;
    hooks.hurt();
    hooks.damageFlash();
    if (G.hp <= 0) {
      G.hp = 0;
      G.alive = false;
      G.scoped = false;
      // The player's death reaches the kill feed.
      hooks.feed(srcBot ? srcBot.name : 'Bomb', 'You', !!head);
      if (G.bomb.state === 'carried' && G.bomb.carrier === 'player') {
        dropBomb(G.bomb, G.player.x, G.player.z);
      }
      checkRoundEnd();
    }
  }

  function damageBotRecord(bot, dmg, head, srcId) {
    const res = G.bots.damageBot(bot, dmg, head, srcId);
    if (!res) return;
    if (res.killed) {
      const killer = srcId === 'player' ? 'You'
        : srcId === 'bomb' ? 'Bomb'
        : (G.bots.botById(srcId) || {}).name || srcId;
      hooks.feed(killer, bot.name, !!head);
      if (srcId === 'player') {
        earn(G.econ, KILL_REWARD);
        hooks.killChime();
      }
      checkRoundEnd();
    }
  }

  // A bot's shot resolves here: tracer + sound, then damage to whoever the
  // ray actually met (player, or the bot in the way).
  function applyBotShot(result) {
    const from = { x: result.bot.x, y: BOT.eyeHeight, z: result.bot.z };
    const to = result.target.kind === 'player'
      ? { x: result.target.x, y: 1.15, z: result.target.z }
      : { x: result.hitBot ? result.hitBot.x : result.target.x,
          y: 1.15,
          z: result.hitBot ? result.hitBot.z : result.target.z };
    hooks.shot(from, to, 'bot');
    if (!result.hit) return;
    if (result.target.kind === 'player') {
      damagePlayer(result.dmg, result.head, result.bot);
    } else if (result.hitBot) {
      damageBotRecord(result.hitBot, result.dmg, result.head, result.bot.id);
    }
  }

  function botPlantTick(dt, site) {
    if (!site) return false;
    const done = tickPlant(G.bomb, dt, site);
    if (done) {
      earn(G.econ, PLANT_REWARD);
      hooks.beep(true);
      setBanner('BOMB PLANTED', `Fuse running — hold ${SITES[site].name}`, 3.2);
    }
    return done;
  }

  function botDefuseTick(dt) {
    if (G.bomb.state !== 'planted') return false;
    const done = tickDefuse(G.bomb, dt);
    if (done) {
      hooks.beep(true);
      endRound('slate', 'The bomb was defused');
    }
    return done;
  }

  // ---- Player shooting ----------------------------------------------------
  function tryFire(input) {
    const state = G.weapons;
    const def = currentDef(state);
    if (state.reloading > 0) return;
    if ((state.mag[state.current] || 0) <= 0) {
      if (state.cooldown <= 0) {
        hooks.dry();
        state.cooldown = 0.25;
      }
      return;
    }
    const fired = fireWeapon(state);
    if (!fired) return;
    const speed = speedOf(G.player);
    const spread = spreadFor(def, speed, G.scoped);
    const yaw = G.player.yaw + (rng() * 2 - 1) * spread;
    const pitch = G.player.pitch + (rng() * 2 - 1) * spread;
    const dx = -Math.sin(yaw) * Math.cos(pitch);
    const dy = Math.sin(pitch);
    const dz = -Math.cos(yaw) * Math.cos(pitch);
    const eye = { x: G.player.x, y: eyeHeight(G.player), z: G.player.z };
    const wallDist = hooks.worldHit(eye.x, eye.y, eye.z, dx, dy, dz, def.range);
    const hit = rayHitBots(
      eye.x, eye.y, eye.z, dx, dy, dz,
      Math.min(wallDist, def.range), G.bots.bots, null,
    );
    const endDist = hit ? hit.dist : Math.min(wallDist, def.range);
    const to = {
      x: eye.x + dx * endDist,
      y: eye.y + dy * endDist,
      z: eye.z + dz * endDist,
    };
    hooks.shot(eye, to, def.id);
    // Recoil kicks the pitch up, with a small random yaw.
    G.player.pitch = Math.min(MOVE.pitchClamp, G.player.pitch + def.recoil);
    G.player.yaw += (rng() * 2 - 1) * def.recoil * 0.4;
    // Gunshots within 30 m pull the nearest bots to investigate.
    G.bots.hearNoise(G.player.x, G.player.z, BOT.hearShot, 'slate');
    G.bots.hearNoise(G.player.x, G.player.z, BOT.hearShot, 'ember');
    if (!hit) return;
    const dist = hit.dist;
    const head = hit.part === 'head';
    const dmg = damageAt(def, dist, true) * (head ? def.headMult : 1);
    hooks.hitSound(head);
    hooks.hitmark(head, false);
    damageBotRecord(hit.bot, dmg, head, 'player');
    if (!hit.bot.alive) hooks.hitmark(head, true);
  }

  function throwGrenade() {
    if (G.weapons.grenades <= 0 || G.grenade.active) return false;
    G.weapons.grenades -= 1;
    const yaw = G.player.yaw;
    const pitch = G.player.pitch;
    const fx = -Math.sin(yaw) * Math.cos(pitch);
    const fy = Math.sin(pitch);
    const fz = -Math.cos(yaw) * Math.cos(pitch);
    G.grenade.active = true;
    G.grenade.x = G.player.x + fx * 0.5;
    G.grenade.y = eyeHeight(G.player);
    G.grenade.z = G.player.z + fz * 0.5;
    G.grenade.vx = fx * 14;
    G.grenade.vy = fy * 14 + 3.2;
    G.grenade.vz = fz * 14;
    G.grenade.fuse = 2.8;
    G.grenade.bounced = false;
    return true;
  }

  function stepGrenade(dt) {
    const g = G.grenade;
    if (!g.active) return;
    g.fuse -= dt;
    g.vy -= 18 * dt;
    g.x += g.vx * dt;
    g.y += g.vy * dt;
    g.z += g.vz * dt;
    // AABB bounce (reflect x -0.45); the fuse shortens after the first one.
    for (const c of mapData.colliders) {
      if (g.x > c.x0 - 0.12 && g.x < c.x1 + 0.12
        && g.z > c.z0 - 0.12 && g.z < c.z1 + 0.12
        && g.y > c.y0 - 0.12 && g.y < c.y1 + 0.12) {
        const px = Math.min(g.x - (c.x0 - 0.12), (c.x1 + 0.12) - g.x);
        const pz = Math.min(g.z - (c.z0 - 0.12), (c.z1 + 0.12) - g.z);
        const py = Math.min(g.y - (c.y0 - 0.12), (c.y1 + 0.12) - g.y);
        if (px <= py && px <= pz) g.vx *= -0.45;
        else if (pz <= py) g.vz *= -0.45;
        else g.vy *= -0.45;
        if (!g.bounced) {
          g.bounced = true;
          g.fuse = Math.min(g.fuse, 1.6);
          hooks.bounce();
        }
        break;
      }
    }
    if (g.y < 0.12) {
      g.y = 0.12;
      if (g.vy < 0) {
        g.vy *= -0.45;
        if (!g.bounced) {
          g.bounced = true;
          g.fuse = Math.min(g.fuse, 1.6);
          hooks.bounce();
        }
      }
    }
    if (g.fuse <= 0) {
      g.active = false;
      const pos = { x: g.x, y: Math.max(0.3, g.y), z: g.z };
      hooks.explosion(pos);
      G.shake = 1;
      G.bots.hearNoise(g.x, g.z, BOT.hearBoom, 'slate');
      G.bots.hearNoise(g.x, g.z, BOT.hearBoom, 'ember');
      applyBlast(pos, { self: true });
      if (G.phase === 'live') checkRoundEnd();
    }
  }

  // ---- Buy menu -----------------------------------------------------------
  function buyAction(index) {
    // 1-4: weapons (buy, or switch when already owned). 5: grenade. 6: kevlar.
    const ids = ['pistol', 'smg', 'rifle', 'dmr'];
    if (index >= 1 && index <= 4) {
      const id = ids[index - 1];
      if (G.weapons.owned.includes(id)) {
        if (switchTo(G.weapons, id)) hooks.buySound();
        return;
      }
      const res = buyWeapon(G.weapons, id, G.econ.money);
      if (res.ok) {
        spend(G.econ, res.cost);
        switchTo(G.weapons, id);
        hooks.buySound();
      } else {
        hooks.denySound();
      }
      return;
    }
    if (index === 5) {
      const res = buyGear(G.weapons, 'grenade', G.econ.money);
      if (res.ok) {
        spend(G.econ, res.cost);
        hooks.buySound();
      } else hooks.denySound();
      return;
    }
    if (index === 6) {
      const res = buyGear(G.weapons, 'kevlar', G.econ.money);
      if (res.ok) {
        spend(G.econ, res.cost);
        hooks.buySound();
      } else hooks.denySound();
    }
  }

  function buyItems() {
    const items = [];
    const order = [
      { key: '1', id: 'pistol' }, { key: '2', id: 'smg' },
      { key: '3', id: 'rifle' }, { key: '4', id: 'dmr' },
    ];
    for (const { key, id } of order) {
      const def = WEAPONS[id];
      items.push({
        key, label: def.name, price: def.price,
        owned: G.weapons.owned.includes(id),
        afford: G.econ.money >= def.price,
      });
    }
    items.push({
      key: '5', label: 'Sparrow Frag', price: GEAR.grenade.price,
      owned: false, afford: G.econ.money >= GEAR.grenade.price
        && G.weapons.grenades < GEAR.grenade.max,
    });
    items.push({
      key: '6', label: 'Kevlar Vest', price: GEAR.kevlar.price,
      owned: G.weapons.armor > 0, afford: G.econ.money >= GEAR.kevlar.price,
    });
    return items;
  }

  // ---- Per-frame input (built by the browser loop, or by tests) ------------
  function step(dt, input = {}) {
    G.time += dt;
    if (G.banner && G.banner.t > 0) {
      G.banner.t -= dt;
      if (G.banner.t <= 0) G.banner = null;
    }
    if (G.phase === 'buy') {
      stepBuy(dt, input);
      return;
    }
    if (G.phase === 'live') {
      stepLive(dt, input);
      return;
    }
    if (G.phase === 'roundEnd') {
      G.timer -= dt;
      if (G.timer <= 0) {
        if (G.pendingMatch) {
          G.phase = 'matchEnd';
        } else {
          startRound(G.round + 1);
        }
      }
    }
  }

  function stepBuy(dt, input) {
    G.timer -= dt;
    if (input.buyToggle) G.buyOpen = !G.buyOpen;
    if (input.buyKey) buyAction(input.buyKey);
    if (input.switchId) switchTo(G.weapons, input.switchId);
    if (input.cycle) cycleWeapon(G.weapons);
    if (G.alive) movePlayer(dt, input);
    tickWeapons(G.weapons, dt);
    if (G.timer <= 0) beginLive();
  }

  function movePlayer(dt, input) {
    const p = G.player;
    if (input.lookDX || input.lookDY) {
      p.yaw -= (input.lookDX || 0) * MOVE.sensitivity;
      p.pitch -= (input.lookDY || 0) * MOVE.sensitivity;
      p.pitch = Math.max(-MOVE.pitchClamp, Math.min(MOVE.pitchClamp, p.pitch));
    }
    const fwd = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
    const str = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const { fx, fz } = wishDir(p.yaw, fwd, str);
    stepPlayer(p, {
      fx, fz,
      jump: !!input.jump,
      crouch: !!input.crouch,
      slow: !!input.slow,
      scoped: G.scoped,
    }, mapData.colliders, dt);
  }

  function stepLive(dt, input) {
    // The round clock only ends the round while the bomb is NOT planted;
    // once planted, the fuse decides.
    G.timer -= dt;
    if (G.timer <= 0 && G.bomb.state !== 'planted') {
      endRound('slate', 'Time ran out — the bomb never went off');
      return;
    }
    if (G.phase !== 'live') return; // stop the moment the phase moves

    // Fuse tick: a detonation ends the round authoritatively.
    if (G.bomb.state === 'planted' && tickFuse(G.bomb, dt)) {
      detonate();
      return;
    }
    if (G.phase !== 'live') return;

    // Player.
    if (G.alive) {
      movePlayer(dt, input);
      G.scoped = !!input.scope && G.weapons.current === 'dmr';
      tickWeapons(G.weapons, dt);
      if (input.reload) {
        if (startReload(G.weapons)) hooks.reloadSound();
      }
      if (input.switchId) switchTo(G.weapons, input.switchId);
      if (input.cycle) cycleWeapon(G.weapons);
      if (input.grenade) throwGrenade();
      const def = currentDef(G.weapons);
      if (input.fire && (def.auto || input.firePressed)) tryFire(input);
      if (G.phase !== 'live') return;

      // Plant channel: hold E inside a site while carrying the bomb.
      const site = siteAt(G.player.x, G.player.z);
      if (input.plantHeld && site
        && G.bomb.state === 'carried' && G.bomb.carrier === 'player') {
        const done = tickPlant(G.bomb, dt, site);
        G.channel = { kind: 'plant', frac: G.bomb.plantProgress / PLANT_TIME };
        if (done) {
          G.channel = null;
          earn(G.econ, PLANT_REWARD);
          hooks.beep(true);
          setBanner('BOMB PLANTED', `Fuse running — hold ${SITES[site].name}`, 3.2);
        }
      } else {
        if (G.bomb.state === 'carried') tickPlant(G.bomb, dt, null);
        G.channel = null;
      }
      // The player is always Ember: there is no defuse path for them.
    }
    if (G.phase !== 'live') return;

    // Bomb pickup runs during live play whether or not the player survived.
    if (G.bomb.state === 'dropped') {
      if (G.alive
        && Math.hypot(G.player.x - G.bomb.x, G.player.z - G.bomb.z) <= PICKUP_RADIUS) {
        pickupBomb(G.bomb, 'player');
      } else {
        let best = null;
        let bestD = Infinity;
        for (const bot of G.bots.aliveOf('ember')) {
          const d = Math.hypot(bot.x - G.bomb.x, bot.z - G.bomb.z);
          if (d < bestD) {
            bestD = d;
            best = bot;
          }
        }
        if (best && bestD <= PICKUP_RADIUS) pickupBomb(G.bomb, best.id);
      }
    }

    stepGrenade(dt);
    if (G.phase !== 'live') return;

    // Bots.
    G.bots.update(dt, {
      player: {
        x: G.player.x, z: G.player.z, y: G.player.y,
        hp: G.hp, alive: G.alive, crouched: G.player.crouched,
        speed: speedOf(G.player),
      },
      bomb: G.bomb,
      phase: G.phase,
      planSite: G.planSite,
    });
    if (G.phase !== 'live') return;
    checkRoundEnd();
  }

  // HUD snapshot: everything the browser loop needs, in one object.
  function hudState() {
    const def = currentDef(G.weapons);
    const site = G.bomb.state === 'planted' ? SITES[G.bomb.site] : null;
    let bombText = null;
    if (G.bomb.state === 'planted') {
      bombText = `BOMB PLANTED — ${site ? site.name : ''} — ${Math.max(0, Math.ceil(G.bomb.fuse))}s`;
    } else if (G.bomb.state === 'carried' && G.bomb.carrier === 'player') {
      bombText = 'YOU CARRY THE BOMB';
    } else if (G.bomb.state === 'dropped') {
      bombText = 'BOMB DROPPED — PICK IT UP';
    }
    let hint = '';
    if (G.phase === 'buy') {
      hint = G.buyOpen ? 'Keys 1–6 buy • B closes the menu' : 'Press B for the buy menu';
    } else if (G.phase === 'live' && G.alive) {
      if (G.bomb.state === 'carried' && G.bomb.carrier === 'player') {
        const s = siteAt(G.player.x, G.player.z);
        hint = s ? 'Hold E to plant the bomb' : `Carry the bomb to ${G.planSite === 'A' ? 'Crane Bay' : 'Silo Row'} (A) or ${G.planSite === 'A' ? 'Silo Row' : 'Crane Bay'} (B)`;
      } else if (G.bomb.state === 'planted') {
        hint = 'Defend the planted bomb';
      } else if (G.bomb.state === 'dropped') {
        hint = 'The bomb is on the ground — walk over it';
      } else {
        hint = 'Eliminate Slate, or plant the bomb';
      }
    } else if (G.phase === 'live' && !G.alive) {
      hint = 'You are down — your team fights on';
    }
    return {
      hp: G.hp,
      armor: G.weapons.armor,
      mag: G.weapons.mag[G.weapons.current] || 0,
      reserve: G.weapons.reserve[G.weapons.current] || 0,
      weaponName: def.name,
      grenades: G.weapons.grenades,
      money: G.econ.money,
      scoreE: G.score.ember,
      scoreS: G.score.slate,
      timer: G.timer,
      phase: G.phase,
      bombText,
      channel: G.channel,
      buyOpen: G.buyOpen && G.phase === 'buy',
      buyItems: buyItems(),
      spread: spreadFor(def, speedOf(G.player), G.scoped),
      hint,
      banner: G.banner,
      round: G.round,
      alive: G.alive,
      matchWinner: G.matchWinner,
    };
  }

  const sim = {
    G, startMatch, startRound, beginLive, endRound, detonate,
    checkRoundEnd, damagePlayer, damageBotRecord, throwGrenade,
    buyAction, step, hudState, stepGrenade, applyBlast,
  };
  return sim;
}

// ---------------------------------------------------------------------------
// Browser boot (guarded: importing this module in Node runs none of this)
// ---------------------------------------------------------------------------

if (typeof document !== 'undefined') {
  boot();
}

function boot() {
  const params = new URLSearchParams(window.location.search);
  const shotKind = params.get('shot');
  const seed = parseInt(params.get('seed') || '1', 10) || 1;
  const shotMode = !!shotKind;

  const canvasHost = document.getElementById('game');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.id = 'gl';
  canvasHost.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 200);
  camera.rotation.order = 'YXZ';
  scene.add(camera);

  const world = createWorld(scene);
  const fx = createEffects(scene);
  const audio = createAudio();
  const hud = createHud(document);
  const input = createInput();
  input.attach(renderer.domElement);

  // Brighter staging light for the start cover (fix 5): the yard must read
  // behind the title. Shot pages load fresh, so this never leaks into live.
  let hemiBoost = 1;
  if (shotMode && shotKind === 'start') hemiBoost = 1.35;

  const hooks = {
    feed: (k, v, head) => hud.feed(k, v, head),
    shot: (from, to, kind) => {
      fx.tracer(from, to);
      if (kind === 'player') audio.shot(sim.G.weapons.current, 0);
      else {
        const d = Math.hypot(sim.G.player.x - from.x, sim.G.player.z - from.z);
        audio.enemyShot(d);
      }
    },
    explosion: (pos) => {
      fx.explosionAt(pos);
      audio.explosion();
    },
    bounce: () => audio.bounce(),
    hurt: () => audio.hurt(),
    hitmark: (head, kill) => hud.hitmarker(kill),
    killChime: () => audio.kill(),
    hitSound: (head) => audio.hit(head),
    dry: () => audio.dry(),
    reloadSound: () => audio.reload(),
    buySound: () => audio.buy(),
    denySound: () => audio.deny(),
    beep: (final) => audio.beep(final),
    sting: (win) => audio.sting(win),
    damageFlash: () => hud.damageFlash(),
    worldHit: (ox, oy, oz, dx, dy, dz, maxDist) =>
      rayWorldDist(world.losMeshes, ox, oy, oz, dx, dy, dz, maxDist),
  };

  let sim = createSim({ rng: Math.random, mapData: world, hooks });

  // Viewmodel: a simple dark gun in the lower-right of the frame.
  const gun = new THREE.Group();
  const gunMat = new THREE.MeshStandardMaterial({ color: 0x6b5d43, roughness: 0.7, metalness: 0.3 });
  const gunBody = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.13, 0.55), gunMat);
  const gunBarrel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.3), gunMat);
  gunBarrel.position.set(0, 0.03, -0.4);
  const gunSight = new THREE.Mesh(
    new THREE.BoxGeometry(0.015, 0.035, 0.015),
    new THREE.MeshStandardMaterial({ color: 0xf08a2e, roughness: 0.5 }),
  );
  gunSight.position.set(0, 0.085, -0.15);
  gun.add(gunBody, gunBarrel, gunSight);
  gun.position.set(0.28, -0.28, -0.55);
  camera.add(gun);

  // The frag grenade is a visible amber sphere mid-flight (fix 1).
  const grenadeMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 14, 10),
    new THREE.MeshBasicMaterial({ color: 0xf08a2e }),
  );
  grenadeMesh.visible = false;
  scene.add(grenadeMesh);

  // The bomb: a dark box with an amber face, shown dropped or planted.
  const bombMesh = new THREE.Group();
  const bombBox = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 0.24, 0.28),
    new THREE.MeshStandardMaterial({ color: 0x2e2a24, roughness: 0.6 }),
  );
  const bombFace = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, 0.1, 0.1),
    new THREE.MeshBasicMaterial({ color: 0xf08a2e }),
  );
  bombFace.position.set(0, 0.05, 0.15);
  bombMesh.add(bombBox, bombFace);
  bombMesh.visible = false;
  scene.add(bombMesh);

  let botMeshes = new Map();
  function refreshBotMeshes() {
    for (const mesh of botMeshes.values()) scene.remove(mesh);
    botMeshes = new Map();
    for (const bot of sim.G.bots.bots) {
      const mesh = buildBotMesh(bot);
      scene.add(mesh);
      bot.mesh = mesh;
      botMeshes.set(bot.id, mesh);
    }
  }

  function syncScene() {
    const p = sim.G.player;
    const eye = eyeHeight(p);
    camera.position.set(p.x, eye, p.z);
    if (sim.G.shake > 0) {
      camera.position.x += (Math.random() * 2 - 1) * sim.G.shake * 0.12;
      camera.position.y += (Math.random() * 2 - 1) * sim.G.shake * 0.12;
      sim.G.shake = Math.max(0, sim.G.shake - 0.03);
    }
    camera.rotation.y = p.yaw;
    camera.rotation.x = p.pitch;
    const wantFov = sim.G.scoped ? 32 : 74;
    if (camera.fov !== wantFov) {
      camera.fov = wantFov;
      camera.updateProjectionMatrix();
    }
    gun.visible = sim.G.alive && (sim.G.phase === 'live' || sim.G.phase === 'buy');
    gun.position.y = -0.28 + Math.sin(sim.G.time * 8) * 0.004 * speedOf(p);
    for (const bot of sim.G.bots.bots) {
      const mesh = botMeshes.get(bot.id);
      if (!mesh) continue;
      mesh.position.set(bot.x, 0, bot.z);
      mesh.rotation.y = bot.yaw;
      if (!bot.alive) {
        const k = Math.min(1, bot.deathT / 0.35);
        mesh.rotation.x = -1.45 * k;
        if (bot.fadeT > 5) {
          const op = Math.max(0, 1 - (bot.fadeT - 5));
          mesh.traverse((m) => {
            if (m.material) {
              m.material.transparent = true;
              m.material.opacity = op;
            }
          });
        }
      } else {
        mesh.rotation.x = 0;
      }
    }
    const g = sim.G.grenade;
    grenadeMesh.visible = g.active;
    if (g.active) grenadeMesh.position.set(g.x, g.y, g.z);
    const b = sim.G.bomb;
    if (b.state === 'dropped') {
      bombMesh.visible = true;
      bombMesh.position.set(b.x, 0.15, b.z);
    } else if (b.state === 'planted') {
      bombMesh.visible = true;
      bombMesh.position.set(b.x, 0.15, b.z);
    } else {
      bombMesh.visible = false;
    }
  }

  // The HUD syncs once per rendered frame, after the simulation steps —
  // the timer, crosshair gap and bomb countdown must move in normal play.
  function syncHud() {
    const s = sim.hudState();
    // The HUD belongs to play, not to the menu: hide it behind the title.
    const hudRoot = document.getElementById('hud');
    if (hudRoot) hudRoot.style.display = s.phase === 'menu' ? 'none' : 'block';
    hud.setHealth(s.hp);
    hud.setArmor(s.armor);
    hud.setAmmo(s.mag, s.reserve, s.weaponName);
    hud.setGrenades(s.grenades);
    hud.setMoney(s.money);
    hud.setScore(s.scoreE, s.scoreS);
    hud.setTimer(s.timer, s.phase);
    hud.setBombBanner(s.bombText);
    hud.setChannel(
      s.channel ? (s.channel.kind === 'plant' ? 'PLANTING BOMB' : 'DEFUSING') : null,
      s.channel ? s.channel.frac : null,
    );
    hud.setHint(s.hint);
    hud.setBuyMenu(s.buyItems, s.buyOpen);
    hud.setCrosshairGap(5 + s.spread * 1400);
    if (s.banner) hud.showRoundBanner(s.banner.title, s.banner.sub);
    else hud.hideRoundBanner();
    if (shotMode) return; // staging owns the overlays in shot mode
    if (s.phase === 'menu') hud.showOverlay('start');
    else if (s.phase === 'matchEnd') {
      const title = s.matchWinner === 'ember' ? 'EMBER WINS THE MATCH' : 'SLATE WINS THE MATCH';
      hud.showOverlay('match', title, `Final score — Ember ${s.scoreE} : ${s.scoreS} Slate`);
    } else if (paused) hud.showOverlay('pause');
    else if (s.phase === 'live' && !s.alive) hud.showOverlay('down');
    else hud.showOverlay(null);
  }

  let started = false;
  let paused = false;
  let prevFiring = false;

  function frameInput(first) {
    const look = first ? input.consumeLook() : { dx: 0, dy: 0 };
    const firePressed = input.firing && !prevFiring;
    let buyKey = 0;
    let switchId = null;
    if (first) {
      for (let i = 1; i <= 6; i++) {
        if (input.consumePressed(`Digit${i}`)) buyKey = i;
      }
      const ids = ['pistol', 'smg', 'rifle', 'dmr'];
      if (buyKey >= 1 && buyKey <= 4) switchId = ids[buyKey - 1];
    }
    return {
      lookDX: look.dx,
      lookDY: look.dy,
      forward: input.keys.has('KeyW'),
      back: input.keys.has('KeyS'),
      left: input.keys.has('KeyA'),
      right: input.keys.has('KeyD'),
      jump: first ? input.consumeJump() : false,
      crouch: input.keys.has('KeyC') || input.keys.has('ControlLeft'),
      slow: input.keys.has('ShiftLeft') || input.keys.has('ShiftRight'),
      fire: input.firing,
      firePressed,
      scope: input.scoping,
      reload: first ? input.consumePressed('KeyR') : false,
      grenade: first ? input.consumePressed('KeyG') : false,
      buyToggle: first ? input.consumePressed('KeyB') : false,
      buyKey,
      switchId,
      cycle: first ? input.consumePressed('KeyQ') : false,
      plantHeld: input.keys.has('KeyE'),
    };
  }

  let lastT = performance.now();
  let acc = 0;
  let lastBots = null;
  function loop(now) {
    requestAnimationFrame(loop);
    const frameDt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    const phase = sim.G.phase;
    paused = started && !input.locked && !shotMode
      && (phase === 'live' || phase === 'buy');
    if (!paused && phase !== 'menu' && phase !== 'matchEnd') {
      acc += frameDt;
      let first = true;
      let steps = 0;
      while (acc >= STEP && steps < 5) {
        sim.step(STEP, frameInput(first));
        first = false;
        acc -= STEP;
        steps += 1;
      }
      if (steps === 5) acc = 0;
    } else {
      // Still drain the input queues every frame, or a stale look delta
      // would whip the camera on the first live frame.
      input.consumeLook();
      input.consumeJump();
    }
    input.endFrame();
    prevFiring = input.firing;
    // A new round respawns the bots (new array identity) — rebuild meshes.
    if (sim.G.bots.bots !== lastBots) {
      lastBots = sim.G.bots.bots;
      refreshBotMeshes();
    }
    syncHud();
    syncScene();
    fx.step(frameDt);
    renderer.render(scene, camera);
    if (!window.__gameReady) window.__gameReady = true;
  }

  // ---- Overlays -----------------------------------------------------------
  document.getElementById('startBtn').addEventListener('click', () => {
    audio.ensure();
    input.lock();
    if (!started) {
      started = true;
      sim.startMatch();
      refreshBotMeshes();
      hud.clearFeed();
    }
  });
  document.getElementById('resumeBtn').addEventListener('click', () => {
    audio.ensure();
    input.lock();
  });
  document.getElementById('againBtn').addEventListener('click', () => {
    audio.ensure();
    input.lock();
    sim.startMatch();
    refreshBotMeshes();
    hud.clearFeed();
  });
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Enter' && sim.G.phase === 'menu' && !started) {
      document.getElementById('startBtn').click();
    }
    if (e.code === 'Enter' && sim.G.phase === 'matchEnd') {
      document.getElementById('againBtn').click();
    }
  });
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ---- Shot staging -------------------------------------------------------
  // Deterministic scenes for screenshots. Each shot URL loads fresh, stages
  // the sim, renders twice frozen, and sets window.__shotReady.
  function stageShot(kind) {
    const r = mulberry32(seed);
    sim = createSim({ rng: r, mapData: world, hooks });
    const G = sim.G;
    const botById = (id) => G.bots.botById(id);
    const teleport = (bot, x, z, yaw) => {
      bot.x = x;
      bot.z = z;
      bot.yaw = yaw;
      bot.path = [];
      bot.state = 'hold';
      bot.holdYaw = yaw;
    };

    if (kind === 'start') {
      sim.startMatch();
      G.phase = 'menu';
      G.banner = null; // the round banner must not overlap the title panel
      refreshBotMeshes();
      // Brighter yard behind the lighter title panel.
      const sun = world.group.children.find((o) => o.isDirectionalLight && o.intensity > 2);
      if (sun) sun.intensity = 3.4;
      hud.showOverlay('start');
      syncHud();
      syncScene();
      renderer.render(scene, camera);
      renderer.render(scene, camera);
    } else if (kind === 'play') {
      sim.startMatch();
      sim.startRound(3);
      // Fund the staged rifle buy BEFORE setting the staged money: the
      // round economy starts at $800 and a $2,700 buy would silently fail.
      G.econ.money = 5000;
      sim.buyAction(3);
      sim.beginLive();
      G.score = { ember: 2, slate: 1 };
      G.timer = 62;
      G.player.x = 0;
      G.player.z = 2;
      G.player.yaw = 0;
      G.player.pitch = 0;
      teleport(botById('slate-1'), 2, -3, Math.PI); // Brine, mid
      teleport(botById('slate-0'), -3, -5, Math.PI); // Ash, mid-left
      teleport(botById('slate-2'), 0, -7.5, Math.PI); // Cinder, crosshair
      // Two real kills, staged by actual damage calls.
      sim.damageBotRecord(botById('slate-1'), 200, false, 'player');
      sim.damageBotRecord(botById('slate-0'), 200, false, 'ember-0');
      botById('slate-1').deathT = 0.4;
      botById('slate-0').deathT = 0.4;
      // Staged values are set AFTER the scripted shots and kill rewards,
      // or the rewards would change them.
      G.econ.money = 4100;
      G.weapons.mag.rifle = 24;
      G.weapons.reserve.rifle = 90;
      G.hp = 78;
      G.weapons.grenades = 1;
      G.score = { ember: 2, slate: 1 };
      G.timer = 62;
      G.banner = null;
      refreshBotMeshes();
      syncHud();
      syncScene();
      renderer.render(scene, camera);
      renderer.render(scene, camera);
    } else if (kind === 'fight') {
      sim.startMatch();
      sim.startRound(2);
      G.econ.money = 5000;
      sim.buyAction(5); // a grenade to throw
      sim.beginLive();
      G.score = { ember: 1, slate: 0 };
      G.timer = 70;
      G.player.x = 20.5;
      G.player.z = 4;
      G.player.yaw = Math.atan2(3.5, 16); // facing Silo Row
      G.player.pitch = -0.02;
      teleport(botById('slate-2'), 13, -4.5, Math.PI * 0.75); // Cinder, west of the B-long container, visible past its edge
      teleport(botById('slate-3'), 20.5, -8, Math.PI * 0.75); // Flint, up the B-long lane
      sim.throwGrenade();
      // Freeze the frag mid-flight in the open lane toward Silo Row, where
      // the camera can actually see it (behind the container it vanishes).
      G.grenade.x = 18.5;
      G.grenade.y = 2.2;
      G.grenade.z = 0.5;
      G.grenade.vx = -2;
      G.grenade.vy = 1;
      G.grenade.vz = -6;
      G.econ.money = 3500;
      G.banner = null; // the banner must not linger over live play
      refreshBotMeshes();
      syncHud();
      syncScene();
      renderer.render(scene, camera);
      renderer.render(scene, camera);
    } else if (kind === 'end') {
      sim.startMatch();
      sim.startRound(4);
      sim.beginLive();
      // endRound() adds the winning point, so stage 2–1 first: the banner
      // then reads the real final score, EMBER 3–1 SLATE.
      G.score = { ember: 2, slate: 1 };
      G.bomb.state = 'planted';
      G.bomb.site = 'A';
      G.bomb.x = -17;
      G.bomb.z = -12;
      G.bomb.fuse = 0;
      sim.endRound('ember', 'The bomb went off — the fuse ran out at Crane Bay');
      G.bomb.state = 'done'; // detonated: no "planted" chip beside the win banner
      // Player at Crane Bay with a fallen Slate bot centred in frame.
      G.player.x = -15.5;
      G.player.z = -4.5;
      G.player.yaw = 0;
      G.player.pitch = -0.05;
      teleport(botById('slate-0'), -16, -8, Math.PI * 0.5);
      sim.damageBotRecord(botById('slate-0'), 200, false, 'player');
      botById('slate-0').deathT = 0.4;
      refreshBotMeshes();
      syncHud();
      syncScene();
      renderer.render(scene, camera);
      renderer.render(scene, camera);
    }
    window.__shotReady = true;
  }

  // ---- Go -----------------------------------------------------------------
  if (shotMode) {
    if (hemiBoost !== 1) {
      // Start cover: brighten the hemisphere fill so the yard reads.
      world.group.children.forEach((o) => {
        if (o.isHemisphereLight) o.intensity = 1.25;
      });
    }
    stageShot(shotKind);
  } else {
    sim.startMatch();
    refreshBotMeshes();
    sim.G.phase = 'menu';
    requestAnimationFrame(loop);
  }
}
