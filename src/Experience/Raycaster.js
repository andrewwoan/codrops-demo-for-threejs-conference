import * as THREE from "three/webgpu";
import { Experience } from "./Experience";

/**
 * Generic pointer picking against a registered set of meshes.
 *
 * Nothing is interactive until you register it — from a model class, or from
 * World once resources are ready:
 *
 *   this.experience.raycaster.add({
 *     mesh: someMesh,
 *     onClick: (object) => { ... },
 *     onHoverEnter: (object) => { ... },
 *     onHoverLeave: (object) => { ... },
 *   });
 *
 * Hits are resolved back up the hierarchy, so registering a glTF group catches
 * clicks on any mesh inside it.
 */
export class Raycaster {
  constructor() {
    this.experience = Experience.getInstance();
    this.mouse = this.experience.mouse;
    this.camera = this.experience.camera.instance;
    this.canvas = this.experience.canvasElement;

    this.raycaster = new THREE.Raycaster();

    // Registered entries and the flat mesh list handed to intersectObjects().
    this.intersectObjects = [];
    this.meshes = [];

    this.hoveredObject = null;
    // Set this while a modal/overlay owns the pointer to suspend picking.
    this.enabled = true;

    this.init();
  }

  /** Register one interactive object. Returns the stored entry. */
  add(object) {
    const entry = { ...object };
    this.intersectObjects.push(entry);
    this.meshes = this.intersectObjects.map((item) => item.mesh);
    return entry;
  }

  /** Register several at once. */
  addAll(objects) {
    return objects.map((object) => this.add(object));
  }

  remove(mesh) {
    this.intersectObjects = this.intersectObjects.filter(
      (item) => item.mesh !== mesh,
    );
    this.meshes = this.intersectObjects.map((item) => item.mesh);
    if (this.hoveredObject?.mesh === mesh) this.hoveredObject = null;
  }

  init() {
    const handleClickAndTouch = () => {
      if (!this.isActive()) return;

      const entry = this.pick();
      if (!entry) return;

      entry.onClick?.(entry);
    };

    this.canvas.addEventListener("click", handleClickAndTouch);
    this.canvas.addEventListener("touchend", handleClickAndTouch);
  }

  /** Picking is off while disabled, or while the #debug gizmo owns clicks. */
  isActive() {
    return this.enabled && !this.experience.debugTransform?.enabled;
  }

  pick() {
    if (!this.meshes.length) return null;

    this.raycaster.setFromCamera(this.mouse.instance, this.camera);
    const intersects = this.raycaster.intersectObjects(this.meshes, true);
    if (!intersects.length) return null;

    return this.getParentObject(intersects[0].object);
  }

  getParentObject(intersectedObject) {
    let object = intersectedObject;
    while (object) {
      const parent = this.intersectObjects.find((item) => item.mesh === object);
      if (parent) return parent;
      object = object.parent;
    }
    return null;
  }

  setHovered(entry) {
    if (entry === this.hoveredObject) return;

    if (this.hoveredObject) {
      this.hoveredObject.onHoverLeave?.(this.hoveredObject);
    }

    this.hoveredObject = entry;
    document.body.style.cursor = entry ? "pointer" : "default";

    if (entry) entry.onHoverEnter?.(entry);
  }

  resize() {}

  update() {
    if (!this.isActive()) {
      this.setHovered(null);
      return;
    }

    this.setHovered(this.pick());
  }
}
