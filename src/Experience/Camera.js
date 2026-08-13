import * as THREE from "three/webgpu";
import { Experience } from "./Experience";
import { OrbitControls } from "three/examples/jsm/Addons.js";

// The default shot, captured with the debug panel's "Log Camera State" button.
// `rotation` is what holds the framing now that OrbitControls is off by
// default; `target` only matters while it's toggled back on.
const DEFAULT_POSITION = [0.0112, 4.3343, 14.1853];
const DEFAULT_ROTATION = [-0.2173, -0.0038, -0.0008];
const DEFAULT_TARGET = [0.0497, 2.1504, 4.2955];

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
    this.parallax = {
      enabled: true,
      positionX: 0.4,
      positionY: 0.25,
      rotationX: 0.04,
      rotationY: 0.06,
      smoothing: 6,
    };

    // The shot itself. Parallax is layered on top of this each frame rather
    // than written into the camera as state, so it can't drift over time and
    // logState()/resetToDefault() still deal in the real framing.
    this.basePosition = new THREE.Vector3(...DEFAULT_POSITION);
    this.baseRotation = new THREE.Euler(...DEFAULT_ROTATION);

    // Smoothed pointer, chasing mouse.instance.
    this.smoothedPointer = new THREE.Vector2(0, 0);

    this.init();
    this.setOrbitControls();
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

  // Called from Experience.init() rather than the constructor: `experience.gui`
  // doesn't exist until renderer.init() has built the Inspector, and Camera is
  // constructed before that.
  setupGUI() {
    const folder = this.experience.gui.addFolder("Camera");

    folder
      .add(this, "orbitControlsEnabled")
      .name("Orbit Controls")
      .onChange(() => this.setOrbitControlsEnabled(this.orbitControlsEnabled));

    const parallax = folder.addFolder("Mouse Parallax");
    parallax.add(this.parallax, "enabled").name("Enabled");
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
      // next frame. Zero the pointer so it eases out from dead centre.
      this.basePosition.copy(this.instance.position);
      this.baseRotation.copy(this.instance.rotation);
      this.smoothedPointer.set(0, 0);
    }

    this.controls.enabled = enabled;
  }

  resetToDefault() {
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
    const mouse = this.experience.mouse?.instance;
    if (!mouse) return;

    const p = this.parallax;

    // Frame-rate independent easing — a fixed lerp factor would make the
    // follow speed depend on refresh rate. Delta is clamped so a backgrounded
    // tab doesn't come back with one giant jump.
    const delta = Math.min(this.experience.time.delta, 100) / 1000;
    this.smoothedPointer.lerp(mouse, 1 - Math.exp(-p.smoothing * delta));

    const { x, y } = this.smoothedPointer;

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
    // A transition that drives the camera directly (GSAP, a scroll path, …)
    // should flip `controls.enabled` off so OrbitControls doesn't fight it.
    if (this.controls && this.controls.enabled) {
      this.controls.update();
    } else if (this.isParallaxActive()) {
      this.updateParallax();
    }
  }
}
