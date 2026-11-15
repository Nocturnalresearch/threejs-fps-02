// player.js — pure first-person movement. No DOM, no three.js: the mover
// unit-tests in Node against the same colliders the map builds.
//
// Feel: acceleration 42 on the ground (9 in the air), friction 9, gravity
// 20, jump 6.4 m/s (about a 1.02 m hop — enough to clear the mid platform),
// walk 5.2 m/s, crouch 2.4 m/s. Collision is axis-separated AABB with a
// 0.04 m lift so low edges never snag, and the ground snap uses the
// collider's top face.

export const MOVE = {
  radius: 0.34,
  height: 1.72,
  crouchHeight: 1.12,
  eye: 1.6,
  crouchEye: 1.02,
  walkSpeed: 5.2,
  crouchSpeed: 2.4,
  accel: 42,
  airAccel: 9,
  friction: 9,
  gravity: 20,
  jumpSpeed: 6.4,
  slowMult: 0.55, // Shift walk-slow
  scopedMult: 0.5, // scoped DMR
  lift: 0.04,
  pitchClamp: 1.45,
  sensitivity: 0.0022,
};

export function createPlayer(x, z, yaw = 0) {
  return {
    x, z, y: 0,
    vx: 0, vz: 0, vy: 0,
    yaw, pitch: 0,
    onGround: true,
    crouched: false,
    height: MOVE.height,
  };
}

export function eyeHeight(p) {
  return p.y + (p.crouched ? MOVE.crouchEye : MOVE.eye);
}

export function speedOf(p) {
  return Math.hypot(p.vx, p.vz);
}

// wish: {fx, fz} unit wish direction in world space (already rotated by
// yaw by the caller), jump/slow/crouch/scoped booleans. Colliders are
// {x0, z0, x1, z1, y0, y1} boxes; the player is a vertical capsule
// approximated by a radius + height.
export function stepPlayer(p, wish, colliders, dt) {
  p.crouched = !!wish.crouch;
  p.height = p.crouched ? MOVE.crouchHeight : MOVE.height;
  const maxSpeed = (p.crouched ? MOVE.crouchSpeed : MOVE.walkSpeed)
    * (wish.slow ? MOVE.slowMult : 1)
    * (wish.scoped ? MOVE.scopedMult : 1);

  const accel = p.onGround ? MOVE.accel : MOVE.airAccel;
  const tx = wish.fx * maxSpeed;
  const tz = wish.fz * maxSpeed;
  // Accelerate toward the wish velocity; friction when no input.
  const k = Math.min(1, accel * dt);
  p.vx += (tx - p.vx) * k;
  p.vz += (tz - p.vz) * k;
  if (!wish.fx && !wish.fz && p.onGround) {
    const f = Math.max(0, 1 - MOVE.friction * dt);
    p.vx *= f;
    p.vz *= f;
  }

  if (wish.jump && p.onGround) {
    p.vy = MOVE.jumpSpeed;
    p.onGround = false;
  }
  p.vy -= MOVE.gravity * dt;

  // Axis-separated moves: X, then Z, then Y, so a wall never eats the
  // other axis' motion.
  p.x = moveAxis(p, colliders, 'x', p.vx * dt);
  p.z = moveAxis(p, colliders, 'z', p.vz * dt);
  const prevY = p.y;
  p.y += p.vy * dt;
  p.onGround = false;
  if (p.vy <= 0) {
    // Ground snap: land on the highest collider top under our feet.
    const top = groundTop(p, colliders, prevY);
    if (top !== null && p.y <= top) {
      p.y = top;
      p.vy = 0;
      p.onGround = true;
    }
  }
  if (p.y < 0) {
    p.y = 0;
    p.vy = 0;
    p.onGround = true;
  }
  return p;
}

function overlapsVertically(p, c) {
  // Horizontal collision only matters when our body overlaps the box in Y,
  // with the 0.04 m lift: a top face at or below our feet + lift is a step,
  // not a wall.
  const feet = p.y + MOVE.lift;
  return c.y1 > feet && c.y0 < p.y + p.height;
}

function moveAxis(p, colliders, axis, delta) {
  if (delta === 0) return axis === 'x' ? p.x : p.z;
  let pos = axis === 'x' ? p.x : p.z;
  pos += delta;
  const r = MOVE.radius;
  for (const c of colliders) {
    if (!overlapsVertically(p, c)) continue;
    if (axis === 'x') {
      if (p.z + r > c.z0 && p.z - r < c.z1 && pos + r > c.x0 && pos - r < c.x1) {
        pos = delta > 0 ? c.x0 - r : c.x1 + r;
        p.vx = 0;
      }
    } else {
      if (p.x + r > c.x0 && p.x - r < c.x1 && pos + r > c.z0 && pos - r < c.z1) {
        pos = delta > 0 ? c.z0 - r : c.z1 + r;
        p.vz = 0;
      }
    }
  }
  return pos;
}

function groundTop(p, colliders, prevY) {
  let best = null;
  const r = MOVE.radius;
  for (const c of colliders) {
    if (p.x + r <= c.x0 || p.x - r >= c.x1) continue;
    if (p.z + r <= c.z0 || p.z - r >= c.z1) continue;
    if (c.y1 > prevY + 0.001) continue; // top must have been at/above feet
    if (best === null || c.y1 > best) best = c.y1;
  }
  return best;
}

// Yaw-relative wish direction from raw strafe/forward keys.
export function wishDir(yaw, forward, strafe) {
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  // Forward is -Z at yaw 0; right is +X at yaw 0.
  let fx = -sin * forward + cos * strafe;
  let fz = -cos * forward - sin * strafe;
  const len = Math.hypot(fx, fz);
  if (len > 1) {
    fx /= len;
    fz /= len;
  }
  return { fx, fz };
}
