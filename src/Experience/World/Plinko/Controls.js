/**
 * The on-screen controls, in two independent areas:
 *
 *   add()        thumb buttons along the bottom — flippers, plunger. TOUCH
 *                ONLY; on desktop these are keyboard-driven, so `add` returns
 *                null and no bar is ever created.
 *   addAction()  utility buttons, top right — reset. ALWAYS shown, because a
 *                keyboard shortcut nobody can see is not a control.
 *
 * Both areas are created lazily, so a page with no registered buttons carries
 * no empty containers.
 *
 * Thumb buttons are placed by flex `order` rather than insertion order, so the
 * plunger can sit between the two flippers no matter which module registers
 * first.
 */
export class Controls {
  constructor({ touch = false } = {}) {
    this.wrapper =
      document.getElementById("experience-wrapper") ?? document.body;
    this.touch = touch;

    this.bar = null;
    this.utility = null;
  }

  ensureBar() {
    if (!this.bar) {
      this.bar = document.createElement("div");
      this.bar.className = "touch-controls";
      this.wrapper.appendChild(this.bar);
    }
    return this.bar;
  }

  ensureUtility() {
    if (!this.utility) {
      this.utility = document.createElement("div");
      this.utility.className = "board-actions";
      this.wrapper.appendChild(this.utility);
    }
    return this.utility;
  }

  /**
   * @param glyph      what shows in the button
   * @param label      accessible name
   * @param order      flex order — lower is further left
   * @param modifier   optional extra class suffix, e.g. "plunger"
   * @param onPress    called on pointerdown
   * @param onRelease  called on pointerup / pointercancel
   * @returns the button element, so the caller can drive styling on it
   */
  add({ glyph, label, order = 0, modifier, onPress, onRelease }) {
    if (!this.touch) return null;

    const button = document.createElement("button");
    button.type = "button";
    button.className = `touch-btn${modifier ? ` touch-btn--${modifier}` : ""}`;
    button.setAttribute("aria-label", label);
    button.dataset.pressed = "false";
    button.style.order = String(order);
    button.textContent = glyph;

    const press = (event) => {
      event.preventDefault();
      // Without this the tap bubbles to the canvas and also drops a ball.
      event.stopPropagation();
      // Capture, so sliding a thumb off the button still delivers the
      // pointerup — otherwise the control sticks in the held position.
      button.setPointerCapture?.(event.pointerId);
      button.dataset.pressed = "true";
      onPress?.();
    };

    const release = (event) => {
      event.preventDefault();
      event.stopPropagation();
      button.dataset.pressed = "false";
      onRelease?.();
    };

    button.addEventListener("pointerdown", press);
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    // Long-press on a held control would otherwise open the context menu.
    button.addEventListener("contextmenu", (event) => event.preventDefault());

    this.ensureBar().appendChild(button);
    return button;
  }

  /**
   * A tap-once utility button, shown on every device.
   *
   * `click` rather than pointerdown: these are deliberate actions, not held
   * controls, and a reset that fired the instant a thumb grazed it would be
   * infuriating.
   */
  addAction({ label, onClick }) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "board-btn";
    button.textContent = label;

    button.addEventListener("click", (event) => {
      // Belt and braces: the canvas drop handler already filters on target,
      // but this keeps a reset from also dropping a ball.
      event.stopPropagation();
      onClick?.();
    });

    this.ensureUtility().appendChild(button);
    return button;
  }

  /**
   * A read-only display sharing the utility row with the action buttons — a
   * ball count, a score, anything that reports rather than does.
   *
   * Returns the value span, not the container, so the caller can write straight
   * to `textContent` the way it would with a button. Writing to the container
   * would take the label out with it.
   */
  addReadout({ label, value = "" }) {
    const readout = document.createElement("div");
    readout.className = "board-readout";

    const name = document.createElement("span");
    name.className = "board-readout__label";
    name.textContent = label;

    const display = document.createElement("span");
    display.className = "board-readout__value";
    display.textContent = value;

    readout.append(name, display);
    this.ensureUtility().appendChild(readout);

    return display;
  }

  destroy() {
    this.bar?.remove();
    this.utility?.remove();
    this.bar = null;
    this.utility = null;
  }
}
