/**
 * One Rapier 2D world, bound to one of the board's planes.
 *
 * The game is two of these: the vertical peg board and the raked playfield.
 * Neither needs 3D — the ball never leaves its surface — and 2D buys roughly an
 * order of magnitude in step cost, which is what makes a poolful of balls with
 * continuous collision detection viable on a phone.
 *
 * Coordinates are the Frame's 2D space (see Extract.js) multiplied by SCALE.
 * Everything the solver sees is in those units; conversion back out happens in
 * Balls.js when the meshes are positioned.
 */

// Rapier's contact tolerances are tuned for metre-scale shapes. The ball is
// 0.0885 units in Blender space, small enough that default slop is a
// noticeable fraction of its radius and contacts go mushy. Scaling everything
// up by 10 on the way in puts the ball at ~0.9 and the playfield at ~44, both
// comfortably inside the range Rapier behaves well in.
export const SCALE = 10;

const GRAVITY = 9.81 * SCALE;

// Collision group bits. Rapier packs membership in the high 16 bits of a u32
// and the filter mask in the low 16, and two colliders interact only if EACH
// one's membership appears in the other's filter.
//
// Every zone owns two bits: one for its static geometry, one for the balls
// currently inside it. Balls needing their own per-zone bit is what lets two
// balls collide with each other while a ball up on the ramp still passes
// cleanly over one down on the table — in 2D they occupy the same coordinates,
// so without the split they would knock into each other through the ramp.
export const ZONE = {
  TABLE: { statics: 0b0001, balls: 0b0100 },
  ARCH: { statics: 0b0010, balls: 0b1000 },
};

const groups = (membership, filter) => ((membership << 16) | filter) >>> 0;

/** Statics see only the balls sharing their zone. */
const staticGroups = (zone) => groups(zone.statics, zone.balls);

/**
 * Balls see their zone's geometry AND the other balls in it. That second term
 * is the whole reason ball-to-ball contact happens at all.
 */
const ballGroups = (zone) => groups(zone.balls, zone.statics | zone.balls);

// Fixed timestep. Physics must not depend on frame rate — and Time.js hands out
// an unclamped delta, so one alt-tab produces a multi-second frame that would
// otherwise fire every ball straight through a wall.
const FIXED_STEP = 1 / 120;
const MAX_SUBSTEPS = 4;

// Wood, not steel. A lacquered wooden ball on a wooden board thuds and rolls —
// it does not ping around. Two things carry that read:
//
//   restitution low   — energy dies on contact instead of rebounding
//   friction high     — the ball ROLLS rather than skating across the surface,
//                       which is most of what makes it look heavy on screen
//
// The flipper keeps more restitution than anything else because it still has to
// launch the ball; a fully dead flipper just shoves.
const MATERIALS = {
  wall: { restitution: 0.12, friction: 0.35 },
  peg: { restitution: 0.2, friction: 0.3 },
  ball: { restitution: 0.08, friction: 0.4 },
  flipper: { restitution: 0.25, friction: 0.5 },
};

export class PhysicsPlane {
  /**
   * @param RAPIER        the initialised rapier2d module
   * @param frame         Frame from Extract.js — supplies the rake
   * @param gravityScale  sin(rake): 1 on the vertical board, ~0.18 on the table
   */
  constructor(RAPIER, { frame, gravityScale, name }) {
    this.RAPIER = RAPIER;
    this.frame = frame;
    this.name = name;

    // Gravity is always -Y in frame space because Frame's +Y is uphill, so the
    // rake is the only thing that differs between the two planes.
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY * gravityScale });

    this.accumulator = 0;
    this.bodies = new Set();

    // autoDrain FALSE on purpose: the queue is cleared at the start of each
    // step when auto-draining, so with several substeps per frame only the last
    // substep's contacts would survive. Accumulating and draining once per
    // frame keeps every hit.
    this.events = new RAPIER.EventQueue(false);

    // collider handle -> what it is, for the audio layer.
    this.kinds = new Map();
  }

  /**
   * Build the static geometry for one zone. Contours arrive in Frame units;
   * they get scaled here so callers never think about SCALE.
   */
  addStatics({ polylines = [], circles = [] }, zone = ZONE.TABLE) {
    const { RAPIER } = this;
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());

    for (const loop of polylines) {
      if (loop.length < 2) continue;

      const vertices = new Float32Array(loop.length * 2);
      for (let i = 0; i < loop.length; i++) {
        vertices[i * 2] = loop[i][0] * SCALE;
        vertices[i * 2 + 1] = loop[i][1] * SCALE;
      }

      const desc = RAPIER.ColliderDesc.polyline(vertices)
        .setRestitution(MATERIALS.wall.restitution)
        .setFriction(MATERIALS.wall.friction)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
        .setCollisionGroups(staticGroups(zone));

      this.kinds.set(this.world.createCollider(desc, body).handle, "wall");
    }

    for (const circle of circles) {
      const desc = RAPIER.ColliderDesc.ball(circle.radius * SCALE)
        .setTranslation(circle.x * SCALE, circle.y * SCALE)
        .setRestitution(MATERIALS.peg.restitution)
        .setFriction(MATERIALS.peg.friction)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
        .setCollisionGroups(staticGroups(zone));

      this.kinds.set(this.world.createCollider(desc, body).handle, "peg");
    }

    return body;
  }

  /**
   * A dynamic ball. CCD is on because the ball is small, the walls are thin
   * polylines with no thickness at all, and a fast drop down the board covers
   * more than its own radius in a single step.
   */
  createBall(x, y, radius, zone = ZONE.TABLE) {
    const { RAPIER } = this;

    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x * SCALE, y * SCALE)
        .setCcdEnabled(true)
        // Rapier 2D has no rolling resistance, so angular damping stands in for
        // it — without this a wooden ball spins like a ball bearing.
        .setAngularDamping(0.5)
        .setLinearDamping(0.15),
    );

    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.ball(radius * SCALE)
        .setRestitution(MATERIALS.ball.restitution)
        .setFriction(MATERIALS.ball.friction)
        // Min, not the default Average: otherwise the ball inherits half of
        // whatever it hits and one springy surface makes everything bouncy.
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
        .setCollisionGroups(ballGroups(zone)),
      body,
    );

    this.kinds.set(collider.handle, "ball");
    this.bodies.add(body);
    return { body, collider };
  }

  /**
   * Move a ball between zones. This is the ramp trick: rather than enabling and
   * disabling every collider on the table, flip the filter mask on the ball
   * itself — one write, and the broad phase does the rest for free.
   */
  setBallZone(collider, zone) {
    collider.setCollisionGroups(ballGroups(zone));
  }

  removeBall({ body, collider }) {
    if (!this.bodies.has(body)) return;
    this.bodies.delete(body);
    if (collider) this.kinds.delete(collider.handle);
    this.world.removeRigidBody(body);
  }

  /**
   * Hand every contact that STARTED this frame to `callback`, as
   * (handleA, handleB, kindA, kindB). Draining empties the queue.
   */
  drainCollisions(callback) {
    this.events.drainCollisionEvents((a, b, started) => {
      if (!started) return;
      callback(a, b, this.kinds.get(a), this.kinds.get(b));
    });
  }

  /** A kinematic body whose position is driven directly — flippers, plunger. */
  createKinematicCapsule(x, y, halfLength, radius, angle) {
    const { RAPIER } = this;

    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(x * SCALE, y * SCALE)
        .setRotation(angle),
    );

    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.capsule(halfLength * SCALE, radius * SCALE)
        .setRestitution(MATERIALS.flipper.restitution)
        .setFriction(MATERIALS.flipper.friction)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
        .setCollisionGroups(staticGroups(ZONE.TABLE)),
      body,
    );
    this.kinds.set(collider.handle, "flipper");

    return body;
  }

  /**
   * Advance the world by `deltaMs`, in fixed increments.
   *
   * Leftover time carries in the accumulator so the simulation stays smooth at
   * any frame rate; the substep cap discards the rest rather than trying to
   * catch up, which would spiral on a slow frame.
   */
  step(deltaMs) {
    this.accumulator += Math.min(deltaMs, 250) / 1000;
    this.world.timestep = FIXED_STEP;

    let steps = 0;
    while (this.accumulator >= FIXED_STEP && steps < MAX_SUBSTEPS) {
      this.world.step(this.events);
      this.accumulator -= FIXED_STEP;
      steps++;
    }

    if (steps === MAX_SUBSTEPS) this.accumulator = 0;
    return steps;
  }

  destroy() {
    this.world.free();
    this.bodies.clear();
  }
}
