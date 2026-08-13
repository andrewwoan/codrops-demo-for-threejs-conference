import { EventEmitter } from "events";
import { Experience } from "./Experience";

import gsap from "gsap";

/**
 * Preloader — the loading overlay.
 *
 * Three beats, driven off Resources:
 *   progress  → fill the bar
 *   ready     → swap the bar out for the intro copy + Enter button
 *   Enter     → fade the sheet out and hand control to the experience
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

    document.getElementById("enter-btn").addEventListener("click", () => {
      this._dismiss();
    });

    this.resources.on("progress", (value) => {
      this.onLoad(value);
    });

    this.resources.on("ready", () => {
      this.playOutro();
    });
  }

  onLoad(value) {
    const pct = Math.round(value * 100);
    this.progressBar.style.width = `${pct}%`;
    this.percentText.textContent = `${pct}%`;
  }

  /** Bar out, intro in. */
  playOutro() {
    gsap.to(this.loadingEl, {
      opacity: 0,
      duration: 0.3,
      delay: 0.3,
      onComplete: () => {
        this.loadingEl.style.display = "none";
        this.introEl.style.display = "flex";
        gsap.fromTo(
          this.introEl,
          { opacity: 0, y: 8 },
          { opacity: 1, y: 0, duration: 0.45, ease: "power2.out" },
        );
      },
    });
  }

  /** Hand over to the experience. */
  _dismiss() {
    if (this._dismissing) return; // double-click would restart the animation
    this._dismissing = true;
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
