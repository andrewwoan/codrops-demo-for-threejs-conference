import { Experience } from "./Experience";

/**
 * The zoom lever — a routed oak plate in the bottom-right corner, with a turned
 * knob riding in its groove. Drives `Camera.zoom`, which is a projection scale
 * rather than a dolly, so sliding it can never fight the scroll transition or
 * the mouse parallax for the camera transform.
 *
 * There is no markup for this in index.html: it's built here, the way the board
 * controls are, so the DOM and the camera it drives arrive together.
 *
 * A native <input type="range"> underneath all the woodwork. Custom-drawing the
 * track and thumb is a handful of CSS rules; re-implementing keyboard steps,
 * pointer capture, touch dragging and the accessibility tree is not.
 */
export class ZoomSlider {
  constructor() {
    this.experience = Experience.getInstance();

    this.wrapper =
      document.getElementById("experience-wrapper") ?? document.body;

    // Last value written into the input, so the per-frame sync can tell an
    // actual change from the sixty times a second nothing happened.
    this.shownValue = null;

    this.build();
  }

  build() {
    const { zoom } = this.experience.camera;

    this.element = document.createElement("div");
    this.element.className = "zoom-slider";
    // On touch the thumb bar owns the bottom of the screen — sit above it, so
    // the lever isn't stacked on top of the right flipper.
    if (this.experience.device?.isMobileDevice) {
      this.element.classList.add("zoom-slider--raised");
    }

    const out = document.createElement("span");
    out.className = "zoom-slider__glyph";
    out.textContent = "−";
    out.setAttribute("aria-hidden", "true");

    const inTo = document.createElement("span");
    inTo.className = "zoom-slider__glyph";
    inTo.textContent = "+";
    inTo.setAttribute("aria-hidden", "true");

    this.input = document.createElement("input");
    this.input.type = "range";
    this.input.className = "zoom-slider__input";
    this.input.min = String(zoom.min);
    this.input.max = String(zoom.max);
    this.input.step = "0.01";
    this.input.value = String(zoom.target);
    this.input.setAttribute("aria-label", "Camera zoom");

    this.onInput = () => {
      const value = Number(this.input.value);
      this.experience.camera.setZoom(value);
      // Beat the next sync to it: the frame after an input already agrees, and
      // writing `value` back mid-drag can stutter the knob under the pointer.
      // Same 2dp form update() compares against, or "1.5" and "1.50" would
      // read as a change every time the knob stopped on a round number.
      this.shownValue = value.toFixed(2);
    };
    this.input.addEventListener("input", this.onInput);

    // The canvas drops a ball on click. That handler already filters on target,
    // but a lever is dragged across its own plate and the pointer can leave it
    // — stop the events here rather than trusting where they land.
    this.stop = (event) => event.stopPropagation();
    this.element.addEventListener("click", this.stop);
    this.element.addEventListener("pointerdown", this.stop);

    this.element.append(out, this.input, inTo);
    this.wrapper.appendChild(this.element);
  }

  /**
   * Pulls the knob back in line with the camera. The slider is not the only
   * thing that can move the zoom — the debug panel writes it, and "Reset to
   * Default" snaps it home — so the input follows `target` rather than owning
   * it. Reads `target`, not `value`: the knob should sit where the zoom is
   * going, not crawl along behind the easing.
   */
  update() {
    const target = this.experience.camera.zoom.target.toFixed(2);
    if (target === this.shownValue) return;

    this.shownValue = target;
    this.input.value = target;
  }

  destroy() {
    this.input.removeEventListener("input", this.onInput);
    this.element.removeEventListener("click", this.stop);
    this.element.removeEventListener("pointerdown", this.stop);
    this.element.remove();
  }
}
