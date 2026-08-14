import * as THREE from "three/webgpu";
import { Experience } from "../Experience";
import { Environment } from "./Environment";
import { Plinko } from "./Plinko/Plinko.js";
import { modelClasses } from "./models.generated.js";
import {
  applyTransformOverrides,
  tagTransformNamespaces,
} from "../Utils/TransformOverrides";

export class World {
  constructor() {
    this.experience = Experience.getInstance();

    this.experience.resources.on("ready", () => {
      // Instantiate every model class the asset-reloader generated. New Blender
      // exports get picked up automatically — no edits to World needed.
      // Isolate each one: a freshly-scaffolded/broken class must not abort the
      // rest of init.
      this.models = modelClasses.flatMap((ModelClass) => {
        try {
          return [new ModelClass()];
        } catch (err) {
          console.error(`[World] model "${ModelClass.name}" failed:`, err);
          return [];
        }
      });

      this.environment = new Environment();

      // Add the rest of your scene here.

      // Collider extraction for the drop-disk / pinball board. Draws its
      // debug overlay only under #debug; see World/Plinko/Plinko.js.
      try {
        this.plinko = new Plinko();
      } catch (err) {
        console.error("[World] Plinko failed:", err);
      }

      // Last, so anything saved out of the #debug gizmo wins over the
      // positioning the model classes just did.
      tagTransformNamespaces(this.experience.resources.items);
      applyTransformOverrides(this.experience.scene);
    });

    this.init();
  }

  init() {}

  resize() {
    this.models?.forEach((model) => model.resize?.());
    this.environment?.resize();
    this.plinko?.resize();
  }

  update() {
    this.models?.forEach((model) => model.update?.());
    this.environment?.update();
    this.plinko?.update();
  }
}
