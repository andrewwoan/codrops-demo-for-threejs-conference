import * as THREE from "three/webgpu";
import { texture as textureNode, uniform, vec3 } from "three/tsl";
import { Experience } from "../Experience";
import { Wind } from "./Wind";

/**
 * Baked.glb — everything from the SimpleBake_Bakes collection, exported as one
 * draco mesh with NO materials at all. Each mesh is named `<id>_<source>_Baked`
 * ("third_bag_paper_0_Baked"), and each bake group has one COMBINED texture, so
 * the id prefix is the join between the two.
 *
 * The bakes already contain all lighting, so every mesh becomes an unlit
 * MeshBasicNodeMaterial — scene lights don't affect these at all.
 */

// Mesh-name prefix → the texture key registered in Utils/staticAssets.js.
// Add a line here whenever a new bake group is added in Blender.
const TEXTURE_BY_PREFIX = {
  first: "bakedFirst",
  second: "bakedSecond",
  third: "bakedThird",
  fourth: "bakedFourth",
  fifth: "bakedFifth",
  sixth: "bakedSixth",
  seventh: "bakedSeventh",
};

// Alpha cutout per bake group — anything not listed gets DEFAULT_ALPHA_TEST.
// Values dialled in from the "Baked Materials" panel under #debug.
//
// TO CHANGE: edit a number here and save (HMR reloads). To find a value first,
// load with #debug in the URL and drag "<key> alphaTest" in that panel, then
// paste what you settled on back in here.
const DEFAULT_ALPHA_TEST = 0;
const ALPHA_TEST_BY_PREFIX = {
  first: 0.14,
  second: 0.04,
};

// Bake groups rendered from both sides. Foliage is single-surface geometry —
// leaves have no back face of their own — so with the default FrontSide any
// leaf angled away from the camera disappears. Everything else is closed or
// wall-mounted geometry, where the back faces are never seen and culling them
// is free performance.
const DOUBLE_SIDED_PREFIXES = new Set(["first", "second"]);

// Bake groups that get per-island vertex wind — the plants. See World/Wind.js
// for what that does and how it's tuned; the short version is that every loose
// connected piece of these meshes (each leaf, petal, stem) is found at load and
// animated on its own. Only add a group here if it's foliage: the cost is one
// float per vertex plus a CPU island pass at load, and anything solid will just
// look like it's wobbling.
//
// Wind groups get their own material instance rather than sharing one per
// texture, because the material samples an island data texture built from one
// specific geometry.
const WIND_PREFIXES = new Set(["first", "second"]);

// ---------------------------------------------------------------------------
// BLACK CUTOFF — discards texels darker than the given value, keyed on
// brightness rather than alpha. 0 / absent = off.
//
// Off for every group right now. Add an entry to switch it on for one:
//   const BLACK_CUTOFF_BY_PREFIX = { second: 0.03 };
// A "<key> black cutoff" slider then appears in the same #debug panel (it only
// shows for groups listed here with a non-zero value). Rough feel: ~0.03 takes
// only the near-black texels, ~0.08 and up starts eating into the leaves.
// ---------------------------------------------------------------------------
const BLACK_CUTOFF_BY_PREFIX = {};

export class Baked {
  constructor() {
    this.experience = Experience.getInstance();
    this.resources = this.experience.resources;
    this.model = this.resources.items.baked.scene;

    // One material per texture, shared by every mesh in that bake group
    // (the "sixth" group has two meshes).
    this.materials = new Map();
    // Live black-cutoff threshold per material, for the debug slider.
    this.cutoffUniforms = new Map();

    // Per-island vertex wind for the WIND_PREFIXES groups.
    this.wind = new Wind();

    this.init();
  }

  init() {
    this.model.traverse((child) => {
      if (!child.isMesh) return;

      // GLTFLoader strips dots from node names, so `sixth_Plane.003_Baked`
      // arrives as `sixth_Plane003_Baked` — the prefix is unaffected either way.
      const prefix = child.name.split("_")[0].toLowerCase();
      const key = TEXTURE_BY_PREFIX[prefix];

      if (!key) {
        console.warn(
          `[Baked] "${child.name}" has no texture mapped for prefix "${prefix}" — ` +
            "add it to TEXTURE_BY_PREFIX. Left with the loader's default material.",
        );
        return;
      }

      const material = this.getMaterial(key, prefix, child);
      if (!material) return;

      // The GLB carries no materials, so GLTFLoader handed every mesh the same
      // shared default MeshStandardMaterial — nothing else references it.
      child.material = material;

      // Unlit and fully baked: shadow casting would just cost a shadow-map pass
      // for lighting that's already painted into the texture.
      child.castShadow = false;
      child.receiveShadow = false;
    });

    this.experience.scene.add(this.model);

    this.setupGUI();
  }

  getMaterial(key, prefix, mesh) {
    const isWindy = WIND_PREFIXES.has(prefix);

    // Wind materials can't be shared across meshes — each one is bound to the
    // island data texture of the geometry it was built for — so they're keyed
    // per mesh instead of per bake group. In practice both wind groups hold a
    // single mesh, so nothing is actually duplicated.
    const materialKey = isWindy ? `${key}:${mesh.name}` : key;
    if (this.materials.has(materialKey)) return this.materials.get(materialKey);

    const texture = this.resources.items[key];
    if (!texture) {
      console.warn(`[Baked] texture "${key}" never loaded — skipping.`);
      return null;
    }

    // These are loaded by TextureLoader rather than through GLTFLoader, so the
    // glTF conventions have to be applied by hand: glTF UVs have their origin
    // at the top-left, which is the opposite of TextureLoader's default and
    // would otherwise flip every bake vertically.
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(
      8,
      this.experience.renderer.renderer.getMaxAnisotropy?.() ?? 1,
    );
    texture.needsUpdate = true;

    const material = new THREE.MeshBasicNodeMaterial({ map: texture });
    material.name = key;

    // Cutout, not blending: `transparent` stays false so these keep rendering
    // in the opaque pass, depth-sorted like everything else. Alpha-blended
    // foliage would need back-to-front sorting per card to look right, and
    // the bakes don't have any partial transparency worth preserving.
    material.alphaTest = ALPHA_TEST_BY_PREFIX[prefix] ?? DEFAULT_ALPHA_TEST;

    material.side = DOUBLE_SIDED_PREFIXES.has(prefix)
      ? THREE.DoubleSide
      : THREE.FrontSide;

    const cutoff = BLACK_CUTOFF_BY_PREFIX[prefix];
    if (cutoff) this.applyBlackCutoff(material, texture, key, cutoff);

    // Sets material.positionNode, and adds the island index attribute to the
    // geometry. Must come after the material exists and before it's compiled.
    if (isWindy) this.wind.apply(mesh, material);

    this.materials.set(materialKey, material);
    return material;
  }

  /**
   * Discard texels darker than `cutoff`, using the material's own alphaTest to
   * do the discarding — opacity is driven to 0 below the threshold and 1 above,
   * so this stays a cutout in the opaque pass rather than becoming blended
   * transparency (no sorting artefacts).
   *
   * The threshold lives in a uniform so the debug slider retunes it without
   * recompiling the shader.
   */
  applyBlackCutoff(material, texture, key, cutoff) {
    const uCutoff = uniform(cutoff);
    const map = textureNode(texture);

    // Rec. 709 luma — matches how the eye weights the channels, so a dark
    // saturated leaf survives while a genuinely black texel doesn't.
    const luma = map.rgb.dot(vec3(0.2126, 0.7152, 0.0722));

    material.colorNode = map;
    // Narrow ramp instead of a hard step: one texel of softness keeps the cut
    // edge from crawling with jaggies as the camera moves.
    material.opacityNode = luma.smoothstep(uCutoff.mul(0.7), uCutoff);
    material.alphaTest = 0.5;

    this.cutoffUniforms.set(key, uCutoff);
  }

  /**
   * One alphaTest slider per bake group, for finding the value that just clears
   * the black fringe without eating the thin edges of the leaves. Drawn only
   * under #debug — `experience.gui` is a no-op stub otherwise.
   */
  setupGUI() {
    const folder = this.experience.gui.addFolder("Baked Materials");

    for (const [key, uCutoff] of this.cutoffUniforms) {
      // Pure uniform write — no shader recompile, so this is smooth to drag.
      folder
        .add({ cutoff: uCutoff.value }, "cutoff", 0, 0.3, 0.005)
        .name(`${key} black cutoff`)
        .onChange((v) => {
          uCutoff.value = v;
        });
    }

    for (const material of this.materials.values()) {
      folder
        // `material.name` rather than the map key: wind materials are keyed per
        // mesh, so the key carries a mesh name the slider doesn't need.
        .add(material, "alphaTest", 0, 1, 0.01)
        .name(`${material.name} alphaTest`)
        .onChange(() => {
          // alphaTest changes the compiled shader, not just a uniform.
          material.needsUpdate = true;
        });
    }

    this.wind.setupGUI(this.experience.gui);
  }

  resize() {}

  update() {
    this.wind.update(this.experience.time.elapsed);
  }

  destroy() {
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
    this.wind.destroy();
  }
}
