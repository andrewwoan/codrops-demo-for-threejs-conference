import { EventEmitter } from "events";
import { Experience } from "./Experience";

import gsap from "gsap";

/**
 * Preloader — the loading overlay.
 *
 * Three beats, driven off Resources:
 *   progress  → fill the bar
 *   ready     → swap the bar out for the intro copy + the two Enter buttons
 *   Enter     → fade the sheet out and hand control to the experience
 *
 * The two buttons differ only in whether sound is on afterwards. Doing it here
 * rather than behind a toggle inside the scene is what makes the board audible
 * at all: browsers refuse to play anything until the page has been clicked, and
 * this click is the one every visitor makes.
 *
 * The gap between "ready" and the Enter click is doing real work beyond copy:
 * World builds the scene synchronously on "ready", and any shader/pipeline
 * warm-up lands in the frames after that — all of it while this overlay is
 * still opaque, so the startup hitch is never on screen.
 *
 * Emits "preloaderfinished" once the overlay is gone.
 */
export class Preloader extends EventEmitter {
  constructor() {
    super();
    this.experience = Experience.getInstance();
    this.resources = this.experience.resources;

    this.preloader = document.querySelector(".preloader");
    this.progressBar = document.querySelector(".preloader__progress-bar");
    this.percentText = document.querySelector(".preloader__percent");
    this.loadingEl = document.querySelector(".preloader__loading");
    this.introEl = document.querySelector(".preloader__intro");

    // Hold any input-driven camera until Enter, so a wheel/drag over the
    // overlay doesn't move the scene behind it.
    this.experience.started = false;

    this._bindEnter("enter-audio-btn", false);
    this._bindEnter("enter-silent-btn", true);

    this.resources.on("progress", (value) => {
      this.onLoad(value);
    });

    this.resources.on("ready", () => {
      this.playOutro();
    });
  }

  /** Both Enter buttons do the same thing; they disagree only about sound. */
  _bindEnter(id, muted) {
    document
      .getElementById(id)
      ?.addEventListener("click", () => this._dismiss(muted));
  }

  onLoad(value) {
    const pct = Math.round(value * 100);
    this.progressBar.style.width = `${pct}%`;
    this.percentText.textContent = `${pct}%`;
  }

  /** Bar out, intro in — a straight swap, no fade or drift on the way in. */
  playOutro() {
    gsap.to(this.loadingEl, {
      opacity: 0,
      duration: 0.3,
      delay: 0.3,
      onComplete: () => {
        this.loadingEl.style.display = "none";
        this.introEl.style.display = "flex";
      },
    });
  }

  /** Hand over to the experience. */
  _dismiss(muted = false) {
    if (this._dismissing) return; // double-click would restart the animation
    this._dismissing = true;

    // Routed through Experience rather than at the board's Audio directly: it
    // owns the flag, so the sound nameplate in the corner starts out agreeing
    // with whichever button was pressed here.
    this.experience.setAudioMuted(muted);
    this.experience.started = true;

    gsap.to(this.preloader, {
      opacity: 0,
      duration: 0.6,
      ease: "power2.inOut",
      onComplete: () => {
        this.preloader.remove();
        this.emit("preloaderfinished");
      },
    });
  }
}
