import * as THREE from "three/webgpu";
import { Experience } from "../Experience";

export class Environment {
  constructor() {
    this.experience = Experience.getInstance();

    this.init();
  }

  init() {
    this.gui = this.experience.gui.addFolder("Environment");

    this.setupScene();
    // this.setupFog();
    this.setupAmbientLight();
    this.setupDirectionalLight();
  }

  setupScene() {
    const defaultColor = "#ffffff";
    this.experience.scene.background = new THREE.Color(defaultColor);

    this.gui
      .addColor({ color: defaultColor }, "color")
      .name("Background")
      .onChange((val) => {
        // A cube-texture background has no .set(); only a Color does.
        if (!this.experience.scene.background?.isColor) return;
        this.experience.scene.background.set(val);
        // Keep fog synced with background for seamless blending
        if (this._fogMatchesBackground && this.experience.scene.fog) {
          this.experience.scene.fog.color.set(val);
          this._fogColorCtrl?.setValue(val);
        }
      });
  }

  setupFog() {
    // Store fog settings so we can switch between fog types cleanly.
    this.fogSettings = {
      enabled: true,
      type: "Exponential", // "Linear" | "Exponential"
      color: "#ffffff",
      matchBackground: true,
      // Linear params
      near: 5,
      far: 100,
      // Exponential params (FogExp2 uses squared density for realistic falloff)
      density: 0.001,
    };

    this._fogMatchesBackground = this.fogSettings.matchBackground;

    this.applyFog();

    const folder = this.gui.addFolder("Fog");

    folder
      .add(this.fogSettings, "enabled")
      .name("Enabled")
      .onChange(() => this.applyFog());

    folder
      .add(this.fogSettings, "type", ["Linear", "Exponential"])
      .name("Type")
      .onChange(() => {
        this.applyFog();
        this.refreshFogControls();
      });

    this._fogColorCtrl = folder
      .addColor(this.fogSettings, "color")
      .name("Color")
      .onChange((val) => {
        if (this.experience.scene.fog) this.experience.scene.fog.color.set(val);
        if (this._fogMatchesBackground) {
          this.experience.scene.background.set(val);
        }
      });

    folder
      .add(this.fogSettings, "matchBackground")
      .name("Match Background")
      .onChange((val) => {
        this._fogMatchesBackground = val;
        if (val && this.experience.scene.fog) {
          // Snap background to current fog color for a seamless horizon.
          this.experience.scene.background.set(this.fogSettings.color);
        }
      });

    this._fogFolder = folder;
    this._fogDynamicControls = [];
    this.refreshFogControls();
  }

  refreshFogControls() {
    // Remove previously-added type-specific controls so we can rebuild them.
    if (this._fogDynamicControls) {
      this._fogDynamicControls.forEach((c) => c.destroy());
    }
    this._fogDynamicControls = [];

    const folder = this._fogFolder;
    if (!folder) return;

    if (this.fogSettings.type === "Linear") {
      this._fogDynamicControls.push(
        folder
          .add(this.fogSettings, "near", 0, 100, 0.1)
          .name("Near")
          .onChange((v) => {
            if (this.experience.scene.fog) this.experience.scene.fog.near = v;
          }),
      );
      this._fogDynamicControls.push(
        folder
          .add(this.fogSettings, "far", 0, 200, 0.1)
          .name("Far")
          .onChange((v) => {
            if (this.experience.scene.fog) this.experience.scene.fog.far = v;
          }),
      );
    } else {
      this._fogDynamicControls.push(
        folder
          .add(this.fogSettings, "density", 0, 0.3, 0.001)
          .name("Density")
          .onChange((v) => {
            if (this.experience.scene.fog)
              this.experience.scene.fog.density = v;
          }),
      );
    }
  }

  applyFog() {
    const s = this.experience.scene;
    const cfg = this.fogSettings;

    if (!cfg.enabled) {
      s.fog = null;
      return;
    }

    if (cfg.type === "Linear") {
      s.fog = new THREE.Fog(cfg.color, cfg.near, cfg.far);
    } else {
      // FogExp2 gives a more physically plausible, atmospheric falloff.
      s.fog = new THREE.FogExp2(cfg.color, cfg.density);
    }
  }

  setupAmbientLight() {
    this.ambientLight = new THREE.AmbientLight("#ffffff", 1);
    this.experience.scene.add(this.ambientLight);

    const folder = this.gui.addFolder("Ambient Light");
    folder
      .addColor({ color: "#ffffff" }, "color")
      .name("Color")
      .onChange((val) => this.ambientLight.color.set(val));
    folder.add(this.ambientLight, "intensity", 0, 3, 0.01).name("Intensity");
    folder.add(this.ambientLight, "visible").name("Visible");
  }

  setupDirectionalLight() {
    this.directionalLight = new THREE.DirectionalLight("#ffffff", 2);
    this.directionalLight.position.set(5, 8, 5);
    this.directionalLight.target.position.set(0, 0, 0);
    this.experience.scene.add(this.directionalLight);
    this.experience.scene.add(this.directionalLight.target);

    this.directionalLight.castShadow = true;
    this.directionalLight.shadow.mapSize.width = 1024;
    this.directionalLight.shadow.mapSize.height = 1024;
    this.directionalLight.shadow.camera.near = 0.1;
    this.directionalLight.shadow.camera.far = 30;
    this.directionalLight.shadow.camera.left = -10;
    this.directionalLight.shadow.camera.right = 10;
    this.directionalLight.shadow.camera.top = 10;
    this.directionalLight.shadow.camera.bottom = -10;
    this.directionalLight.shadow.normalBias = 0.01;

    this.directionalLightHelper = new THREE.DirectionalLightHelper(
      this.directionalLight,
      0.5,
    );
    this.directionalLightHelper.visible = false;
    this.experience.scene.add(this.directionalLightHelper);

    const folder = this.gui.addFolder("Directional Light");
    folder
      .addColor({ color: "#ffffff" }, "color")
      .name("Color")
      .onChange((val) => this.directionalLight.color.set(val));
    folder
      .add(this.directionalLight, "intensity", 0, 5, 0.01)
      .name("Intensity");
    folder.add(this.directionalLight, "visible").name("Visible");

    const onMove = () => this.directionalLightHelper.update();

    const pos = folder.addFolder("Position");
    pos
      .add(this.directionalLight.position, "x", -20, 20, 0.1)
      .name("X")
      .onChange(onMove);
    pos
      .add(this.directionalLight.position, "y", -20, 20, 0.1)
      .name("Y")
      .onChange(onMove);
    pos
      .add(this.directionalLight.position, "z", -20, 20, 0.1)
      .name("Z")
      .onChange(onMove);

    const target = folder.addFolder("Target");
    target
      .add(this.directionalLight.target.position, "x", -10, 10, 0.1)
      .name("X")
      .onChange(onMove);
    target
      .add(this.directionalLight.target.position, "y", -10, 10, 0.1)
      .name("Y")
      .onChange(onMove);
    target
      .add(this.directionalLight.target.position, "z", -10, 10, 0.1)
      .name("Z")
      .onChange(onMove);

    folder.add(this.directionalLightHelper, "visible").name("Show Helper");
  }

  resize() {}

  update() {}
}
