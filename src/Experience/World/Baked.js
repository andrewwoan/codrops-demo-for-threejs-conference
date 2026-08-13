import * as THREE from "three/webgpu";
import { Experience } from "../Experience";

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
//
// "fouth" is a typo in the Blender object name (`fouth_Cube.002_Baked`); its
// material and baked image are both spelled "fourth". Aliasing it here keeps
// the export reproducible without renaming the object in the .blend — fix the
// object name there and the "fouth" line can go.
const TEXTURE_BY_PREFIX = {
  first: "bakedFirst",
  second: "bakedSecond",
  third: "bakedThird",
  fourth: "bakedFourth",
  fouth: "bakedFourth",
  fifth: "bakedFifth",
  sixth: "bakedSixth",
};

export class Baked {
  constructor() {
    this.experience = Experience.getInstance();
    this.resources = this.experience.resources;
    this.model = this.resources.items.baked.scene;

    // One material per texture, shared by every mesh in that bake group
    // (the "sixth" group has two meshes).
    this.materials = new Map();

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

      const material = this.getMaterial(key);
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
  }

  getMaterial(key) {
    if (this.materials.has(key)) return this.materials.get(key);

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

    this.materials.set(key, material);
    return material;
  }

  resize() {}

  update() {}

  destroy() {
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
  }
}
