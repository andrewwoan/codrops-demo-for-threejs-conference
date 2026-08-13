import * as THREE from "three/webgpu";
import { pass } from "three/tsl";
import { Inspector } from "three/addons/inspector/Inspector.js";
import { Experience } from "./Experience";

/**
 * The Inspector's parameter controllers implement lil-gui's onChange/name/listen
 * but NOT onFinishChange. Any setupGUI() that chains .onFinishChange() would
 * throw "onFinishChange is not a function" and abort World init — silently
 * killing everything constructed after the throwing component. Shim it: here
 * onFinishChange behaves like onChange (fires live while dragging rather than on
 * release), which is fine for debug rebuild callbacks. Applied recursively so
 * nested folders returned by addFolder() get the shim too.
 */
function shimController(controller) {
  if (controller && typeof controller.onFinishChange !== "function") {
    controller.onFinishChange = function (cb) {
      this.onChange(cb);
      return this;
    };
  }
  return controller;
}

function wrapInspectorGui(group) {
  const add = group.add.bind(group);
  const addColor = group.addColor.bind(group);
  const addFolder = group.addFolder.bind(group);

  group.add = (...args) => shimController(add(...args));
  group.addColor = (...args) => shimController(addColor(...args));
  group.addFolder = (...args) => wrapInspectorGui(addFolder(...args));

  return group;
}

/**
 * Stand-in for the Inspector's parameter group used when `#debug` is absent.
 *
 * Components call experience.gui.addFolder(...).add(...).name(...) at
 * construction time; leaving `gui` null would throw and abort World init. This
 * accepts the whole lil-gui surface the codebase uses and returns itself so the
 * chains resolve, but never touches the DOM.
 */
function createNoopGui() {
  const gui = new Proxy(
    {},
    {
      get: (target, prop) => {
        if (prop === "then") return undefined; // don't look thenable to await
        if (!(prop in target)) target[prop] = () => gui;
        return target[prop];
      },
    },
  );

  return gui;
}

export class Renderer {
  constructor() {
    this.experience = Experience.getInstance();
  }

  async init() {
    this.renderer = new THREE.WebGPURenderer({
      canvas: this.experience.canvasElement,
      antialias: true,
    });

    // three.js WebGPU Inspector (profiler + live parameter controls), gated on
    // `#debug` in the URL. Must be attached BEFORE init(): the renderer core
    // calls inspector.init() — which injects the profiler panel into the DOM —
    // exactly once at the end of renderer.init(). Assign it afterwards and that
    // call has already fired on the default no-op inspector, so the panel never
    // mounts. Skipping it entirely (rather than hiding the panel) also skips the
    // Inspector's per-frame renderer instrumentation, which is the point of
    // leaving it off in production.
    const debug = this.experience.debug;
    if (debug) this.renderer.inspector = new Inspector();

    await this.renderer.init();

    // `createParameters()` returns a lil-gui-compatible group
    // (add/addFolder/addColor/.name/.onChange), so every setupGUI() in the
    // codebase works unchanged — they just draw into the Inspector's
    // "Parameters" tab.
    this.experience.gui = debug
      ? wrapInspectorGui(this.renderer.inspector.createParameters("Controls"))
      : createNoopGui();

    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.BasicShadowMap;
    this.renderer.setSize(
      this.experience.sizes.width,
      this.experience.sizes.height,
    );
    this.renderer.setPixelRatio(this.experience.sizes.pixelRatio);

    this.setupPostProcessing();
    this.setupGUI();
  }

  /**
   * Straight scene pass through a RenderPipeline — no effects yet, so it looks
   * identical to a plain renderer.render(). It's wired up from the start so
   * adding a grade later is a one-line change to `outputNode` rather than a
   * rewrite of the render path (which renderDebugGizmo below depends on).
   *
   * e.g. to tint the whole frame:
   *   import { color } from "three/tsl";
   *   this.postProcessing.outputNode = sceneColor.mul(color(0xffddcc));
   */
  setupPostProcessing() {
    const scenePass = pass(
      this.experience.scene,
      this.experience.camera.instance,
    );

    const sceneColor = scenePass.getTextureNode();

    this.postProcessing = new THREE.RenderPipeline(this.renderer);
    this.postProcessing.outputNode = sceneColor;
  }

  setupGUI() {}

  resize() {
    this.renderer.setSize(
      this.experience.sizes.width,
      this.experience.sizes.height,
    );
    this.renderer.setPixelRatio(this.experience.sizes.pixelRatio);
  }

  update() {
    this.postProcessing.render();
    this.renderDebugGizmo();
  }

  /**
   * Drawn after the post pipeline, straight onto the canvas, so the gizmo stays
   * full-res and never picks up whatever grade the pipeline applies. No depth
   * clear needed — TransformControls' own materials are `depthTest: false`, so
   * it can't hide behind the geometry it's manipulating.
   *
   * The toneMapping/outputColorSpace juggling is load-bearing, not cosmetic.
   * With the renderer-level output transform left on, Renderer._getFrameBufferTarget()
   * hands this render an internal offscreen target and then blits that target
   * over the canvas — wiping the frame the pipeline just drew, and, since
   * autoClear is off, accumulating every frame's gizmo inside it (a white page
   * with a smeared gizmo). RenderPipeline.render() disables exactly these two
   * properties around its own fullscreen quad, which is why the quad lands on
   * the canvas directly; the gizmo has to match it.
   */
  renderDebugGizmo() {
    const gizmo = this.experience.debugTransform;
    if (!gizmo?.enabled || !gizmo.selected) return;

    const renderer = this.renderer;
    const { toneMapping, outputColorSpace, autoClear } = renderer;

    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.ColorManagement.workingColorSpace;
    renderer.autoClear = false;

    renderer.render(gizmo.scene, this.experience.camera.instance);

    renderer.autoClear = autoClear;
    renderer.toneMapping = toneMapping;
    renderer.outputColorSpace = outputColorSpace;
  }
}
