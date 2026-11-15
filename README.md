# EMBERLINE — 5v5 round-based tactical FPS (three.js)

A Counter-Strike-style tactical shooter that runs offline from static files
in a desktop browser. Ember (attackers, amber) vs Slate (defenders, teal)
in Ember Yard, a freight yard at dusk, 46 × 38 m.

## Play

Serve `game/` with any static server (`node serve.ts`, then open
http://127.0.0.1:8080/) and click **CLICK TO PLAY**.

## Controls

| Key | Action |
|---|---|
| WASD | Move |
| Mouse | Aim (click the game to capture the pointer) |
| Left mouse | Fire (hold for automatics) |
| R | Reload |
| B | Buy menu (buy phase only) |
| 1–4 | Buy / switch weapon (P9, Hornet, VK-7, Longbow) |
| 5 / 6 | Buy grenade / Kevlar vest |
| Q | Cycle owned weapons |
| G | Throw Sparrow frag grenade |
| E (hold) | Plant the bomb (in a site) |
| Space | Jump |
| C / Ctrl | Crouch |
| Shift | Walk slow |
| Right mouse | Scope the Longbow DMR |

## Rules

- **Rounds:** buy (12 s) → live (100 s) → round end. First to 5 rounds,
  max 9, wins the match.
- **Win a round** by eliminating the enemy team, or (Ember) by planting
  the bomb and letting the 40 s fuse run out. Slate wins by eliminating
  Ember, by the clock running out with no plant, or by defusing a planted
  bomb (5 s channel, hold E within 2.5 m — Slate bots only; the Ember
  player can never defuse their own bomb).
- **The bomb:** the player carries it at round start. Plant by holding E
  for 3 s inside a site. If the carrier dies the bomb drops; walk within
  1.4 m to pick it up — an Ember bot that picks it up carries it to the
  planned site and plants.
- **Economy:** start $800. Kill +$300, plant +$300, round win +$3,250,
  round loss +$1,900. Dying costs your loadout — next round you are back
  to the sidearm; survivors keep weapons and armor.

## Weapons

| Weapon | Damage | Head | Fire | Mag | Notes |
|---|---|---|---|---|---|
| P9 Sidearm | 26 | ×4 | Semi | 12 | Free |
| Hornet SMG | 22 | ×4 | Auto | 32 | $1,500 |
| VK-7 Rifle | 32 | ×4 | Auto | 30 | $2,700 |
| Longbow DMR | 88 | ×2 | Semi | 5 | $4,750, scoped |
| Sparrow frag | 110 max | — | Thrown | — | $300, max 2 |
| Kevlar vest | — | — | — | — | $650, 50 pts, halves damage |

Spread punishes moving, recoil punishes holding the trigger, headshots pay
— stopping to aim is the whole game.

## The map

Two sites: **A — Crane Bay** (west, crane frame) and **B — Silo Row**
(east, grain silos). Three lanes: A-long west, B-long east, mid through a
container row with a gap. Bots follow waypoint routes, hold sites, react
to what they see and hear, and investigate gunshots.

## Layout

```
game/
  index.html            one import map ("three" -> vendored three.js)
  package.json
  src/
    palette.js          the six colours
    input.js            keyboard + mouse, look queue, jump queue
    player.js           first-person movement + AABB collision
    weapons.js          gunplay: spread, recoil, reload, buy rules
    economy.js          money rules (pure)
    bomb.js             bomb state machine (pure)
    map.js              Ember Yard: colliders, nav graph, visuals, LOS
    bots.js             9 bots: vision, bursts, routes, plant/defuse
    hud.js              every DOM write, value-cached
    audio.js            procedural WebAudio, no sound files
    effects.js          pooled tracers, impacts, explosion
    main.js             one state object + fixed 60 Hz sim + boot
  vendor/three/         three.js 0.187.0, byte-for-byte from the kit
```

All sound is procedural WebAudio; all art is original geometry. No
network requests, no build step.

## License

MIT — see LICENSE.
