import * as THREE from "three/webgpu";
import { Experience } from "./Experience";

/**
 * How far a finger may travel and still count as a tap, in CSS pixels. No tap
 * is perfectly still — a thumb rolls a few pixels on the way down — and every
 * one of those pixels arrives as a `touchmove`. Anything inside this radius is
 * the hand holding steady, not a gesture.
 */
export const TAP_SLOP = 10;

/**
 * Two pointer positions, both in normalised device coordinates.
 *
 * They differ only on touch, and only for a tap:
 *
 *   instance — where the pointer IS. Updated by every input, taps included,
 *              because a raycast has to know where the tap landed.
 *   drag     — where the pointer has been DRAGGED to. Never moved by a tap.
 *
 * On a mouse the distinction is meaningless — moving the cursor is the only way
 * to point at anything — so both track together. On touch, pointing and moving
 * are the same event, and anything that follows the pointer for feel rather
 * than for picking (the camera parallax) wants the second one: a tap to drop a
 * ball should not also swing the camera.
 *
 * The split only holds if a tap can be told from a drag, which is what
 * `TAP_SLOP` is for. Without it the jitter of an ordinary tap counts as a drag,
 * `drag` snaps to the finger, and the camera slides away underneath it between
 * touchstart and the click that drops the ball — so the ball lands off to the
 * side of where it was aimed.
 */
export class Mouse {
  constructor() {
    this.experience = Experience.getInstance();

    this.instance = new THREE.Vector2(0, 0);
    this.drag = new THREE.Vector2(0, 0);

    // Where the current touch went down, in client pixels, and whether it has
    // since cleared the slop. Once it has, the whole rest of the gesture is a
    // drag — a finger that comes to rest mid-swipe hasn't changed its mind.
    this.touchOrigin = null;
    this.dragging = false;

    this.init();
  }

  init() {
    const write = (clientX, clientY, ...targets) => {
      const x = (clientX / window.innerWidth) * 2 - 1;
      const y = -(clientY / window.innerHeight) * 2 + 1;
      for (const target of targets) target.set(x, y);
    };

    window.addEventListener("mousemove", (event) => {
      write(event.clientX, event.clientY, this.instance, this.drag);
    });

    window.addEventListener(
      "touchmove",
      (event) => {
        const touch = event.touches[0];
        if (!touch) return;

        if (!this.dragging && this.touchOrigin) {
          const dx = touch.clientX - this.touchOrigin.x;
          const dy = touch.clientY - this.touchOrigin.y;
          this.dragging = Math.hypot(dx, dy) > TAP_SLOP;
        }

        write(touch.clientX, touch.clientY, this.instance);
        if (this.dragging) write(touch.clientX, touch.clientY, this.drag);
      },
      { passive: true },
    );

    // Picking only. A tap has to place the ray, but must not shift anything
    // that follows the pointer for feel.
    window.addEventListener(
      "touchstart",
      (event) => {
        const touch = event.touches[0];
        if (!touch) return;

        this.touchOrigin = { x: touch.clientX, y: touch.clientY };
        this.dragging = false;

        write(touch.clientX, touch.clientY, this.instance);
      },
      { passive: true },
    );

    const endTouch = () => {
      this.touchOrigin = null;
      this.dragging = false;
    };
    window.addEventListener("touchend", endTouch, { passive: true });
    window.addEventListener("touchcancel", endTouch, { passive: true });
  }
}
