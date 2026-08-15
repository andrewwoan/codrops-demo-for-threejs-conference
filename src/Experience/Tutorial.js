import gsap from "gsap";
import { Experience } from "./Experience";

/**
 * The controls card — a scrap of paper pinned up while the visitor works out
 * what the board does, and gone the moment they touch anything.
 *
 * Shown once the preloader has finished, never again. There is no dismiss
 * button on purpose: the first flip, click, key or scroll takes it away, so the
 * only way to keep it on screen is to not have started yet, which is exactly
 * who it is for.
 *
 * Desktop and touch get different cards because they have different controls —
 * on desktop the flippers are arrow keys and the plunger is the spacebar; on a
 * phone all three are the thumb buttons along the bottom. The touch card draws
 * the same glyphs those buttons carry, so it reads as "these ones, here"
 * rather than as an abstract legend.
 */

// Bindings this is describing live in World/Plinko/Flippers.js (ArrowLeft /
// ArrowRight) and World/Plinko/Plunger.js (Space). If those change, this card
// starts lying — there is no way to derive it from them, so they have to be
// changed together.

const icon = (paths, { fill = "none" } = {}) => `
  <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"
       focusable="false" fill="${fill}" stroke="currentColor" stroke-width="1.9"
       stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

const ARROW_LEFT = icon(`<path d="M14.5 5.5 8 12l6.5 6.5" />`);
const ARROW_RIGHT = icon(`<path d="M9.5 5.5 16 12l-6.5 6.5" />`);

// The spacebar, drawn the way the ␣ glyph is: a rule with the ends turned down.
const SPACE_BAR = icon(`<path d="M5 10v4M19 10v4M5 14h14" />`);

// Dropping a ball is the one hint whose glyph is the input device rather than
// a control on screen — there is no button for it, you click the board itself.
const CURSOR = icon(
  `<path d="M6 3.6 6 16.4l3.4-3.1 2.1 4.9 2.3-1-2-4.7 4.6-.2z" />`,
  { fill: "currentColor" },
);

// A fingertip with the tap ringing out from under it.
const TAP = icon(`
  <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
  <path d="M7.2 7.2a6.8 6.8 0 0 0 0 9.6" />
  <path d="M16.8 16.8a6.8 6.8 0 0 0 0-9.6" />`);

// Solid triangles, matching the glyphs on the thumb buttons themselves.
const TRIANGLE_LEFT = icon(`<path d="M15 5.5 7.5 12 15 18.5z" />`, {
  fill: "currentColor",
});
const TRIANGLE_RIGHT = icon(`<path d="M9 5.5 16.5 12 9 18.5z" />`, {
  fill: "currentColor",
});
const TRIANGLE_UP = icon(`<path d="M12 6.5 18.5 16.5h-13z" />`, {
  fill: "currentColor",
});

// Anything the visitor does deliberately. `mousemove` is deliberately absent:
// the camera drifts with the pointer, so a card that vanished on mouse movement
// would never be read on a desktop at all.
const DISMISS_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"];

export class Tutorial {
  constructor() {
    this.experience = Experience.getInstance();
    this.touch = this.experience.device?.isMobileDevice ?? false;

    this.wrapper =
      document.getElementById("experience-wrapper") ?? document.body;

    this.dismissed = false;
    this.build();
  }

  /**
   * @returns [{ keys: [markup], label }] for whichever device this is, in the
   * order a first-time visitor needs them: get a ball on the board, keep it
   * alive, then put it back into play.
   */
  get rows() {
    if (this.touch) {
      return [
        { keys: [TAP], label: "Tap to drop" },
        { keys: [TRIANGLE_LEFT, TRIANGLE_RIGHT], label: "Flippers" },
        { keys: [TRIANGLE_UP], label: "Hold to launch" },
      ];
    }

    return [
      { keys: [CURSOR], label: "Click to drop" },
      { keys: [ARROW_LEFT, ARROW_RIGHT], label: "Flippers" },
      { keys: [SPACE_BAR], label: "Hold to launch", wide: true },
    ];
  }

  build() {
    this.element = document.createElement("div");
    this.element.className = `tutorial${this.touch ? " tutorial--touch" : ""}`;
    // A note, not a control: it must never swallow a click meant for the board
    // — the same click is what dismisses it.
    this.element.setAttribute("role", "note");

    for (const { keys, label, wide } of this.rows) {
      const row = document.createElement("div");
      row.className = "tutorial__row";

      const group = document.createElement("div");
      group.className = "tutorial__keys";
      group.innerHTML = keys
        .map(
          (glyph) =>
            `<span class="tutorial__key${wide ? " tutorial__key--wide" : ""}">${glyph}</span>`,
        )
        .join("");

      const text = document.createElement("span");
      text.className = "tutorial__label";
      text.textContent = label;

      row.append(group, text);
      this.element.appendChild(row);
    }

    this.wrapper.appendChild(this.element);
  }

  /**
   * Called when the preloader is out of the way. The dismiss listeners are
   * attached here rather than in the constructor: the press that dismissed the
   * preloader would otherwise take this with it, and the card would flash past
   * on the way out of a screen nobody had finished reading.
   */
  show() {
    if (this.dismissed) return;

    this.onInteract = () => this.dismiss();
    for (const type of DISMISS_EVENTS) {
      // Capture, so a press consumed by a button (a flipper, the sound switch)
      // still counts as having interacted. Passive: this only ever watches.
      window.addEventListener(type, this.onInteract, {
        capture: true,
        passive: true,
      });
    }

    gsap.fromTo(
      this.element,
      { opacity: 0, y: 10 },
      { opacity: 1, y: 0, duration: 0.5, ease: "power2.out" },
    );
  }

  dismiss() {
    if (this.dismissed) return;
    this.dismissed = true;
    this.removeListeners();

    gsap.to(this.element, {
      opacity: 0,
      y: 6,
      duration: 0.35,
      ease: "power2.in",
      onComplete: () => this.element.remove(),
    });
  }

  removeListeners() {
    if (!this.onInteract) return;
    for (const type of DISMISS_EVENTS) {
      window.removeEventListener(type, this.onInteract, { capture: true });
    }
    this.onInteract = null;
  }

  destroy() {
    this.removeListeners();
    this.element.remove();
  }
}
