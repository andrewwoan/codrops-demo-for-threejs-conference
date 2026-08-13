// Hand-edited assets that the asset-reloader codegen does NOT manage.
// (codegen only scans .glb files in public/models and overwrites assets.js, so
// anything else — textures, cubemap skyboxes, models kept outside that folder —
// lives here and gets merged in Resources.js.)
//
// Supported `type` values (see Resources.startLoading):
//   "texture"     → THREE.TextureLoader        path: "/textures/foo.png"
//   "glbModel"    → GLTFLoader (draco + ktx2)  path: "/somewhere/foo.glb"
//   "ktx2Texture" → KTX2Loader                 path: "/textures/foo.ktx2"
//   "skybox"      → CubeTextureLoader          path: [px, nx, py, ny, pz, nz]

// SimpleBake COMBINED bakes out of Psychlogical Saftey/three.js config4.blend,
// one per bake group. Baked.glb ships with NO materials — World/Baked.js pairs
// each mesh with the texture matching its name prefix and builds the
// MeshBasicNodeMaterial. Lighting is already in the bake, hence basic.
const bakedTextures = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
].map((id) => ({
  name: `baked${id[0].toUpperCase()}${id.slice(1)}`,
  type: "texture",
  path: `/textures/baked/${id}.webp`,
}));

export default [...bakedTextures];
