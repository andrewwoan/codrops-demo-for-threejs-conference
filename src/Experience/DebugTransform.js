import * as THREE from "three/webgpu";
import { TransformControls } from "three/examples/jsm/Addons.js";
import { Experience } from "./Experience";
import { clearTransforms, saveTransforms } from "./Utils/TransformOverrides";

// Click-to-select transform gizmo, only on #debug. Lets you drag any mesh in
// the scene around and read the resulting transform back out as a paste-ready
// snippet — the same workflow as Camera's log button, but for objects.
//
// Saving (ctrl+S) writes transform-overrides.json through the dev server, which
// is also what the Blender asset-reloader addon reads: shift+I in the viewport
// pulls those edits onto the Blender objects and re-exports the GLBs, so a drag
// in the browser round-trips into the .blend.
//
// Only constructed under #debug (see Experience.init), so there are no
// `if (debug)` guards in here.

// Blender muscle memory, plus the number row for anyone who'd rather not
// remember which letter does what.
const MODE_KEYS = {
  g: "translate",
  r: "rotate",
  s: "scale",
  digit1: "translate",
  digit2: "rotate",
  digit3: "scale",
};

// Applied while Shift is held.
const SNAP = { translate: 0.1, rotate: Math.PI / 24, scale: 0.1 };

// A click that drags this far or further was an orbit, not a selection.
const CLICK_SLOP = 4;

// How many drags ctrl+Z can walk back. Each entry is nine numbers, so this is
// deep enough to be useful and still nothing on memory.
const HISTORY_LIMIT = 50;

export class DebugTransform {
  constructor() {
    this.experience = Experience.getInstance();
    this.camera = this.experience.camera.instance;
    this.canvas = this.experience.canvasElement;

    // The gizmo lives in its own scene so Renderer can draw it after the post
    // pipeline, at full res and with depth cleared — a gizmo hidden behind the
    // geometry it's manipulating is impossible to grab.
    this.scene = new THREE.Scene();

    this.enabled = true;
    this.autoSave = false;
    // Click whole objects rather than the material-split halves of one.
    this.selectWholeObjects = true;
    this.selected = null;
    // Everything moved this session — the set that gets written on save.
    this.edited = new Set();
    // One entry per completed drag, oldest first; redo holds what undo popped.
    this.history = [];
    this.future = [];
    this.dragStart = null;
    this.status = "";
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.pointerDown = new THREE.Vector2();

    this.init();
  }

  init() {
    this.controls = new TransformControls(this.camera, this.canvas);
    this.controls.setSpace("world");
    this.scene.add(this.controls.getHelper());

    // Orbiting and dragging an axis at the same time fights for the pointer.
    // Guarded because a scene that drives the camera itself may have no
    // OrbitControls at all.
    this.controls.addEventListener("dragging-changed", (event) => {
      // Restore to whatever the Camera panel says, not a blanket `true` —
      // OrbitControls is off by default now, and a gizmo drag must not switch
      // it back on behind the toggle's back.
      const camera = this.experience.camera;
      if (camera.controls) {
        camera.controls.enabled = event.value
          ? false
          : camera.orbitControlsEnabled;
      }

      // Grabbed an axis — remember where the object started so the whole drag
      // undoes as one step rather than per-frame.
      if (event.value) {
        this.dragStart = this.selected ? this.snapshot(this.selected) : null;
        return;
      }

      // Released it — the transform is final for this drag.
      if (!this.selected) return;

      this.pushHistory(this.selected, this.dragStart);
      this.dragStart = null;
      this.edited.add(this.selected);
      if (this.autoSave) this.save();
    });

    this.initOverlay();
    this.initPointer();
    this.initKeyboard();
    this.initGui();
    this.updateOverlay();
  }

  initGui() {
    const folder = this.experience.gui.addFolder("Transform Gizmo");

    folder
      .add(this, "enabled")
      .name("Enabled")
      .onChange(() => {
        if (!this.enabled) this.select(null);
        this.updateOverlay();
      });

    folder
      .add(this, "selectWholeObjects")
      .name("Select Whole Objects")
      .onChange(() => this.select(null));

    folder.add(this, "autoSave").name("Auto-save on Release");

    folder.add({ save: () => this.save() }, "save").name("Save Transforms");

    folder
      .add({ clear: () => this.clear() }, "clear")
      .name("Clear Saved Transforms");

    folder
      .add({ log: () => this.logTransform() }, "log")
      .name("Log Selected Transform");
  }

  // Writes every object moved this session to transform-overrides.json via the
  // dev server, so the edits survive a reload without a code change — and are
  // there for Blender's shift+I to pull back in.
  async save() {
    if (!this.edited.size) {
      this.setStatus("nothing to save");
      return;
    }

    try {
      const count = await saveTransforms(this.edited, this.experience.scene);
      this.setStatus(`saved ${count} object(s)`);
    } catch (error) {
      this.setStatus(`save failed — ${error.message}`);
      console.error(error);
    }
  }

  async clear() {
    try {
      await clearTransforms();
      this.edited.clear();
      this.setStatus("cleared — reload to see originals");
    } catch (error) {
      this.setStatus(`clear failed — ${error.message}`);
      console.error(error);
    }
  }

  setStatus(message) {
    this.status = message;
    clearTimeout(this.statusTimeout);
    this.statusTimeout = setTimeout(() => {
      this.status = "";
      this.updateOverlay();
    }, 3000);
    this.updateOverlay();
  }

  snapshot(object) {
    const { position: p, rotation: r, scale: s } = object;
    return {
      position: p.toArray(),
      rotation: [r.x, r.y, r.z],
      scale: s.toArray(),
    };
  }

  applySnapshot(object, state) {
    object.position.fromArray(state.position);
    object.rotation.fromArray(state.rotation);
    object.scale.fromArray(state.scale);
  }

  sameTransform(a, b) {
    return ["position", "rotation", "scale"].every((key) =>
      a[key].every((value, index) => value === b[key][index]),
    );
  }

  pushHistory(object, before) {
    if (!before) return;

    const after = this.snapshot(object);
    // Clicking an axis without moving it still fires a drag pair; don't fill
    // the stack with no-ops you'd have to ctrl+Z past.
    if (this.sameTransform(before, after)) return;

    this.history.push({ object, before, after });
    if (this.history.length > HISTORY_LIMIT) this.history.shift();

    // A fresh edit is a new branch — whatever was undone can't be redone onto
    // it any more.
    this.future.length = 0;
    this.updateOverlay();
  }

  undo() {
    const entry = this.history.pop();
    if (!entry) {
      this.setStatus("nothing to undo");
      return;
    }

    this.applySnapshot(entry.object, entry.before);
    this.future.push(entry);
    this.afterHistoryStep(entry, "undo");
  }

  redo() {
    const entry = this.future.pop();
    if (!entry) {
      this.setStatus("nothing to redo");
      return;
    }

    this.applySnapshot(entry.object, entry.after);
    this.history.push(entry);
    this.afterHistoryStep(entry, "redo");
  }

  // Undoing back to an object's original transform still leaves it in `edited`:
  // an override that matches the original is harmless, and dropping it would
  // instead leave a stale saved transform on disk overriding what's on screen.
  afterHistoryStep(entry, label) {
    this.edited.add(entry.object);
    if (this.selected !== entry.object) this.select(entry.object);
    if (this.autoSave) this.save();
    this.setStatus(`${label} — ${entry.object.name || entry.object.type}`);
  }

  initPointer() {
    this.canvas.addEventListener("pointerdown", (event) => {
      this.pointerDown.set(event.clientX, event.clientY);
    });

    this.canvas.addEventListener("pointerup", (event) => {
      if (!this.enabled) return;
      // Grabbing an axis handle already hovers it, so this also keeps a
      // release over the gizmo from re-picking whatever is behind it.
      if (this.controls.axis !== null || this.controls.dragging) return;

      const moved = Math.hypot(
        event.clientX - this.pointerDown.x,
        event.clientY - this.pointerDown.y,
      );
      if (moved >= CLICK_SLOP) return;

      this.select(this.pick(event));
    });
  }

  initKeyboard() {
    window.addEventListener("keydown", (event) => {
      if (!this.enabled || this.isTyping(event)) return;

      if (event.key === "Shift") this.setSnapping(true);

      // Ctrl/Cmd+S saves. Caught before the mode keys so it doesn't also flip
      // the gizmo into scale mode, and before the browser's save dialog.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        this.save();
        return;
      }

      // Ctrl/Cmd+Z undoes a drag, +Shift redoes it (ctrl+Y too, for Windows
      // habits). preventDefault keeps the browser's own undo out of it.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) this.redo();
        else this.undo();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        this.redo();
        return;
      }

      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const mode =
        MODE_KEYS[event.key.toLowerCase()] ??
        MODE_KEYS[event.code.toLowerCase()];
      if (mode) {
        this.controls.setMode(mode);
        this.updateOverlay();
        return;
      }

      switch (event.key.toLowerCase()) {
        case "escape":
          this.select(null);
          break;
        case "x":
          this.controls.setSpace(
            this.controls.space === "world" ? "local" : "world",
          );
          this.updateOverlay();
          break;
        case "p":
          // Walk up the hierarchy — a click lands on a leaf mesh, but the
          // thing you actually want to move is usually its glTF parent.
          if (
            this.selected?.parent &&
            this.selected.parent !== this.experience.scene
          ) {
            this.select(this.selected.parent);
          }
          break;
        case "l":
          this.logTransform();
          break;
      }
    });

    window.addEventListener("keyup", (event) => {
      if (event.key === "Shift") this.setSnapping(false);
    });
  }

  isTyping(event) {
    const target = event.target;
    return (
      target?.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName)
    );
  }

  setSnapping(on) {
    this.controls.setTranslationSnap(on ? SNAP.translate : null);
    this.controls.setRotationSnap(on ? SNAP.rotate : null);
    this.controls.setScaleSnap(on ? SNAP.scale : null);
  }

  // Everything visible in the main scene is fair game, minus the bits that are
  // debug furniture themselves. Meshes tagged `userData.isOutline` are skipped
  // too — an inverted-hull outline shell wraps its mesh and would otherwise
  // swallow every click meant for it.
  pick(event) {
    this.pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    this.pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const hits = this.raycaster.intersectObjects(
      this.experience.scene.children,
      true,
    );

    for (const hit of hits) {
      const object = hit.object;
      if (!object.visible || object.isLine || object.isPoints) continue;
      if (object.userData.isOutline) continue;
      return this.selectWholeObjects ? this.resolveSelection(object) : object;
    }

    return null;
  }

  // GLTFLoader splits a multi-material mesh into a Group holding one Mesh per
  // material — Blender's Cube.002 arrives as Cube002 wrapping Cube002_1 and
  // Cube002_2. Those halves aren't Blender objects, so moving one can never
  // round-trip; select the Group that can, which drags both halves together.
  //
  // Only multi-primitive meshes become Groups: Blender Empties load as plain
  // Object3D, and each GLB's root Group carries a transformNamespace. Neither
  // is mistaken for a split mesh, so this stops on the right node.
  resolveSelection(object) {
    let current = object;

    while (
      current.parent?.isGroup === true &&
      current.parent !== this.experience.scene &&
      !current.parent.userData.transformNamespace
    ) {
      current = current.parent;
    }

    return current;
  }

  select(object) {
    this.selected = object;

    if (object) this.controls.attach(object);
    else this.controls.detach();

    this.updateOverlay();
  }

  initOverlay() {
    this.overlay = document.createElement("div");
    this.overlay.style.cssText = [
      "position:fixed",
      "left:8px",
      "bottom:8px",
      "z-index:100",
      "padding:8px 10px",
      "max-width:320px",
      "font:11px/1.5 monospace",
      "color:#fff",
      "background:rgba(0,0,0,0.7)",
      "border:1px solid rgba(255,255,255,0.2)",
      "white-space:pre",
      "pointer-events:none",
    ].join(";");
    document.body.appendChild(this.overlay);
  }

  updateOverlay() {
    if (!this.enabled) {
      this.overlay.style.display = "none";
      return;
    }

    this.overlay.style.display = "block";

    const lines = [
      this.selected
        ? `selected: ${this.selected.name || this.selected.type}`
        : "selected: (click an object)",
      `mode: ${this.controls.mode}   space: ${this.controls.space}`,
    ];

    if (this.selected) {
      const { position: p, rotation: r, scale: s } = this.selected;
      const fmt = (a, b, c) =>
        [a, b, c].map((value) => value.toFixed(3).padStart(8)).join(" ");
      lines.push(
        `pos ${fmt(p.x, p.y, p.z)}`,
        `rot ${fmt(
          THREE.MathUtils.radToDeg(r.x),
          THREE.MathUtils.radToDeg(r.y),
          THREE.MathUtils.radToDeg(r.z),
        )}`,
        `scl ${fmt(s.x, s.y, s.z)}`,
      );
    }

    lines.push(
      "G/R/S or 1/2/3 mode · X space · P parent",
      `shift snap · L log · esc deselect · ctrl+S save (${this.edited.size})`,
      `ctrl+Z undo (${this.history.length}) · ctrl+shift+Z redo (${this.future.length})`,
      "then shift+I in Blender to pull the saved edits back",
    );

    if (this.status) lines.push(this.status);

    this.overlay.textContent = lines.join("\n");
  }

  // Paste-ready, same shape as the camera's log button.
  logTransform() {
    if (!this.selected) return;

    const round = (value) => Number(value.toFixed(4));
    const { position: p, rotation: r, scale: s } = this.selected;

    const snippet = [
      `// ${this.selected.name || this.selected.type}`,
      `object.position.set(${round(p.x)}, ${round(p.y)}, ${round(p.z)});`,
      `object.rotation.set(${round(r.x)}, ${round(r.y)}, ${round(r.z)});`,
      `object.scale.set(${round(s.x)}, ${round(s.y)}, ${round(s.z)});`,
    ].join("\n");

    console.log(snippet);
    navigator.clipboard?.writeText(snippet).catch(() => {});
  }

  update() {
    // The gizmo mode can change from the inspector's own object controls, and
    // dragging mutates the transform every frame.
    if (this.selected) this.updateOverlay();
  }
}
