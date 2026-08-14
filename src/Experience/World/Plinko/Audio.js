import { Howl, Howler } from "howler";

/**
 * Wooden sound for the board.
 *
 * Samples are Kenney's "Impact Sounds" pack (kenney.nl), CC0 1.0 Universal —
 * public domain, free for commercial use. Credit is not required by the licence
 * but is given here and in the README because it costs nothing.
 *
 * The rolling loop is not from the pack: nothing in it loops, and a rolling
 * ball is better served by a synthesised bed anyway, since it is pitch- and
 * volume-modulated at runtime from the balls' actual speed.
 *
 * It is BROWN noise squeezed into 48-300 Hz with a resonant bump at 120 Hz.
 * The first attempt used pink noise across 170-2400 Hz and sounded like air
 * conditioning — a rolling wooden ball is a low rumble, and anything with real
 * energy above about a kilohertz reads as hiss rather than as rolling. Measured
 * on the shipped file: -42 dB mean above 1 kHz against -15.8 dB below 400 Hz.
 *
 * ---------------------------------------------------------------------------
 * THROTTLING
 *
 * Fifty balls generate an enormous number of contacts — a pile settling at the
 * drain can produce hundreds a second. Played untouched that is white noise and
 * a stalled main thread. Three limits keep it musical:
 *
 *   per-kind cooldown  two peg ticks closer together than this are one tick
 *   per-frame cap      a pile-up cannot drown the ball you are watching
 *   strength gate      resting jitter is below the threshold and stays silent
 * ---------------------------------------------------------------------------
 */

const SOURCES = {
  peg: ["/audio/peg-a.mp3", "/audio/peg-b.mp3", "/audio/peg-c.mp3"],
  wall: ["/audio/wall-a.mp3", "/audio/wall-b.mp3", "/audio/wall-c.mp3"],
  ball: ["/audio/peg-b.mp3", "/audio/peg-c.mp3"],
  flipper: ["/audio/hit-a.mp3", "/audio/hit-b.mp3"],
  drop: ["/audio/drop.mp3"],

  // Mechanism sounds — the controls themselves, not the ball hitting them.
  // A flipper clacks against its stop whether or not there is a ball on it.
  flipSwing: ["/audio/flip-a.mp3", "/audio/flip-b.mp3"],
  flipReturn: ["/audio/flip-return.mp3"],
  plunge: ["/audio/plunge.mp3"],
};

// Impact speed, in frame units/s, mapped onto volume. Below the floor nothing
// plays at all — that band is contact jitter, not a hit.
const MIN_IMPACT_SPEED = 0.55;
const FULL_IMPACT_SPEED = 6;

const KIND_COOLDOWN_MS = 28;
const MAX_IMPACTS_PER_FRAME = 4;

// Rolling bed. `activity` is the sum of rolling speeds across every ball, so a
// busy board is louder than a single ball without any per-ball voices.
const ROLL_FULL_ACTIVITY = 14;
const ROLL_MAX_VOLUME = 0.28;
const ROLL_ATTACK = 6;
const ROLL_RELEASE = 2.5;

// Below this the bed is stopped outright rather than left running quietly.
// Exponential decay approaches zero without arriving, so without a floor the
// loop plays forever under the whole scene — inaudible in isolation, but a
// constant noise bed nonetheless.
const ROLL_SILENCE = 0.004;

export class Audio {
  // `muted` is passed in rather than defaulted here: the preloader's "enter
  // without audio" is chosen before this exists, and the choice has to survive
  // until the board is built.
  constructor({ volume = 0.7, muted = false } = {}) {
    this.settings = { volume, muted, rollVolume: ROLL_MAX_VOLUME };

    this.sounds = {};
    this.lastPlayed = new Map();
    this.playedThisFrame = 0;
    this.rollLevel = 0;

    Howler.volume(volume);

    for (const [kind, files] of Object.entries(SOURCES)) {
      this.sounds[kind] = files.map(
        (src) => new Howl({ src: [src], preload: true, html5: false }),
      );
    }

    // One shared voice, always running, silent until something rolls. Starting
    // it once avoids the click of repeatedly starting and stopping a loop.
    this.roll = new Howl({
      src: ["/audio/roll.mp3"],
      loop: true,
      volume: 0,
      preload: true,
      html5: false,
    });
    this.rollId = null;
    this.rollPaused = false;
  }

  /**
   * Browsers refuse audio until a gesture. Howler unlocks itself on the first
   * touch or click, and since the board needs a click to drop a ball there is
   * no separate "enable sound" step to build — this just starts the loop once
   * the context is actually running.
   */
  ensureRolling() {
    if (this.rollId !== null) return;
    if (Howler.ctx && Howler.ctx.state !== "running") return;
    this.rollId = this.roll.play();
    this.roll.volume(0, this.rollId);
    // Nothing is rolling at startup, so park it immediately.
    this.roll.pause(this.rollId);
    this.rollPaused = true;
  }

  /**
   * @param kind      "peg" | "wall" | "ball" | "flipper"
   * @param strength  impact speed in frame units/s
   */
  impact(kind, strength) {
    if (this.settings.muted) return;
    if (strength < MIN_IMPACT_SPEED) return;
    if (this.playedThisFrame >= MAX_IMPACTS_PER_FRAME) return;

    const variations = this.sounds[kind] ?? this.sounds.wall;
    if (!variations?.length) return;

    const now = performance.now();
    const last = this.lastPlayed.get(kind) ?? -Infinity;
    if (now - last < KIND_COOLDOWN_MS) return;
    this.lastPlayed.set(kind, now);
    this.playedThisFrame++;

    const t = Math.min(
      1,
      (strength - MIN_IMPACT_SPEED) / (FULL_IMPACT_SPEED - MIN_IMPACT_SPEED),
    );

    const sound = variations[(Math.random() * variations.length) | 0];
    const id = sound.play();
    // Curved so light taps stay genuinely quiet rather than merely quieter.
    sound.volume(0.15 + t * t * 0.85, id);
    // Detune per hit, so a run down the pegs does not sound like one sample
    // stuttering.
    sound.rate(0.88 + Math.random() * 0.28, id);
  }

  /**
   * Play one variation directly, bypassing the impact throttle.
   *
   * Control sounds are deliberate and already one-per-press — the throttle
   * exists to stop a fifty-ball pile-up drowning everything, and swallowing a
   * flipper the player actually pressed would feel broken.
   */
  playOne(kind, { volume = 0.5, rate = 1, jitter = 0.12 } = {}) {
    if (this.settings.muted) return;

    const variations = this.sounds[kind];
    if (!variations?.length) return;

    const sound = variations[(Math.random() * variations.length) | 0];
    const id = sound.play();
    sound.volume(volume, id);
    sound.rate(rate - jitter * 0.5 + Math.random() * jitter, id);
  }

  /** A flipper swinging up to its stop. */
  flipper() {
    this.playOne("flipSwing", { volume: 0.4, rate: 1.06, jitter: 0.14 });
  }

  /** The same flipper dropping back to rest — softer, and it should be. */
  flipperReturn() {
    this.playOne("flipReturn", { volume: 0.2, rate: 1, jitter: 0.1 });
  }

  /**
   * The plunger firing. Both volume and pitch scale with how far it was drawn,
   * so a half pull sounds like a half pull.
   */
  plunger(charge = 1) {
    const t = Math.min(1, Math.max(0, charge));
    this.playOne("plunge", {
      volume: 0.22 + t * 0.45,
      rate: 0.92 + t * 0.16,
      jitter: 0.06,
    });
  }

  /**
   * A ball entering play.
   *
   * Sits lower than an impact on purpose. It fires on every click, so it is the
   * most repeated sound on the board and the one that wears out fastest.
   */
  drop() {
    if (this.settings.muted) return;
    const sound = this.sounds.drop[0];
    const id = sound.play();
    sound.volume(0.38, id);
    sound.rate(0.95 + Math.random() * 0.15, id);
  }

  /**
   * @param activity  summed speed of everything currently rolling
   * @param deltaMs   frame delta, for the envelope
   */
  updateRolling(activity, deltaMs) {
    this.ensureRolling();
    if (this.rollId === null) return;

    const target = this.settings.muted
      ? 0
      : Math.min(1, activity / ROLL_FULL_ACTIVITY) * this.settings.rollVolume;

    // Faster to rise than to fall: a ball starting to move should be heard at
    // once, but the bed should not chatter as balls briefly stop and start.
    const rate = target > this.rollLevel ? ROLL_ATTACK : ROLL_RELEASE;
    const step = 1 - Math.exp((-rate * Math.min(deltaMs, 100)) / 1000);
    this.rollLevel += (target - this.rollLevel) * step;

    // Fully silent, not merely quiet: stop the voice so there is no noise bed
    // sitting under the scene between shots.
    if (this.rollLevel < ROLL_SILENCE && target <= 0) {
      this.rollLevel = 0;
      if (!this.rollPaused) {
        this.roll.pause(this.rollId);
        this.rollPaused = true;
      }
      return;
    }

    if (this.rollPaused) {
      this.roll.play(this.rollId);
      this.rollPaused = false;
    }

    this.roll.volume(this.rollLevel, this.rollId);
    // Rolling faster raises the pitch, the way a real one does.
    this.roll.rate(
      0.75 + Math.min(1, activity / ROLL_FULL_ACTIVITY) * 0.5,
      this.rollId,
    );
  }

  /** Called once per frame, after the collision drain. */
  endFrame() {
    this.playedThisFrame = 0;
  }

  setVolume(value) {
    this.settings.volume = value;
    Howler.volume(value);
  }

  setMuted(muted) {
    this.settings.muted = muted;
    if (muted && this.rollId !== null && !this.rollPaused) {
      this.roll.pause(this.rollId);
      this.rollPaused = true;
      this.rollLevel = 0;
    }
  }

  destroy() {
    this.roll?.unload();
    for (const variations of Object.values(this.sounds)) {
      for (const sound of variations) sound.unload();
    }
  }
}
