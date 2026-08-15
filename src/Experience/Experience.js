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
import { ZoomSlider } from "./ZoomSlider";
import { Preloader } from "./Preloader";
import { Tutorial } from "./Tutorial";
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

    // The zoom lever, bottom right. Built after the camera it drives, and after
    // the panel above, so both are moving the same value from the start.
    this.zoomSlider = new ZoomSlider();

    // Click-to-transform gizmo. Constructed only on #debug, and only after
    // renderer.init() — it draws into `this.gui`, which that call creates.
    // Saving from it writes transform-overrides.json, which the Blender
    // asset-reloader addon pulls back in with shift+I.
    if (this.debug) this.debugTransform = new DebugTransform();

    // Has the user dismissed the preloader? Gate any scroll/input driven camera
    // work on this. Defaults to true so pulling the preloader out doesn't lock
    // the site — Preloader flips it false while its sheet is up.
    this.started = true;

    // Whether the board is silent. Set before Resources, because World builds
    // on "ready" and Plinko reads this when it constructs its Audio — by then
    // the preloader has already recorded which Enter was pressed.
    this.audioMuted = false;

    this.resources = new Resources();
    this.preloader = new Preloader();

    // The controls card. Built now, shown only once the preloader sheet is
    // gone — behind it there is nothing to try the controls on. If the
    // preloader is ever pulled out again, it simply shows straight away.
    this.tutorial = new Tutorial();
    if (this.preloader) {
      this.preloader.on("preloaderfinished", () => this.tutorial.show());
    } else {
      this.tutorial.show();
    }

    this.world = new World();

    this.time.on("update", () => {
      this.update();
    });
    this.sizes.on("resize", () => {
      this.resize();
    });
  }

  /**
   * The one switch for sound. Three things reach it — the preloader's two Enter
   * buttons, the nameplate in the top-right corner, and the debug panel — and
   * all of them come through here, so the button can never be showing one state
   * while you are hearing the other.
   *
   * Everything downstream is optional on purpose: this can be called before
   * World has built (the preloader is up long before "ready" on a cold cache),
   * and Plinko reads `audioMuted` when it constructs Audio for exactly that
   * case.
   */
  setAudioMuted(muted) {
    this.audioMuted = muted;

    const plinko = this.world?.plinko;
    plinko?.audio?.setMuted(muted);
    plinko?.soundToggle?.set(muted);
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
    this.zoomSlider?.update();
    this.raycaster.update();
    this.debugTransform?.update();
  }
}
