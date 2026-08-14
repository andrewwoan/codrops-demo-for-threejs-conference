import * as THREE from "three/webgpu";
import { SCALE, ZONE } from "./Physics.js";
import { createBallMaterial } from "./BallMaterial.js";

/**
 * The ball pool, the plinko → table handoff, and the drain.
 *
 * A fixed pool, allocated once. Spawning past the cap recycles the oldest ball
 * rather than creating anything, so a player mashing the drop zone never
 * allocates and the "past the cap and the first disappears" rule falls out of
 * the FIFO order instead of needing to be enforced separately.
 *
 * Rendering is one InstancedMesh for the whole pool — a single draw call no
 * matter how many balls are live. Slots are permanent: ball `n` always owns
 * instance `n`, alive or not, so nothing has to be repacked when one drains.
 */

// Pool size, and therefore the cap: spawning past this recycles the oldest
// ball rather than allocating. Meshes and bodies are all created up front, so
// this is the peak cost, not the idle one.
const MAX_BALLS = 50;

// How much speed survives the drop off the peg board onto the playfield. The
// ball lands on a surface angled away from its fall, so most of the vertical
// component goes into the impact rather than into rolling.
const TRANSFER_DAMPING = 0.45;

// The board's fall direction is nearly perpendicular to the playfield, so only
// about 18% of the drop speed survives into down-table motion — a ball can
// arrive very nearly at rest. This floor guarantees it always sets off.
const MIN_ENTRY_SPEED = 0.6;

// Clearance below the top wall for an arriving ball, in ball radii. Landing
// flush against the wall leaves it in marginal contact where solver jitter can
// pin it.
const ENTRY_CLEARANCE = 2.5;

// Containment. Every wall is sliced on BOTH faces, so there is a cavity the
// thickness of the wall between each pair of contours. A ball that gets into
// one — tunnelled by a hard hit, or spat there off the rail — is outside the
// playfield with walls on both sides, and rides the rim forever because
// nothing in the drain check ever sees it. Anything this far outside its own
// surface has escaped, whatever the route, and gets recycled.
const OUT_OF_BOUNDS_MARGIN = 4;

// Ball-search, same idea as a real machine: a ball that has barely moved for
// this long gets nudged downhill rather than ending the game quietly.
// Shorter than a real ball-search, because the fan below needs several tries to
// work round a corner and 1.5s each made a wedged ball look abandoned.
const STUCK_MS = 700;
const STUCK_SPEED = 0.35;
// Target velocity change per nudge, in FRAME units/s.
//
// Not an impulse: applyImpulse divides by mass and works in the solver's scaled
// units, so a raw 1.2 here moved the ball by 0.049 units/s — invisible. The
// impulse is computed from the body's real mass at the call site instead.
const NUDGE_SPEED = 0.9;
// Successive nudges fan around by the golden angle so they never repeat a
// direction. A ball wedged against the arch foot had downhill blocked, and a
// nudge that always points downhill just pressed it harder into the trap.
const GOLDEN_ANGLE = 2.399963;
const MAX_NUDGE_MULTIPLIER = 3;

// --- Arch rail ------------------------------------------------------------
// A ball reaching either mouth of the arch, moving into it fast enough, leaves
// the 2D solver and becomes a bead on the rail. See ArchRail.js.
//
// Capture radius is in ball radii. The entry speed floor stops a ball that has
// merely drifted against the mouth from being sucked up it.
const RAIL_CAPTURE_RADIUS = 1.6;
const RAIL_MIN_ENTRY_SPEED = 0.8;
// Ceiling on entry speed. A flipper can hit the mouth far harder than a roll
// ever will, and without a cap the ball rockets round the arch at a speed
// nothing else on the board moves at. Clamping the ENTRY rather than damping
// the rail keeps a hard hit feeling like a hard hit, just not a silly one.
const RAIL_MAX_ENTRY_SPEED = 6;
// Guaranteed speed leaving a mouth. Both mouths sit in tight corners, and a
// ball trickling out of one with almost no speed just wedges against the
// nearest wall.
const RAIL_MIN_EXIT_SPEED = 1.4;
// Rolling resistance on the rail, per second.
const RAIL_DAMPING = 0.5;
// Grace period after being spat out, so a ball leaving one mouth slowly is not
// immediately recaptured by it.
const RAIL_RECAPTURE_MS = 300;
const RAIL_SUBSTEPS = 4;
// Gravity multiplier on the rail only.
//
// The rail is the one place the ball feels gravity's INTO-surface component
// (9.65 units/s^2 here) rather than just the along-surface one (1.78). That is
// correct physics, but the board is modelled at roughly a third of real size,
// so real g reads as a ball being fired over the arch. This scales the whole
// rail down to something that matches the pace of the rest of the table.
const RAIL_GRAVITY_SCALE = 0.55;

// Frame units per second squared. Matches Physics.js once its SCALE is undone.
const GRAVITY = 9.81;

const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _sample = {};
// InstancedMesh has no per-instance visibility flag, so a dead ball is written
// as a degenerate zero-scale matrix instead. It collapses to a point and
// rasterises nothing.
const _hidden = new THREE.Matrix4().makeScale(0, 0, 0);

// Ball spawn animation — scales up from nothing so a recycled ball reappearing
// at the top reads as arriving rather than teleporting.
const SPAWN_DURATION = 120;

export class Balls {
  constructor({
    scene,
    sourceMesh,
    radius,
    boardPlane,
    tablePlane,
    bounds,
    resources = null,
    shading = null,
    rail = null,
  }) {
    this.scene = scene;
    this.resources = resources;
    this.shading = shading;
    this.rail = rail;

    // Live, because the useful range here is narrow: a ball free-rolling the
    // length of the table arrives at roughly 3.8 units/s, and the arch needs
    // 4-5 to clear the crown. Small changes decide whether the ramp is
    // makeable off a roll or only off a flipper.
    this.railSettings = {
      minEntrySpeed: RAIL_MIN_ENTRY_SPEED,
      maxEntrySpeed: RAIL_MAX_ENTRY_SPEED,
      minExitSpeed: RAIL_MIN_EXIT_SPEED,
      damping: RAIL_DAMPING,
      captureRadius: RAIL_CAPTURE_RADIUS,
      gravity: RAIL_GRAVITY_SCALE,
    };

    // Gravity split for the rail: along the surface, and into it.
    const rake = THREE.MathUtils.degToRad(tablePlane.frame.tiltDeg);
    this.gravityAlongSurface = GRAVITY * Math.sin(rake);
    this.gravityIntoSurface = GRAVITY * Math.cos(rake);
    this.radius = radius;
    this.board = boardPlane;
    this.table = tablePlane;
    this.bounds = bounds;

    this.pool = [];
    // Spawn order, oldest first — the recycle queue.
    this.order = [];

    this.group = new THREE.Group();
    this.group.name = "PlinkoBalls";
    this.scene.add(this.group);

    this.build(sourceMesh);
  }

  /**
   * One InstancedMesh for the whole pool — every ball is the same geometry and
   * the same baked material, so they cost a single draw call between them
   * rather than one each.
   *
   * The geometry is re-centred on its own bounds because the source node
   * carries the parked position of the prop in the blend file, and instance
   * matrices need the origin at the ball's centre for a position write to put
   * it where the solver says.
   */
  build(sourceMesh) {
    const geometry = sourceMesh.geometry.clone();
    geometry.center();

    this.baseScale = new THREE.Vector3();
    sourceMesh.getWorldScale(this.baseScale);

    // A lit PBR material rather than the baked one. The balls move, so baked
    // lighting is wrong for them by definition — see BallMaterial.js.
    const built = createBallMaterial({
      resources: this.resources,
      settings: this.shading ?? {},
    });
    this.materialUniforms = built.uniforms;
    this.textured = built.textured;
    const material = built.material;

    this.instanced = new THREE.InstancedMesh(geometry, material, MAX_BALLS);
    this.instanced.name = "plinko_balls";
    this.instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // The bounding sphere would have to be recomputed every frame otherwise,
    // and the balls are always on screen anyway.
    this.instanced.frustumCulled = false;
    this.group.add(this.instanced);

    for (let i = 0; i < MAX_BALLS; i++) {
      this.instanced.setMatrixAt(i, _hidden);

      this.pool.push({
        index: i,
        plane: null, // which PhysicsPlane it currently lives in
        handle: null, // { body, collider }
        zone: ZONE.TABLE,
        spawnedAt: -Infinity,
        slowSince: null,
        // { s, v } while riding the arch, null otherwise.
        rail: null,
        railRoll: 0,
        railCooldown: 0,
        nudgeCount: 0,
        alive: false,
      });
    }

    this.instanced.instanceMatrix.needsUpdate = true;
    this.dirty = false;
  }

  /**
   * Drop a ball at `x` in board-frame coordinates, at the top of the board.
   * Recycles the oldest ball when the pool is full.
   */
  spawn(x, y, now) {
    let ball = this.pool.find((b) => !b.alive);

    if (!ball) {
      const oldestIndex = this.order.shift();
      ball = this.pool[oldestIndex];
      this.despawn(ball);
    }

    ball.plane = this.board;
    ball.zone = ZONE.TABLE;
    ball.handle = this.board.createBall(x, y, this.radius, ball.zone);
    ball.alive = true;
    ball.spawnedAt = now;
    ball.slowSince = null;
    ball.rail = null;
    ball.railRoll = 0;
    ball.railCooldown = 0;
    ball.nudgeCount = 0;

    this.order.push(ball.index);
    this.writeInstance(ball, now);

    return ball;
  }

  despawn(ball) {
    if (ball.handle && ball.plane) ball.plane.removeBall(ball.handle);
    ball.handle = null;
    ball.plane = null;
    ball.rail = null;
    ball.alive = false;

    this.instanced.setMatrixAt(ball.index, _hidden);
    this.dirty = true;

    const at = this.order.indexOf(ball.index);
    if (at !== -1) this.order.splice(at, 1);
  }

  /**
   * The handoff. The ball rolls off the bottom of the peg board and lands at
   * the back of the playfield.
   *
   * Both the position and the velocity go through world space rather than
   * being remapped by hand: the board's exit point projected into the table's
   * frame IS the entry point, because the two planes physically meet at the
   * hinge. Nothing to author, and it survives the cabinet being moved.
   */
  transfer(ball) {
    const { body } = ball.handle;
    const translation = body.translation();
    const velocity = body.linvel();

    const x = translation.x / SCALE;
    const y = translation.y / SCALE;

    const worldPoint = this.board.frame.to3D(x, y, 0);
    const worldVelocity = new THREE.Vector3()
      .addScaledVector(this.board.frame.right, velocity.x / SCALE)
      .addScaledVector(this.board.frame.up, velocity.y / SCALE);

    const [tx, ty] = this.table.frame.to2D(worldPoint);
    const vx = worldVelocity.dot(this.table.frame.right) * TRANSFER_DAMPING;
    let vy = worldVelocity.dot(this.table.frame.up) * TRANSFER_DAMPING;

    // Always leave the hinge heading downhill.
    if (vy > -MIN_ENTRY_SPEED) vy = -MIN_ENTRY_SPEED;

    this.board.removeBall(ball.handle);

    ball.plane = this.table;
    ball.zone = ZONE.TABLE;
    ball.handle = this.table.createBall(
      tx,
      Math.min(ty, this.bounds.table.maxY - this.radius * ENTRY_CLEARANCE),
      this.radius,
      ball.zone,
    );
    ball.handle.body.setLinvel({ x: vx * SCALE, y: vy * SCALE }, true);
    ball.slowSince = null;
  }

  /** Position every live mesh, and run the zone transitions. */
  update(now, deltaMs = 16) {
    const dt = Math.min(deltaMs, 100) / 1000;

    for (const ball of this.pool) {
      if (!ball.alive) continue;

      // Riding the arch: no rigid body at all, just a scalar along the curve.
      if (ball.rail) {
        this.updateRail(ball, dt, now);
        continue;
      }

      const { body } = ball.handle;
      const translation = body.translation();
      const y = translation.y / SCALE;

      if (ball.plane === this.board && y < this.bounds.board.exitY) {
        this.transfer(ball);
      } else if (ball.plane === this.table) {
        if (this.hasEscaped(ball, translation)) {
          this.despawn(ball);
          continue;
        }
        this.checkStuck(ball, now);
        if (y < this.bounds.table.drainY) {
          // Down the drain. Freeing it here is what lets the next click reuse
          // this slot instead of evicting a ball that is still in play.
          this.despawn(ball);
          continue;
        }
      }

      // Reaching a mouth of the arch fast enough hands the ball to the rail.
      if (ball.plane === this.table && this.tryCapture(ball, now)) {
        this.updateRail(ball, 0, now);
        continue;
      }

      this.writeInstance(ball, now);
    }

    if (this.dirty) {
      this.instanced.instanceMatrix.needsUpdate = true;
      this.dirty = false;
    }
  }

  /** Outside its own surface by more than the margin — it is not in play. */
  hasEscaped(ball, translation) {
    const box = this.bounds[ball.plane === this.board ? "board" : "table"].box;
    if (!box) return false;

    const margin = this.radius * OUT_OF_BOUNDS_MARGIN;
    const x = translation.x / SCALE;
    const y = translation.y / SCALE;

    return (
      x < box.minX - margin ||
      x > box.maxX + margin ||
      y < box.minY - margin ||
      y > box.maxY + margin
    );
  }

  /**
   * Hand a table ball to the rail if it has arrived at a mouth with enough
   * speed pointed into it.
   *
   * The speed test is taken ALONG the mouth's tangent, not as raw speed: a ball
   * skidding sideways past the entrance should carry on past it, and only
   * motion actually heading up the ramp counts toward getting up the ramp.
   */
  tryCapture(ball, now) {
    if (!this.rail?.valid) return false;
    if (now < ball.railCooldown) return false;

    const translation = ball.handle.body.translation();
    const velocity = ball.handle.body.linvel();
    const x = translation.x / SCALE;
    const y = translation.y / SCALE;
    const vx = velocity.x / SCALE;
    const vy = velocity.y / SCALE;

    for (const end of this.rail.ends) {
      const reach = this.radius * this.railSettings.captureRadius;
      if (Math.hypot(x - end.x, y - end.y) > reach) {
        continue;
      }

      const entrySpeed = vx * end.tx + vy * end.ty;
      if (entrySpeed < this.railSettings.minEntrySpeed) continue;

      const capped = Math.min(entrySpeed, this.railSettings.maxEntrySpeed);

      this.table.removeBall(ball.handle);
      ball.handle = null;
      ball.plane = null;
      ball.rail = { s: end.s, v: capped * end.direction };
      return true;
    }

    return false;
  }

  /**
   * One frame of bead-on-a-wire.
   *
   * The only force is gravity resolved along the tangent. Because the tangent
   * carries a height component, a climbing stretch decelerates the ball on its
   * own — run out of speed short of the top and it slides back down, which is
   * the ramp reject, for free.
   */
  updateRail(ball, dt, now) {
    const rail = this.rail;
    const step = dt / RAIL_SUBSTEPS;

    for (let i = 0; i < RAIL_SUBSTEPS && dt > 0; i++) {
      rail.sample(ball.rail.s, _sample);

      const g = this.railSettings.gravity;
      const along =
        (-this.gravityAlongSurface * _sample.ty -
          this.gravityIntoSurface * _sample.th) *
        g;

      ball.rail.v += along * step;
      ball.rail.v -= ball.rail.v * this.railSettings.damping * step;

      const ds = ball.rail.v * step;
      ball.rail.s += ds;
      ball.railRoll += ds / this.radius;

      if (ball.rail.s < 0 || ball.rail.s > rail.length) break;
    }

    if (ball.rail.s < 0 || ball.rail.s > rail.length) {
      this.releaseFromRail(ball, now);
      return;
    }

    rail.sample(ball.rail.s, _sample);
    this.writeRailInstance(ball, now, _sample);
  }

  /** Off the end of the rail and back into the 2D world. */
  releaseFromRail(ball, now) {
    const rail = this.rail;
    const atStart = ball.rail.s <= 0;
    rail.sample(atStart ? 0 : rail.length, _sample);

    // Outward from whichever mouth it left by, so it never emerges pointing
    // back into the rail it just exited.
    const dirX = atStart ? -_sample.tx : _sample.tx;
    const dirY = atStart ? -_sample.ty : _sample.ty;
    const speed = Math.max(
      Math.abs(ball.rail.v),
      this.railSettings.minExitSpeed,
    );

    // Clear of the mouth before the capture test runs again.
    const push = this.radius * 1.2;

    ball.rail = null;
    ball.railCooldown = now + RAIL_RECAPTURE_MS;
    ball.plane = this.table;
    ball.zone = ZONE.TABLE;
    ball.handle = this.table.createBall(
      _sample.x + dirX * push,
      _sample.y + dirY * push,
      this.radius,
      ball.zone,
    );
    ball.handle.body.setLinvel(
      { x: dirX * speed * SCALE, y: dirY * speed * SCALE },
      true,
    );
    ball.slowSince = null;
    ball.nudgeCount = 0;

    this.writeInstance(ball, now);
  }

  /** Instance matrix for a ball on the rail, lifted to the ridge. */
  writeRailInstance(ball, now, sample) {
    const frame = this.table.frame;
    frame.to3D(sample.x, sample.y, sample.h + this.radius, _position);

    // Roll about the axis perpendicular to travel, so it reads as rolling over
    // the arch rather than sliding along it.
    _tangent
      .copy(frame.right)
      .multiplyScalar(sample.tx)
      .addScaledVector(frame.up, sample.ty)
      .addScaledVector(frame.normal, sample.th);
    _axis.crossVectors(frame.normal, _tangent);

    if (_axis.lengthSq() < 1e-9) {
      _quaternion.identity();
    } else {
      _quaternion.setFromAxisAngle(_axis.normalize(), ball.railRoll);
    }

    this.setInstance(ball, now, _position, _quaternion);
  }

  /**
   * Ball-search. Real machines do this too: anything that stops moving for long
   * enough gets shoved rather than silently ending the game. Nudging downhill
   * along the frame's -Y also means the fix always points somewhere useful.
   */
  checkStuck(ball, now) {
    const velocity = ball.handle.body.linvel();
    const speed = Math.hypot(velocity.x, velocity.y) / SCALE;

    if (speed > STUCK_SPEED) {
      ball.slowSince = null;
      ball.nudgeCount = 0;
      return;
    }

    if (ball.slowSince === null || ball.slowSince === undefined) {
      ball.slowSince = now;
      return;
    }

    if (now - ball.slowSince < STUCK_MS) return;

    // Downhill on the first try, then fanning outward — and a little harder
    // each time, so a genuinely tight wedge still comes loose.
    const attempt = ball.nudgeCount ?? 0;
    const angle = attempt * GOLDEN_ANGLE;
    const deltaV =
      NUDGE_SPEED * Math.min(1 + attempt * 0.35, MAX_NUDGE_MULTIPLIER);

    // impulse = mass * dv, and the solver works in scaled units.
    const strength = (ball.handle.body.mass() || 1) * deltaV * SCALE;

    ball.handle.body.applyImpulse(
      {
        x: Math.sin(angle) * strength,
        y: -Math.cos(angle) * strength,
      },
      true,
    );

    ball.nudgeCount = attempt + 1;
    ball.slowSince = now;
  }

  /** Compose this ball's instance matrix from its body pose. */
  writeInstance(ball, now) {
    const { body } = ball.handle;
    const translation = body.translation();
    const frame = ball.plane.frame;

    frame.to3D(
      translation.x / SCALE,
      translation.y / SCALE,
      this.radius,
      _position,
    );

    // Roll the ball about the plane normal so it visibly spins as it travels.
    _quaternion.setFromAxisAngle(frame.normal, body.rotation());

    this.setInstance(ball, now, _position, _quaternion);
  }

  /**
   * Write one instance matrix, applying the spawn scale-in.
   *
   * Shared by the body path and the rail path — a ball riding the arch has no
   * rigid body to read a pose from, but it still needs the same growth curve
   * and the same matrix slot.
   */
  setInstance(ball, now, position, quaternion) {
    const age = now - ball.spawnedAt;
    const grow =
      age < SPAWN_DURATION
        ? (() => {
            const t = age / SPAWN_DURATION;
            return t * t * (3 - 2 * t);
          })()
        : 1;
    _scale.copy(this.baseScale).multiplyScalar(grow);

    this.instanced.setMatrixAt(
      ball.index,
      _matrix.compose(position, quaternion, _scale),
    );
    this.dirty = true;
  }

  /** Clear the board — every ball in play is removed. */
  reset() {
    for (const ball of this.pool) {
      if (ball.alive) this.despawn(ball);
    }
    this.order.length = 0;

    this.instanced.instanceMatrix.needsUpdate = true;
    this.dirty = false;
  }

  get liveCount() {
    return this.order.length;
  }

  /** The pool size, and so the point at which a drop recycles the oldest ball. */
  get capacity() {
    return this.pool.length;
  }

  destroy() {
    for (const ball of this.pool) {
      if (ball.alive) this.despawn(ball);
    }
    this.instanced.geometry.dispose();
    this.instanced.material.dispose();
    this.instanced.dispose();
    this.scene.remove(this.group);
    this.pool.length = 0;
    this.order.length = 0;
  }
}
