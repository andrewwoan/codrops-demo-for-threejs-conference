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

// ---------------------------------------------------------------------------
// BALL PBR — optional. The balls are the one lit surface in the scene (see
// World/Plinko/BallMaterial.js); with none of these present they fall back to
// a procedural wood grain, so the game works without any of it.
//
// These are registered whether or not the files exist. Resources settles a
// failed asset and logs which path missed (see its onError), so a missing map
// costs one console line and BallMaterial falls back to procedural grain — it
// does not stall "ready".
//
// Drop in any CC0 wood set (Poly Haven, ambientCG) at 1K — the ball is tiny:
//   woodColor      → /textures/wood/color.webp      (basecolor / albedo)
//   woodRoughness  → /textures/wood/roughness.webp  (greyscale)
//   woodNormal     → /textures/wood/normal.webp     (tangent-space, OpenGL)
//
// The colour and roughness maps are projected triplanar from local position,
// so they tile at any scale and ignore the ball's baked atlas UVs. Tiling is
// tuned live under "Plinko Balls" in the #debug panel.
//
// ballEnv is a 6-face cubemap for reflections, in the order below. A studio or
// interior environment suits lacquered wood; skip it and the balls are lit by
// the ambient + directional in Environment.js alone. Left commented only
// because six missing files is six console lines, not because it is unsafe.
// ---------------------------------------------------------------------------
const ballTextures = [
  { name: "woodColor", type: "texture", path: "/textures/wood/color.webp" },
  {
    name: "woodRoughness",
    type: "texture",
    path: "/textures/wood/roughness.webp",
  },
  { name: "woodNormal", type: "texture", path: "/textures/wood/normal.webp" },
  // {
  //   name: "ballEnv",
  //   type: "skybox",
  //   path: [
  //     "/textures/env/px.webp", "/textures/env/nx.webp",
  //     "/textures/env/py.webp", "/textures/env/ny.webp",
  //     "/textures/env/pz.webp", "/textures/env/nz.webp",
  //   ],
  // },
];

export default [...bakedTextures, ...ballTextures];
