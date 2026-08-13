import * as THREE from "three/webgpu";
import { Time } from "./Utils/Time";
import { Sizes } from "./Utils/Sizes";
import { Camera } from "./Camera";
import { Renderer } from "./Renderer";
import { World } from "./World/World";
import { Resources } from "./Utils/Resources";
import { Mouse } from "./Mouse";
import { Raycaster } from "./Raycaster";
import { Device } from "./Utils/Device";
// import { Preloader } from "./Preloader"; // temporarily disabled
import { DebugTransform } from "./DebugTransform";

export class Experience {
  static getInstance() {
    return Experience.instance;
  }

  constructor() {
    if (Experience.instance) return Experience.instance;

    Experience.instance = this;

    this.init();
  }

  async init() {
    this.canvasElement = document.getElementById("experience-canvas");

    // Debug tooling is opt-in via the URL hash, e.g. `/#debug`. Read once at
    // startup, so toggling it needs a reload.
    this.debug = window.location.hash === "#debug";

    this.scene = new THREE.Scene();
    // `this.gui` is created inside Renderer.init() once the WebGPURenderer (and
    // its Inspector) exist — see Renderer. Controls live in the Inspector's
    // "Parameters" tab instead of a standalone lil-gui panel. Without `#debug`
    // the Inspector is never constructed and `gui` is a no-op stub, so every
    // setupGUI() still runs but draws nothing.
    this.time = new Time();
    this.device = new Device();
    this.sizes = new Sizes();
    this.camera = new Camera();
    this.renderer = new Renderer();
    this.mouse = new Mouse();
    this.raycaster = new Raycaster();
    await this.renderer.init();

    // Camera is built before the renderer, so its panel has to be drawn here —
    // `this.gui` only exists once renderer.init() has run.
    this.camera.setupGUI();

    // Click-to-transform gizmo. Constructed only on #debug, and only after
    // renderer.init() — it draws into `this.gui`, which that call creates.
    // Saving from it writes transform-overrides.json, which the Blender
    // asset-reloader addon pulls back in with shift+I.
    if (this.debug) this.debugTransform = new DebugTransform();

    // Has the user dismissed the preloader? Gate any scroll/input driven camera
    // work on this. Defaults to true so pulling the preloader out doesn't lock
    // the site — Preloader flips it false while its sheet is up.
    this.started = true;

    this.resources = new Resources();
    // this.preloader = new Preloader(); // temporarily disabled

    this.world = new World();

    this.time.on("update", () => {
      this.update();
    });
    this.sizes.on("resize", () => {
      this.resize();
    });
  }

  resize() {
    this.camera.resize();
    this.renderer.resize();
    this.world.resize();
  }

  update() {
    this.world.update();
    this.renderer.update();
    this.camera.update();
    this.raycaster.update();
    this.debugTransform?.update();
  }
}
