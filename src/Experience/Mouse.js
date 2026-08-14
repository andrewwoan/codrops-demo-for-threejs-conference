import * as THREE from "three/webgpu";
import { Experience } from "./Experience";

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
 */
export class Mouse {
  constructor() {
    this.experience = Experience.getInstance();

    this.instance = new THREE.Vector2(0, 0);
    this.drag = new THREE.Vector2(0, 0);

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
        write(touch.clientX, touch.clientY, this.instance, this.drag);
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
        write(touch.clientX, touch.clientY, this.instance);
      },
      { passive: true },
    );
  }
}
