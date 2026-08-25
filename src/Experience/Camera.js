import * as THREE from "three/webgpu";
import { Experience } from "./Experience";
import { TAP_SLOP } from "./Mouse";
import { OrbitControls } from "three/examples/jsm/Addons.js";

// The default shot, captured with the debug panel's "Log Camera State" button.
// `rotation` is what holds the framing now that OrbitControls is off by
// default; `target` only matters while it's toggled back on.
const DEFAULT_POSITION = [0.0112, 4.3343, 14.1853];
const DEFAULT_ROTATION = [-0.2173, -0.0038, -0.0008];
const DEFAULT_TARGET = [0.0497, 2.1504, 4.2955];

// The far end of the wheel/drag transition — progress 1. Same fov as the
// default shot, so the transition only has to interpolate the transform.
const FOCUS_POSITION = [-0.0084, 5.0437, 10.7963];
const FOCUS_ROTATION = [-0.4068, -0.0084, -0.0036];
const FOCUS_TARGET = [0.051, 2.2633, 4.3422];

export class Camera {
  constructor() {
    this.experience = Experience.getInstance();

    // OrbitControls is debug-only furniture now — the default framing above is
    // the shot. Toggled from the Camera folder in the debug panel; flip this to
    // true if you want to land in orbit mode.
    this.orbitControlsEnabled = false;

    // Mouse parallax. The camera drifts toward the pointer and turns to follow
    // it — pointer right, camera slides and looks right; same for up/down.
    // `position` is in world units, `rotation` in radians, both at full
    // deflection (pointer at the edge of the screen). `smoothing` is the
    // exponential follow rate — higher is snappier, lower is floatier.
    //
    // Desktop only. A mouse hovers, so the camera can lean toward a pointer
    // that isn't asking for anything; a finger only ever touches the glass to
    // act, and leaning away from it while it acts is what put the ball in the
    // wrong column. The drag-down transition below is untouched — that is the
    // gesture that moves the camera on a phone, and the only one.
    //
    // `vertical` only matters if this is switched back on from the debug panel
    // while on a phone: vertical drags there are scroll-shaped gestures, and
    // letting them pitch the camera as well as scrub the transition made the
    // view feel like it was sliding out from under the board.
    this.parallax = {
      enabled: !this.experience.device?.isMobileDevice,
      vertical: !this.experience.device?.isMobileDevice,
      positionX: 0.2,
      positionY: 0.25,
      rotationX: 0.04,
      rotationY: 0.03,
      smoothing: 6,
    };

    // Wheel (middle mouse) on desktop, vertical drag on touch, scrubbing the
    // camera between the default shot and the focus shot. `target` is what the
    // input writes — a straight 0..1 position along the trip, so half a scroll
    // is half the distance. `progress` is what actually gets applied, chasing
    // `target` so the camera eases instead of snapping frame to frame.
    //
    // `wheelDistance` is how much accumulated wheel delta (in px) makes the
    // full trip; `dragDistance` is the same thing for touch, as a fraction of
    // the screen height — 1 means a full-height swipe covers the whole
    // transition.
    this.transition = {
      enabled: true,
      progress: 0,
      target: 0,
      wheelDistance: 1000,
      dragDistance: 1,
      smoothing: 6,
    };

    // Zoom, driven by the wooden slider in the bottom-right corner — see
    // ZoomSlider.js. It lives here rather than on the slider so it eases on the
    // same clock as everything else, survives a reset, and keeps working while
    // OrbitControls has the camera.
    //
    // This is `PerspectiveCamera.zoom`, a projection-matrix scale, not a dolly:
    // it magnifies without moving the camera, so it can't fight the transition
    // or the parallax for the transform. 1 is the shot as framed — the slider
    // only zooms in from there, so no amount of sliding can pull the framing
    // wide enough to show the edges of the set.
    this.zoom = {
      value: 1,
      target: 1,
      min: 1,
      max: 2.5,
      smoothing: 8,
    };

    // Endpoints, held as objects so the per-frame lerp doesn't rebuild them.
    this.defaultPosition = new THREE.Vector3(...DEFAULT_POSITION);
    this.defaultRotation = new THREE.Euler(...DEFAULT_ROTATION);
    this.defaultTarget = new THREE.Vector3(...DEFAULT_TARGET);
    this.focusPosition = new THREE.Vector3(...FOCUS_POSITION);
    this.focusRotation = new THREE.Euler(...FOCUS_ROTATION);
    this.focusTarget = new THREE.Vector3(...FOCUS_TARGET);

    // Where the current touch went down, and the last Y the scrub was measured
    // from. `lastTouchY` stays null until the finger has cleared TAP_SLOP, so a
    // tap — which always jitters a pixel or two — never winds the camera.
    this.touchAnchorY = null;
    this.lastTouchY = null;

    // The shot itself. Parallax is layered on top of this each frame rather
    // than written into the camera as state, so it can't drift over time and
    // logState()/resetToDefault() still deal in the real framing.
    this.basePosition = new THREE.Vector3(...DEFAULT_POSITION);
    this.baseRotation = new THREE.Euler(...DEFAULT_ROTATION);

    // Smoothed pointer, chasing mouse.drag.
    this.smoothedPointer = new THREE.Vector2(0, 0);

    this.init();
    this.setOrbitControls();
    this.setTransitionInput();
  }

  init() {
    this.instance = new THREE.PerspectiveCamera(
      40,
      this.experience.sizes.aspect,
      0.01,
      1000,
    );

    this.instance.position.set(...DEFAULT_POSITION);
    this.instance.rotation.set(...DEFAULT_ROTATION);

    this.experience.scene.add(this.instance);
  }

  setOrbitControls() {
    this.controls = new OrbitControls(
      this.instance,
      this.experience.canvasElement,
    );
    this.controls.enableDamping = true;

    this.controls.target.set(...DEFAULT_TARGET);
    this.controls.enabled = this.orbitControlsEnabled;

    // The OrbitControls constructor runs its own update(), which re-derives the
    // camera quaternion from `target` — stomping the rotation set in init().
    // Put it back so a disabled orbit rig can't shift the default framing.
    if (!this.orbitControlsEnabled) {
      this.instance.rotation.set(...DEFAULT_ROTATION);
    }
  }

  /**
   * Wires the wheel and the touch drag to the transition. Both are passive —
   * nothing here calls preventDefault, so the page keeps its native scroll if
   * it ever grows one.
   */
  setTransitionInput() {
    window.addEventListener(
      "wheel",
      (event) => {
        // Firefox on some setups reports lines rather than pixels; normalise
        // so a notch is worth roughly the same everywhere. Negated: scrolling
        // up runs toward the focus shot, down winds back to the default.
        const deltaY = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
        this.nudgeTransition(-deltaY / this.transition.wheelDistance);
      },
      { passive: true },
    );

    window.addEventListener(
      "touchstart",
      (event) => {
        // Only drags that start on the canvas scrub the camera. Without this,
        // dragging the zoom knob (or any other on-screen control) would also
        // haul the camera through the transition under your thumb.
        if (event.target !== this.experience.canvasElement) {
          this.touchAnchorY = null;
          this.lastTouchY = null;
          return;
        }
        this.touchAnchorY = event.touches[0]?.clientY ?? null;
        this.lastTouchY = null;
      },
      { passive: true },
    );

    window.addEventListener(
      "touchmove",
      (event) => {
        const y = event.touches[0]?.clientY;
        if (y === undefined || this.touchAnchorY === null) return;

        // Nothing scrubs until the finger has travelled far enough to mean it.
        // The delta is then measured from where it crossed rather than from
        // where it landed, so the camera picks the gesture up from a standstill
        // instead of jumping the slop distance on the first frame of a drag.
        if (this.lastTouchY === null) {
          if (Math.abs(y - this.touchAnchorY) <= TAP_SLOP) return;
          this.lastTouchY = y;
          return;
        }

        // Finger down runs toward the focus shot, matching wheel-up.
        const dragged = y - this.lastTouchY;
        this.lastTouchY = y;

        const full = this.experience.sizes.height * this.transition.dragDistance;
        this.nudgeTransition(dragged / full);
      },
      { passive: true },
    );

    // Dropping the finger has to clear the anchor, otherwise the next touch
    // starts from wherever the last one ended and jumps the transition.
    const clearTouch = () => {
      this.touchAnchorY = null;
      this.lastTouchY = null;
    };
    window.addEventListener("touchend", clearTouch, { passive: true });
    window.addEventListener("touchcancel", clearTouch, { passive: true });
  }

  /**
   * Moves the transition along by `amount` (1 = the whole trip), clamped to
   * the two endpoints. Ignored while OrbitControls has the camera — the wheel
   * is its zoom — and before the experience has started, so a scroll over the
   * preloader doesn't bank progress the user can't see.
   */
  nudgeTransition(amount) {
    if (!this.transition.enabled) return;
    if (this.controls?.enabled) return;
    if (!this.experience.started) return;

    this.transition.target = THREE.MathUtils.clamp(
      this.transition.target + amount,
      0,
      1,
    );
  }

  /**
   * Eases `progress` toward `target` and writes the interpolated shot into the
   * base transform, so parallax still layers on top of it. Returns whether it
   * drove anything, which is what tells update() the base is worth applying.
   *
   * The two rotations are close enough (and share an order) that lerping the
   * Euler components reads the same as slerping quaternions, without needing
   * to keep a pair around.
   */
  updateTransition() {
    const t = this.transition;
    if (!t.enabled || this.controls?.enabled) return false;

    const delta = Math.min(this.experience.time.delta, 100) / 1000;
    t.progress = THREE.MathUtils.lerp(
      t.progress,
      t.target,
      1 - Math.exp(-t.smoothing * delta),
    );

    // Exponential easing never quite arrives; settle it so a parked camera
    // isn't drifting by a millionth of a unit every frame.
    if (Math.abs(t.target - t.progress) < 0.0001) t.progress = t.target;

    const k = t.progress;
    const lerp = THREE.MathUtils.lerp;

    this.basePosition.lerpVectors(this.defaultPosition, this.focusPosition, k);
    this.baseRotation.set(
      lerp(this.defaultRotation.x, this.focusRotation.x, k),
      lerp(this.defaultRotation.y, this.focusRotation.y, k),
      lerp(this.defaultRotation.z, this.focusRotation.z, k),
    );

    // Only read while OrbitControls is toggled on, but keeping it in step means
    // flipping into orbit mid-transition doesn't swing the view somewhere else.
    this.controls?.target.lerpVectors(this.defaultTarget, this.focusTarget, k);

    return true;
  }

  /**
   * Sets where the zoom is heading, clamped to the slider's own range. The
   * slider calls this on every input; update() does the easing, so a flicked
   * knob glides in rather than snapping.
   */
  setZoom(value) {
    this.zoom.target = THREE.MathUtils.clamp(
      value,
      this.zoom.min,
      this.zoom.max,
    );
  }

  /**
   * Eases the zoom and pushes it into the projection matrix. Runs before the
   * orbit early-out in update(), so the slider still works with OrbitControls
   * on — nothing here touches the transform it owns.
   */
  updateZoom() {
    const z = this.zoom;

    const delta = Math.min(this.experience.time.delta, 100) / 1000;
    z.value = THREE.MathUtils.lerp(
      z.value,
      z.target,
      1 - Math.exp(-z.smoothing * delta),
    );
    if (Math.abs(z.target - z.value) < 0.0001) z.value = z.target;

    // updateProjectionMatrix() is not free, and a parked slider is the common
    // case — only pay for it on the frames the zoom actually moved.
    if (this.instance.zoom === z.value) return;
    this.instance.zoom = z.value;
    this.instance.updateProjectionMatrix();
  }

  // Called from Experience.init() rather than the constructor: `experience.gui`
  // doesn't exist until renderer.init() has built the Inspector, and Camera is
  // constructed before that.
  setupGUI() {
    const folder = this.experience.gui.addFolder("Camera");

    folder
      .add(this, "orbitControlsEnabled")
      .name("Orbit Controls")
      .onChange(() => this.setOrbitControlsEnabled(this.orbitControlsEnabled));

    const transition = folder.addFolder("Scroll Transition");
    transition.add(this.transition, "enabled").name("Enabled");
    transition.add(this.transition, "target", 0, 1, 0.001).name("Progress");
    transition
      .add(this.transition, "wheelDistance", 200, 4000, 50)
      .name("Wheel Distance");
    transition
      .add(this.transition, "dragDistance", 0.2, 2, 0.05)
      .name("Drag Distance");
    transition
      .add(this.transition, "smoothing", 0.5, 12, 0.1)
      .name("Smoothing");

    // Driving `target` rather than `value`, so the panel and the slider are
    // moving the same handle and neither can be left behind.
    const zoom = folder.addFolder("Zoom");
    zoom
      .add(this.zoom, "target", this.zoom.min, this.zoom.max, 0.01)
      .name("Zoom");
    zoom.add(this.zoom, "smoothing", 0.5, 20, 0.1).name("Smoothing");

    const parallax = folder.addFolder("Mouse Parallax");
    parallax.add(this.parallax, "enabled").name("Enabled (off on touch)");
    parallax.add(this.parallax, "vertical").name("Vertical (off on touch)");
    parallax.add(this.parallax, "positionX", 0, 2, 0.01).name("Move X");
    parallax.add(this.parallax, "positionY", 0, 2, 0.01).name("Move Y");
    parallax.add(this.parallax, "rotationX", 0, 0.3, 0.005).name("Look X");
    parallax.add(this.parallax, "rotationY", 0, 0.3, 0.005).name("Look Y");
    parallax.add(this.parallax, "smoothing", 0.5, 12, 0.1).name("Smoothing");

    folder.add({ log: () => this.logState() }, "log").name("Log Camera State");

    folder
      .add({ reset: () => this.resetToDefault() }, "reset")
      .name("Reset to Default");
  }

  // Re-aims `target` onto whatever the camera is already looking at before
  // handing control over, keeping its distance. Without this, enabling orbit
  // snaps the view back to the stored target — jarring when you've just nudged
  // the rotation by hand and want to orbit on from there.
  setOrbitControlsEnabled(enabled) {
    this.orbitControlsEnabled = enabled;

    if (enabled) {
      const distance = this.instance.position.distanceTo(this.controls.target);
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
        this.instance.quaternion,
      );

      this.controls.target
        .copy(this.instance.position)
        .addScaledVector(forward, distance);
    } else {
      // Coming back from orbit: adopt wherever it was left as the new base,
      // otherwise parallax would yank the view back to the old shot on the
      // next frame. Zero the pointer so it eases out from dead centre. With
      // the scroll transition on, that adoption only lasts a frame — the
      // transition owns the base and puts its own shot back.
      this.basePosition.copy(this.instance.position);
      this.baseRotation.copy(this.instance.rotation);
      this.smoothedPointer.set(0, 0);
    }

    this.controls.enabled = enabled;
  }

  resetToDefault() {
    this.transition.progress = 0;
    this.transition.target = 0;
    this.touchAnchorY = null;
    this.lastTouchY = null;

    // Straight to 1 rather than easing there: this is a hard reset, and the
    // slider picks the new value up on its next frame.
    this.zoom.value = 1;
    this.zoom.target = 1;
    this.instance.zoom = 1;
    this.instance.updateProjectionMatrix();

    this.basePosition.set(...DEFAULT_POSITION);
    this.baseRotation.set(...DEFAULT_ROTATION);
    this.smoothedPointer.set(0, 0);

    this.instance.position.set(...DEFAULT_POSITION);
    this.instance.rotation.set(...DEFAULT_ROTATION);
    this.controls.target.set(...DEFAULT_TARGET);
  }

  /**
   * Parallax owns the camera transform only when nothing else does — orbit
   * mode wins, and it stays still until the experience has started, so a
   * preloader overlay (when one is back) doesn't have the scene sliding
   * around behind it.
   */
  isParallaxActive() {
    return (
      this.parallax.enabled &&
      !this.controls?.enabled &&
      this.experience.started
    );
  }

  /**
   * Eases the smoothed pointer toward the raw one, then rebuilds the camera
   * transform as base + offset. Position and rotation move the same direction
   * so the two read as one gesture: slide right while turning right.
   */
  updateParallax() {
    // `drag`, not `instance`: on touch a tap moves the pointer but must not
    // move the camera. See Mouse.js for why they are tracked separately.
    const mouse = this.experience.mouse?.drag;
    if (!mouse) return;

    const p = this.parallax;

    // Frame-rate independent easing — a fixed lerp factor would make the
    // follow speed depend on refresh rate. Delta is clamped so a backgrounded
    // tab doesn't come back with one giant jump.
    const delta = Math.min(this.experience.time.delta, 100) / 1000;
    this.smoothedPointer.lerp(mouse, 1 - Math.exp(-p.smoothing * delta));

    const { x } = this.smoothedPointer;
    // Both vertical terms come off the same value, so dropping it to 0 removes
    // the pitch and the vertical slide together, leaving a pure left/right lean.
    const y = p.vertical ? this.smoothedPointer.y : 0;

    this.instance.position.set(
      this.basePosition.x + x * p.positionX,
      this.basePosition.y + y * p.positionY,
      this.basePosition.z,
    );

    // Negative yaw turns right in three.js, so x is flipped here; pitch is
    // not — positive rotation.x looks up, which is what a pointer up wants.
    this.instance.rotation.set(
      this.baseRotation.x + y * p.rotationX,
      this.baseRotation.y - x * p.rotationY,
      this.baseRotation.z,
    );
  }

  /**
   * Dumps the current framing as a paste-ready snippet (and copies it), so you
   * can orbit to a shot and bake it in as the default. Prints both forms:
   * position + target for while OrbitControls is still here, and
   * position + rotation for after it's gone — rotation is what actually
   * survives, since without controls nothing re-derives it from a target.
   */
  logState() {
    const round = (value) => Number(value.toFixed(4));

    // While parallax is running the camera sits at base + a pointer offset,
    // so log the base — otherwise you'd bake whatever the mouse happened to
    // be doing into the default shot.
    const parallaxed = this.isParallaxActive();
    const p = parallaxed ? this.basePosition : this.instance.position;
    const r = parallaxed ? this.baseRotation : this.instance.rotation;
    const { fov } = this.instance;
    const t = this.controls?.target;

    const snippet = [
      "// camera default",
      `this.instance.position.set(${round(p.x)}, ${round(p.y)}, ${round(p.z)});`,
      `this.instance.rotation.set(${round(r.x)}, ${round(r.y)}, ${round(r.z)});`,
      `this.instance.fov = ${round(fov)};`,
      t
        ? `// with OrbitControls: this.controls.target.set(${round(t.x)}, ${round(t.y)}, ${round(t.z)});`
        : "// no OrbitControls active",
    ].join("\n");

    console.log(snippet);
    navigator.clipboard?.writeText(snippet).catch(() => {});
  }

  resize() {
    this.instance.aspect = this.experience.sizes.aspect;
    this.instance.updateProjectionMatrix();
  }

  update() {
    // Projection only — safe to run whoever owns the transform, orbit included.
    this.updateZoom();

    // A transition that drives the camera directly (GSAP, a scroll path, …)
    // should flip `controls.enabled` off so OrbitControls doesn't fight it.
    if (this.controls && this.controls.enabled) {
      this.controls.update();
      return;
    }

    // Order matters: the transition sets the base shot, then parallax offsets
    // from it. With parallax off the base has to be written out by hand,
    // otherwise the camera would sit wherever it was last left.
    const driven = this.updateTransition();

    if (this.isParallaxActive()) {
      this.updateParallax();
    } else if (driven) {
      this.instance.position.copy(this.basePosition);
      this.instance.rotation.copy(this.baseRotation);
    }
  }
}
