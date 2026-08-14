import * as THREE from "three/webgpu";
import { SCALE } from "./Physics.js";

/**
 * The plunger — `fourth_reset_hitter`, the pull-back knob in the bottom-right
 * corner.
 *
 * Hold to draw it back, release to fire. Power comes out of the physics rather
 * than being applied as a scripted impulse: the release stroke always takes the
 * same short time, so a fuller pull covers more distance in that time, moves
 * faster, and transfers more momentum to whatever it is touching. Pull halfway
 * and you get half the speed, for free.
 *
 * The body is kinematic *position-based* for the same reason the flippers are —
 * Rapier derives a velocity from the pose change and the ball gets a real
 * impulse off it. Teleporting the collider would just make it a wall.
 *
 * Travel runs along the table frame's uphill axis, which is what the geometry
 * says: the plunger's principal axis measures 89.94° in that frame, i.e.
 * straight up the lane.
 *
 * IMPORTANT: the mesh is modelled in its FULLY DRAWN position, not at rest.
 * So the modelled pose is charge = 1, and the plunger sits `travel` forward of
 * it when idle. Treating the modelled pose as rest and drawing back from there
 * pulls it straight out through the bottom of the cabinet.
 */

// ---------------------------------------------------------------------------
// TUNING. All three are live under "Plinko Plunger" in the #debug panel — drag
// until it feels right, hit "Log Settings" to copy a paste-ready snippet, and
// replace this block with what it prints.
//
// TRAVEL      How far forward of the modelled (drawn) pose the plunger rests,
//             in Blender units. The plunger's own length is 0.413, and the
//             drawn pose is fixed by the geometry, so this only moves the
//             RESTING tip — lower sits further back down the lane.
//
// CHARGE_MS   Time to draw fully back. Longer makes partial pulls easier to
//             control.
//
// RELEASE_MS  The firing stroke. This is what sets muzzle velocity, since
//             speed is TRAVEL * charge / RELEASE_MS — so changing TRAVEL
//             changes power too, and this is the knob that compensates.
// ---------------------------------------------------------------------------
const TRAVEL = 0.25;
const CHARGE_MS = 700;
const RELEASE_MS = 45;

const _v = new THREE.Vector3();

export class Plunger {
  constructor({ plane, mesh, controls, gui, audio = null }) {
    this.plane = plane;
    this.frame = plane.frame;
    this.mesh = mesh;
    this.audio = audio;

    this.settings = {
      travel: TRAVEL,
      chargeMs: CHARGE_MS,
      releaseMs: RELEASE_MS,
    };

    // 0 = at rest (fully forward, `travel` ahead of the modelled pose),
    // 1 = fully drawn (exactly the modelled pose).
    this.charge = 0;
    this.pressed = false;
    this.firing = false;

    this.measure();
    this.bindInput(controls);
    this.setupGUI(gui);
  }

  /**
   * Shape and rest pose, measured off the mesh in table-frame coordinates —
   * same approach as the flippers, so a nudge in Blender carries through
   * without touching this file.
   */
  measure() {
    this.mesh.updateWorldMatrix(true, false);

    const position = this.mesh.geometry.attributes.position;
    const points = [];
    for (let i = 0; i < position.count; i++) {
      _v.fromBufferAttribute(position, i).applyMatrix4(this.mesh.matrixWorld);
      points.push(this.frame.to2D(_v));
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of points) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    // The modelled pose, which is the FULLY DRAWN position — not rest.
    this.drawn = [(minX + maxX) * 0.5, (minY + maxY) * 0.5];
    this.radius = (maxX - minX) * 0.5;
    // Capsule half-length is measured between cap centres, not to the tip.
    this.halfLength = Math.max((maxY - minY) * 0.5 - this.radius, 1e-3);

    // Rapier capsules run along their local +Y, and the lane axis IS the
    // frame's +Y, so no rotation is needed.
    this.body = this.plane.createKinematicCapsule(
      this.drawn[0],
      this.drawn[1],
      this.halfLength,
      this.radius,
      0,
    );

    // Mesh motion is done through world space so parent scale and rotation are
    // handled without unpicking them.
    this.drawnWorld = new THREE.Vector3().setFromMatrixPosition(
      this.mesh.matrixWorld,
    );
  }

  bindInput(controls) {
    this.onKey = (event) => {
      if (event.code !== "Space") return;
      if (event.repeat) return;
      // Space scrolls the page by default, and the canvas is fixed, but stop it
      // anyway so a future scrollable layout doesn't jump on every launch.
      event.preventDefault();
      this.pressed = event.type === "keydown";
    };

    window.addEventListener("keydown", this.onKey);
    window.addEventListener("keyup", this.onKey);

    this.button = controls?.add({
      glyph: "▲",
      label: "Plunger",
      order: 1,
      modifier: "plunger",
      onPress: () => {
        this.pressed = true;
      },
      onRelease: () => {
        this.pressed = false;
      },
    });
  }

  update(deltaMs) {
    const { travel, chargeMs, releaseMs } = this.settings;

    if (this.pressed) {
      this.firing = false;
      this.charge = Math.min(1, this.charge + deltaMs / chargeMs);
    } else if (this.charge > 0) {
      // Once, on the transition into the stroke — `charge` is still at full
      // draw here, which is what sets how big the thunk sounds.
      if (!this.firing) this.audio?.plunger(this.charge);
      this.firing = true;
      this.charge = Math.max(0, this.charge - deltaMs / releaseMs);
      if (this.charge === 0) this.firing = false;
    }

    // Measured FORWARD (uphill) from the modelled pose, which is fully drawn:
    // charge 1 sits at the modelled position, charge 0 sits `travel` ahead of
    // it. Positive throughout, so the plunger can never travel back past the
    // geometry and out through the bottom of the cabinet.
    const offset = (1 - this.charge) * travel;

    this.body.setNextKinematicTranslation({
      x: this.drawn[0] * SCALE,
      y: (this.drawn[1] + offset) * SCALE,
    });

    _v.copy(this.drawnWorld).addScaledVector(this.frame.up, offset);
    if (this.mesh.parent) this.mesh.parent.worldToLocal(_v);
    this.mesh.position.copy(_v);

    if (this.button) this.button.style.setProperty("--charge", this.charge);
  }

  setupGUI(gui) {
    const folder = gui.addFolder("Plinko Plunger");

    // Fine step: this one is hunted by eye against the lane, and 0.01 was too
    // coarse to land on. Range starts at 0 — flush with the modelled pose — so
    // the whole usable span is reachable.
    folder
      .add(this.settings, "travel", 0, 0.8, 0.005)
      .name("rest offset (fwd)")
      .listen();
    folder
      .add(this.settings, "chargeMs", 200, 2000, 25)
      .name("full draw ms")
      .listen();
    folder
      .add(this.settings, "releaseMs", 15, 200, 5)
      .name("fire stroke ms")
      .listen();

    folder
      .add({ log: () => this.logSettings() }, "log")
      .name("Log Settings");

    folder
      .add({ reset: () => this.resetSettings() }, "reset")
      .name("Reset to Defaults");
  }

  /**
   * Prints the current values as a paste-ready snippet (and copies it), so a
   * setting dialled in by eye can go straight back into the constants at the
   * top of this file. Same idea as Camera.logState().
   */
  logSettings() {
    const { travel, chargeMs, releaseMs } = this.settings;
    const speed = (travel / (releaseMs / 1000)).toFixed(2);

    const snippet = [
      `const TRAVEL = ${Number(travel.toFixed(3))};`,
      `const CHARGE_MS = ${Math.round(chargeMs)};`,
      `const RELEASE_MS = ${Math.round(releaseMs)};`,
      `// full-draw launch speed: ${speed} units/s`,
    ].join("\n");

    console.log(snippet);
    navigator.clipboard?.writeText(snippet).catch(() => {});
  }

  resetSettings() {
    this.settings.travel = TRAVEL;
    this.settings.chargeMs = CHARGE_MS;
    this.settings.releaseMs = RELEASE_MS;
  }

  destroy() {
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("keyup", this.onKey);
  }
}
