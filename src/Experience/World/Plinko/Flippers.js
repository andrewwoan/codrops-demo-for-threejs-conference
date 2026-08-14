import * as THREE from "three/webgpu";
import { SCALE } from "./Physics.js";

/**
 * The two flippers: kinematic capsules in the physics world, and the baked
 * hitter meshes rotated to match.
 *
 * Everything about a flipper's shape is measured off its own geometry rather
 * than authored. Each mesh's object origin is already its pivot (that survived
 * the glTF export as the node's TRS), so projecting the vertices into the table
 * frame and taking the principal axis gives the rest angle, the length and the
 * thickness in one pass — and the left/right asymmetry in the model is picked
 * up rather than papered over.
 *
 * The bodies are kinematic *position-based*, not teleported: Rapier derives a
 * velocity from the pose change, which is what transfers a real impulse into
 * the ball. Setting the translation directly would make the flipper a moving
 * wall that the ball merely rests against.
 */

// Rotation sweep from rest, in degrees. Not read from the model — Blender
// custom properties need `export_extras` on the glTF export, which is off, so
// these live here and are exposed in the #debug panel for tuning.
const SWEEP_DEG = 55;
const FLIP_MS = 40;
const RETURN_MS = 90;

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class Flippers {
  constructor({ plane, meshes, gui, controls = null, audio = null }) {
    this.plane = plane;
    this.frame = plane.frame;
    this.controls = controls;
    this.audio = audio;

    // Live, so the #debug sliders actually retune the feel while you play.
    this.settings = {
      sweep: SWEEP_DEG,
      flipMs: FLIP_MS,
      returnMs: RETURN_MS,
    };

    this.flippers = meshes
      .map((mesh) => this.build(mesh))
      .filter(Boolean)
      // Left flipper first, by pivot position in the table frame.
      .sort((a, b) => a.pivot[0] - b.pivot[0]);

    // Sign of the up-stroke: the left flipper swings counter-clockwise about
    // the playfield normal, the right one clockwise.
    this.flippers.forEach((flipper, i) => {
      flipper.direction = i === 0 ? 1 : -1;
    });

    this.bindInput();
    this.setupGUI(gui);
  }

  build(mesh) {
    mesh.updateWorldMatrix(true, false);

    const pivotWorld = new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);
    const pivot = this.frame.to2D(pivotWorld);

    // Project every vertex into the table frame, relative to the pivot.
    const position = mesh.geometry.attributes.position;
    const points = [];
    for (let i = 0; i < position.count; i++) {
      _v.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      const [x, y] = this.frame.to2D(_v);
      points.push([x - pivot[0], y - pivot[1]]);
    }

    // Principal axis = the direction of the furthest vertex from the pivot.
    // For a flipper that is unambiguously the tip.
    let tip = null;
    let length = 0;
    for (const p of points) {
      const d = Math.hypot(p[0], p[1]);
      if (d > length) {
        length = d;
        tip = p;
      }
    }
    if (!tip || length < 1e-4) {
      console.warn(`[Plinko] flipper "${mesh.name}" has no measurable length.`);
      return null;
    }

    const restAngle = Math.atan2(tip[1], tip[0]);

    // Thickness = the widest the shape gets perpendicular to that axis.
    const nx = -Math.sin(restAngle);
    const ny = Math.cos(restAngle);
    let radius = 0;
    for (const p of points) {
      const d = Math.abs(p[0] * nx + p[1] * ny);
      if (d > radius) radius = d;
    }

    // The capsule spans pivot → tip, so its half-length is measured between
    // the two cap centres rather than to the very end of the geometry.
    const halfLength = Math.max((length - radius) * 0.5, 1e-3);

    const body = this.plane.createKinematicCapsule(
      pivot[0] + Math.cos(restAngle) * (halfLength + radius * 0.5),
      pivot[1] + Math.sin(restAngle) * (halfLength + radius * 0.5),
      halfLength,
      radius,
      restAngle - Math.PI / 2,
    );

    // Mesh rotation happens about the playfield normal expressed in the mesh's
    // PARENT space, since mesh.quaternion is parent-relative.
    const parentInverse = new THREE.Quaternion();
    if (mesh.parent) mesh.parent.getWorldQuaternion(parentInverse).invert();
    const axis = this.frame.normal.clone().applyQuaternion(parentInverse).normalize();

    return {
      mesh,
      body,
      pivot,
      restAngle,
      halfLength,
      radius,
      axis,
      restQuaternion: mesh.quaternion.clone(),
      angle: 0, // current offset from rest, radians
      pressed: false,
      direction: 1,
    };
  }

  bindInput() {
    // Keyboard and touch both funnel through here, so the edge test also
    // dedupes a key held down or a second finger landing on the same button.
    const set = (index, pressed) => {
      const flipper = this.flippers[index];
      if (!flipper || flipper.pressed === pressed) return;

      flipper.pressed = pressed;
      if (pressed) this.audio?.flipper();
      else this.audio?.flipperReturn();
    };

    this.onKey = (event) => {
      const down = event.type === "keydown";
      if (event.repeat) return;
      if (event.code === "ArrowLeft" || event.code === "KeyA") set(0, down);
      if (event.code === "ArrowRight" || event.code === "KeyD") set(1, down);
    };

    window.addEventListener("keydown", this.onKey);
    window.addEventListener("keyup", this.onKey);

    // Touch buttons live on the shared bar (Controls.js) so the plunger can sit
    // between the two flippers. `order` places them; the plunger takes 1.
    [
      { glyph: "◀", label: "Left flipper", order: 0 },
      { glyph: "▶", label: "Right flipper", order: 2 },
    ].forEach(({ glyph, label, order }, index) => {
      this.controls?.add({
        glyph,
        label,
        order,
        onPress: () => set(index, true),
        onRelease: () => set(index, false),
      });
    });
  }

  update(deltaMs) {
    const sweep = THREE.MathUtils.degToRad(this.settings.sweep);

    for (const flipper of this.flippers) {
      const target = flipper.pressed ? sweep : 0;
      const duration = flipper.pressed
        ? this.settings.flipMs
        : this.settings.returnMs;
      const step = (sweep * deltaMs) / duration;

      // Move toward the target at a fixed angular rate, so the up-stroke always
      // takes FLIP_MS regardless of frame rate.
      if (flipper.angle < target) {
        flipper.angle = Math.min(target, flipper.angle + step);
      } else if (flipper.angle > target) {
        flipper.angle = Math.max(target, flipper.angle - step);
      }

      this.applyPose(flipper);
    }
  }

  applyPose(flipper) {
    const angle = flipper.restAngle + flipper.angle * flipper.direction;
    const reach = flipper.halfLength + flipper.radius * 0.5;

    flipper.body.setNextKinematicTranslation({
      x: (flipper.pivot[0] + Math.cos(angle) * reach) * SCALE,
      y: (flipper.pivot[1] + Math.sin(angle) * reach) * SCALE,
    });
    flipper.body.setNextKinematicRotation(angle - Math.PI / 2);

    _q.setFromAxisAngle(flipper.axis, flipper.angle * flipper.direction);
    flipper.mesh.quaternion.copy(flipper.restQuaternion).premultiply(_q);
  }

  setupGUI(gui) {
    const folder = gui.addFolder("Plinko Flippers");
    folder.add(this.settings, "sweep", 10, 90, 1).name("sweep°");
    folder.add(this.settings, "flipMs", 10, 200, 5).name("up stroke ms");
    folder.add(this.settings, "returnMs", 20, 400, 5).name("return ms");
  }

  destroy() {
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("keyup", this.onKey);
    // The shared bar is owned by Plinko, which tears it down for everyone.
  }
}
