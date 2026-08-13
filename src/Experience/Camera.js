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
    }

    this.controls.enabled = enabled;
  }

  resetToDefault() {
    this.instance.position.set(...DEFAULT_POSITION);
    this.instance.rotation.set(...DEFAULT_ROTATION);
    this.controls.target.set(...DEFAULT_TARGET);
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
    const { position: p, rotation: r, fov } = this.instance;
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
    }
  }
}
