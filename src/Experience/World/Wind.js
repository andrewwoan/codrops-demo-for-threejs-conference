import * as THREE from "three/webgpu";
import {
  attribute,
  cos,
  cross,
  float,
  int,
  ivec2,
  mix,
  modelWorldMatrix,
  modelWorldMatrixInverse,
  positionLocal,
  sin,
  textureLoad,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import { Experience } from "../Experience";

/**
 * Per-island vertex wind for the baked foliage.
 *
 * The Blender bake joins a whole collection into one mesh — `first` alone is a
 * rose shrub, a hazel shrub, corner ivy and a pile of dead floor leaves welded
 * into a single 220k-vert object — so there is no per-plant node to animate.
 * What there IS is topology: every leaf card, petal and stem is a separate
 * connected component ("island") of that mesh. 18,917 of them in `first`, 1,749
 * in `second`.
 *
 * So the whole system is: find the islands on the CPU once at load, give each
 * one its own centroid / size / random seed, and in the vertex shader rotate
 * each island rigidly about its own centroid. Rigid rotation is the key choice —
 * it never stretches a leaf, works no matter which way the plant faces (upright
 * shrub, ivy hanging off a wall, leaf lying flat on the floor), and needs no
 * guess about where the "root" of an island is.
 *
 * Two things stop it looking like one big synchronised shimmer:
 *
 *   1. Size drives motion, the way it does physically. A pendulum's frequency
 *      goes as 1/sqrt(length), so a small leaf gets a fast, wider-angled
 *      flutter and a big vine gets a slow, shallow sway — from one formula, no
 *      per-plant tagging.
 *   2. A travelling gust. Amplitude is modulated by a slow wave moving along the
 *      wind direction, so motion arrives in passes across the scene instead of
 *      every plant breathing in time.
 *
 * On top of that each island carries its own random phase, frequency jitter and
 * rotation-axis jitter, and a second faster rotation about a roughly
 * perpendicular axis so the motion is a flutter rather than a metronome.
 *
 * The one case the size law gets wrong is dead leaves lying on the floor — it
 * treats them as small, light and therefore lively, when they're resting on
 * something. They're picked out by pose rather than by name and damped; see the
 * ground-litter block in DEFAULTS.
 *
 * All of that per-island data lives in a small float DataTexture (3 texels per
 * island) rather than in vertex attributes — the mesh only carries one extra
 * float per vertex, the island index. Everything else is a uniform, so every
 * slider in the #debug "Wind" panel retunes live with no rebuild.
 */

// Positions closer than this collapse to one vertex before islands are found.
// GLTFLoader splits a vertex per unique normal/UV combination, so one leaf card
// can arrive as several index-disconnected pieces that sit on top of each other.
// Without this weld those pieces would land in different islands and visibly
// tear apart. The duplicates are bit-identical copies, so the tolerance only has
// to be small enough never to merge two genuinely different vertices.
const WELD_TOLERANCE = 1e-4;

// Per-island record in the data texture:
//   texel 0 — centroid.xyz, radius
//   texel 1 — axis jitter.xyz, sway phase
//   texel 2 — frequency jitter, angle jitter, flutter phase, unused
//   texel 3 — average normal.xyz (object space, unnormalised), unused
const TEXELS_PER_ISLAND = 4;
const TEXTURE_WIDTH = 512;

// How far the 1/sqrt(size) law is allowed to push frequency and angle away from
// their base values. Without a floor the ⌀5-unit vine structure in `second`
// would freeze solid; without a ceiling a stray 2-vertex island would buzz.
const FREQUENCY_CLAMP = [0.45, 1.8];
const ANGLE_CLAMP = [0.3, 1.7];

const DEFAULTS = {
  // Master multiplier on every rotation angle. The one slider to reach for if
  // the whole thing is too much or too little.
  strength: 1,
  // Wind heading in world XZ. Islands rotate about an axis perpendicular to
  // this, so they nod along the wind. Keep it horizontal — a vertical direction
  // degenerates the cross product that builds the axis.
  directionDegrees: 25,
  // Radians of sway for an island of `referenceRadius`, before jitter.
  baseAngle: 0.105,
  // Radians/second for that same reference island (~0.38 Hz). Deliberately slow:
  // the size law multiplies this by up to 1.8 for the smallest leaves, and the
  // flutter term multiplies it again, so the fastest thing in the scene still
  // lands around 1.8 Hz — a breeze rather than a buzz.
  baseFrequency: 2.4,
  // Island radius the two values above are quoted at — roughly a leaf card.
  referenceRadius: 0.12,
  // Hard ceiling on how far any island's outermost vertex may travel, in world
  // units. This is what keeps the one huge vine island in `second` from looking
  // like it has come off the wall: the 1/sqrt law already shrinks its angle,
  // and this caps whatever is left.
  maxTipTravel: 0.05,
  // Second rotation, about a roughly perpendicular axis — turns a pendulum into
  // a flutter. Fraction of the sway angle, and multiple of the sway frequency.
  flutterAmount: 0.45,
  // Increased frequency ratio for the flutter rotation.
  flutterSpeed: 2.6,
  // How far each island's rotation axes are randomised away from the shared
  // wind-derived axis. 0 = every island nods in exactly the same plane.
  axisJitter: 0.55,
  // Travelling gust. Amplitude is scaled by `base + amount * sin(...)`, so with
  // these numbers it breathes between 30% and 100% of full strength.
  gustBase: 0.65,
  gustAmount: 0.35,
  // Radians/second, and radians per world unit along the wind direction. The
  // scale sets the gust wavelength — 0.9 gives a ~7-unit wave, about a third of
  // the width of the room.
  gustSpeed: 0.55,
  gustScale: 0.9,

  // --- ground litter -------------------------------------------------------
  // Dead leaves lying on the floor are the one case the size law gets wrong.
  // They're small, so it hands them the fast wide-angled flutter it gives a
  // leaf still on a branch — but a leaf on the ground is resting on something,
  // not hanging in the air, and it reads as far more motion because it sits
  // isolated against flat floorboards instead of buried in a canopy.
  //
  // They can't be picked out by name (the bake joined them into the shrub
  // mesh), but they can be picked out by pose: lying face-up, down at floor
  // level. Nothing still attached to a plant is both.
  //
  // World Y below which an island counts as floor litter — the fade runs from
  // half this value to this value. The dead-leaf group sits at Y 0.07-0.17 and
  // the next foliage above it starts well clear, so 0.35 separates them with
  // room to spare.
  litterHeight: 0.35,
  // How face-up it also has to be, as |normal · up|. Low, because this is here
  // to spare upright things near the floor — stems entering a planter — rather
  // than to make a fine distinction.
  litterUpness: 0.15,
  // What a full-litter island's sway angle and frequency get multiplied by.
  litterDamping: 0.2,
  litterSlowdown: 0.5,
};

/** Rodrigues' rotation of `v` about the unit axis `axis` by `angle` radians. */
function rotateAboutAxis(v, axis, angle) {
  const c = cos(angle);
  const s = sin(angle);
  return v
    .mul(c)
    .add(cross(axis, v).mul(s))
    .add(axis.mul(axis.dot(v)).mul(c.oneMinus()));
}

/** Deterministic PRNG, so a reload always produces the same plants. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Island topology is a pure function of the geometry, so cache it — HMR and any
// future second call get the analysis for free.
const ISLAND_CACHE = new WeakMap();

/**
 * Label every vertex with the connected component it belongs to, and measure
 * each component.
 *
 * Union-find over the triangle list, preceded by a positional weld (see
 * WELD_TOLERANCE). Runs about 100-200ms for a 220k-vert mesh, once, during the
 * post-load frame where the scene is being built anyway.
 */
function buildIslands(geometry) {
  const cached = ISLAND_CACHE.get(geometry);
  if (cached) return cached;

  const positions = geometry.attributes.position.array;
  const vertexCount = geometry.attributes.position.count;

  const parent = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) parent[i] = i;

  const find = (x) => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    // Path compression — without it the weld pass degenerates on long chains.
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };

  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  // --- weld coincident vertices -------------------------------------------
  // Spatial hash rather than a string-keyed Map: 220k string allocations is the
  // difference between a hitch you notice and one you don't. Buckets hold only
  // a handful of entries, and the quantised coordinates are re-checked exactly,
  // so a hash collision costs a comparison rather than a wrong weld.
  const gridX = new Int32Array(vertexCount);
  const gridY = new Int32Array(vertexCount);
  const gridZ = new Int32Array(vertexCount);
  const buckets = new Map();

  for (let i = 0; i < vertexCount; i++) {
    const x = Math.round(positions[i * 3] / WELD_TOLERANCE);
    const y = Math.round(positions[i * 3 + 1] / WELD_TOLERANCE);
    const z = Math.round(positions[i * 3 + 2] / WELD_TOLERANCE);
    gridX[i] = x;
    gridY[i] = y;
    gridZ[i] = z;

    const key =
      (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) |
      0;

    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, [i]);
      continue;
    }

    let matched = false;
    for (const j of bucket) {
      if (gridX[j] === x && gridY[j] === y && gridZ[j] === z) {
        union(j, i);
        matched = true;
        break;
      }
    }
    if (!matched) bucket.push(i);
  }

  // One representative per distinct position. Snapshot it now, before the
  // triangle pass merges these groups further, so centroids aren't skewed by
  // however many copies of a vertex the exporter happened to emit.
  const isRepresentative = new Uint8Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    if (find(i) === i) isRepresentative[i] = 1;
  }

  // --- connect through the triangles ---------------------------------------
  const index = geometry.index;
  if (index) {
    const indices = index.array;
    for (let i = 0; i < indices.length; i += 3) {
      union(indices[i], indices[i + 1]);
      union(indices[i], indices[i + 2]);
    }
  } else {
    for (let i = 0; i < vertexCount; i += 3) {
      union(i, i + 1);
      union(i, i + 2);
    }
  }

  // --- label and measure ----------------------------------------------------
  const islandIndex = new Float32Array(vertexCount);
  const labelByRoot = new Map();
  let islandCount = 0;

  for (let i = 0; i < vertexCount; i++) {
    const root = find(i);
    let label = labelByRoot.get(root);
    if (label === undefined) {
      label = islandCount++;
      labelByRoot.set(root, label);
    }
    islandIndex[i] = label;
  }

  const centers = new Float32Array(islandCount * 3);
  const radii = new Float32Array(islandCount);
  const memberCount = new Uint32Array(islandCount);

  // Which way the island faces on average — a leaf card's overall facing. Left
  // unnormalised: a curled or double-sided island sums to a short vector, and
  // the shader divides by the length it actually has, so "no clear facing"
  // comes out as "not face-up" rather than as a normalised guess.
  const normals = geometry.attributes.normal?.array ?? null;
  const averageNormals = new Float32Array(islandCount * 3);

  for (let i = 0; i < vertexCount; i++) {
    if (!isRepresentative[i]) continue;
    const label = islandIndex[i];
    centers[label * 3] += positions[i * 3];
    centers[label * 3 + 1] += positions[i * 3 + 1];
    centers[label * 3 + 2] += positions[i * 3 + 2];
    if (normals) {
      averageNormals[label * 3] += normals[i * 3];
      averageNormals[label * 3 + 1] += normals[i * 3 + 1];
      averageNormals[label * 3 + 2] += normals[i * 3 + 2];
    }
    memberCount[label]++;
  }

  for (let label = 0; label < islandCount; label++) {
    const n = memberCount[label] || 1;
    centers[label * 3] /= n;
    centers[label * 3 + 1] /= n;
    centers[label * 3 + 2] /= n;
    averageNormals[label * 3] /= n;
    averageNormals[label * 3 + 1] /= n;
    averageNormals[label * 3 + 2] /= n;
  }

  // Radius = distance from the centroid to the furthest vertex, i.e. how far
  // the outermost point of this island is from its pivot. Both the size law and
  // the tip-travel cap are expressed against it.
  for (let i = 0; i < vertexCount; i++) {
    if (!isRepresentative[i]) continue;
    const label = islandIndex[i];
    const dx = positions[i * 3] - centers[label * 3];
    const dy = positions[i * 3 + 1] - centers[label * 3 + 1];
    const dz = positions[i * 3 + 2] - centers[label * 3 + 2];
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance > radii[label]) radii[label] = distance;
  }

  const result = {
    islandIndex,
    centers,
    radii,
    averageNormals,
    islandCount,
    vertexCount,
  };
  ISLAND_CACHE.set(geometry, result);
  return result;
}

/** Pack the per-island records into an RGBA float texture. */
function buildIslandTexture(islands) {
  const texelCount = islands.islandCount * TEXELS_PER_ISLAND;
  const height = Math.ceil(texelCount / TEXTURE_WIDTH);
  const data = new Float32Array(TEXTURE_WIDTH * height * 4);

  const random = mulberry32(islands.islandCount * 2654435761);
  const TAU = Math.PI * 2;

  for (let i = 0; i < islands.islandCount; i++) {
    const base = i * TEXELS_PER_ISLAND * 4;

    data[base] = islands.centers[i * 3];
    data[base + 1] = islands.centers[i * 3 + 1];
    data[base + 2] = islands.centers[i * 3 + 2];
    data[base + 3] = islands.radii[i];

    // Random direction on the unit sphere — used in the shader to push this
    // island's rotation axes off the shared wind axis.
    const z = random() * 2 - 1;
    const theta = random() * TAU;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    data[base + 4] = Math.cos(theta) * r;
    data[base + 5] = Math.sin(theta) * r;
    data[base + 6] = z;
    data[base + 7] = random() * TAU;

    data[base + 8] = 0.75 + random() * 0.6; // frequency jitter
    data[base + 9] = 0.7 + random() * 0.6; // angle jitter
    data[base + 10] = random() * TAU; // flutter phase
    data[base + 11] = 0;

    data[base + 12] = islands.averageNormals[i * 3];
    data[base + 13] = islands.averageNormals[i * 3 + 1];
    data[base + 14] = islands.averageNormals[i * 3 + 2];
    data[base + 15] = 0;
  }

  const texture = new THREE.DataTexture(
    data,
    TEXTURE_WIDTH,
    height,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.colorSpace = THREE.NoColorSpace;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  return texture;
}

export class Wind {
  constructor() {
    this.params = { ...DEFAULTS };
    this.textures = [];

    const direction = new THREE.Vector3();

    this.uniforms = {
      time: uniform(0),
      strength: uniform(DEFAULTS.strength),
      direction: uniform(direction),
      baseAngle: uniform(DEFAULTS.baseAngle),
      baseFrequency: uniform(DEFAULTS.baseFrequency),
      referenceRadius: uniform(DEFAULTS.referenceRadius),
      maxTipTravel: uniform(DEFAULTS.maxTipTravel),
      flutterAmount: uniform(DEFAULTS.flutterAmount),
      flutterSpeed: uniform(DEFAULTS.flutterSpeed),
      axisJitter: uniform(DEFAULTS.axisJitter),
      gustBase: uniform(DEFAULTS.gustBase),
      gustAmount: uniform(DEFAULTS.gustAmount),
      gustSpeed: uniform(DEFAULTS.gustSpeed),
      gustScale: uniform(DEFAULTS.gustScale),
      litterHeight: uniform(DEFAULTS.litterHeight),
      litterUpness: uniform(DEFAULTS.litterUpness),
      litterDamping: uniform(DEFAULTS.litterDamping),
      litterSlowdown: uniform(DEFAULTS.litterSlowdown),
    };

    this.applyDirection(DEFAULTS.directionDegrees);
  }

  applyDirection(degrees) {
    const radians = THREE.MathUtils.degToRad(degrees);
    this.uniforms.direction.value.set(Math.cos(radians), 0, Math.sin(radians));
  }

  /**
   * Analyse `mesh`, attach the island index attribute, and point the material's
   * positionNode at the wind graph.
   *
   * The material must belong to this mesh alone — the island data texture it
   * samples is built from this geometry.
   */
  apply(mesh, material) {
    const geometry = mesh.geometry;

    const startedAt = performance.now();
    const islands = buildIslands(geometry);
    const elapsed = performance.now() - startedAt;

    if (islands.islandCount < 2) {
      console.warn(
        `[Wind] "${mesh.name}" came back as ${islands.islandCount} connected ` +
          "island(s) — the whole mesh would sway as one lump, so skipping it. " +
          "Check that the leaves aren't welded to each other in Blender.",
      );
      return;
    }

    geometry.setAttribute(
      "aIsland",
      new THREE.BufferAttribute(islands.islandIndex, 1),
    );

    if (Experience.getInstance()?.debug) {
      // Sanity check when a new group is added to WIND_PREFIXES: a healthy
      // foliage mesh reports thousands of islands. A handful means the leaves
      // are welded together in Blender and the whole thing will sway as a slab.
      const median = [...islands.radii].sort((a, b) => a - b)[
        islands.islandCount >> 1
      ];
      console.info(
        `[Wind] ${mesh.name}: ${islands.islandCount} islands from ` +
          `${islands.vertexCount} verts (median radius ${median.toFixed(3)}, ` +
          `largest ${Math.max(...islands.radii).toFixed(2)}) in ` +
          `${elapsed.toFixed(0)}ms`,
      );
    }

    const texture = buildIslandTexture(islands);
    this.textures.push(texture);

    material.positionNode = this.buildPositionNode(texture);

    // Vertices now sit slightly outside the geometry they were computed from.
    // The displacement is capped at maxTipTravel, so padding the bounds by a
    // little more than that removes any chance of an island popping at the edge
    // of the frustum.
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    geometry.boundingSphere.radius += DEFAULTS.maxTipTravel * 4;
    geometry.boundingBox.expandByScalar(DEFAULTS.maxTipTravel * 4);

    return islands;
  }

  buildPositionNode(texture) {
    const u = this.uniforms;
    const islandIndex = attribute("aIsland", "float");
    const width = float(TEXTURE_WIDTH);

    // Island record `slot` as a texel fetch. The row/column split is done in
    // floats and converted at the end — integer division of node values isn't
    // worth relying on for something this cheap.
    const fetch = (slot) => {
      const texelIndex = islandIndex.mul(TEXELS_PER_ISLAND).add(slot);
      const row = texelIndex.div(width).floor();
      const column = texelIndex.sub(row.mul(width));
      return textureLoad(texture, ivec2(int(column), int(row)));
    };

    const record0 = fetch(0);
    const record1 = fetch(1);
    const record2 = fetch(2);
    const record3 = fetch(3);

    const center = record0.xyz;
    // Loose single vertices come through with radius 0; the floor keeps the
    // size law and the tip-travel cap from dividing by it.
    const radius = record0.w.max(0.005);
    const jitter = record1.xyz;
    const swayPhase = record1.w;
    const frequencyJitter = record2.x;
    const angleJitter = record2.y;
    const flutterPhase = record2.z;

    // Pendulum scaling: period goes as sqrt(length), so this is >1 for anything
    // smaller than the reference leaf and <1 for anything bigger. It is the
    // single reason a rose petal and a two-metre ivy runner read as different
    // kinds of plant without either being tagged as one.
    const sizeFactor = u.referenceRadius.div(radius).sqrt();

    const worldCenter = modelWorldMatrix.mul(vec4(center, 1)).xyz;

    // --- ground litter --------------------------------------------------------
    // Is this island a dead leaf lying on the floor? Two tests, both in world
    // space so they mean the same thing for every mesh regardless of how it's
    // oriented in the GLB: is it down at floor level, and is it lying face-up.
    //
    // The normal is divided by its own length rather than normalised, so an
    // island with no coherent facing (a curled or double-sided one, which sums
    // to near zero) scores 0 — not face-up — instead of producing a NaN.
    const worldNormal = modelWorldMatrix.mul(vec4(record3.xyz, 0)).xyz;
    const faceUp = worldNormal.y
      .abs()
      .div(worldNormal.length().max(0.0001))
      .smoothstep(u.litterUpness, 1);
    const nearGround = worldCenter.y
      .smoothstep(u.litterHeight.mul(0.5), u.litterHeight)
      .oneMinus();
    const litter = faceUp.mul(nearGround);

    const frequency = u.baseFrequency
      .mul(sizeFactor.clamp(FREQUENCY_CLAMP[0], FREQUENCY_CLAMP[1]))
      .mul(frequencyJitter)
      .mul(mix(float(1), u.litterSlowdown, litter));

    const angle = u.baseAngle
      .mul(sizeFactor.clamp(ANGLE_CLAMP[0], ANGLE_CLAMP[1]))
      .mul(angleJitter)
      .mul(u.strength)
      // Absolute brake on the biggest islands: whatever the size law says, the
      // outermost vertex may not travel further than this.
      .min(u.maxTipTravel.div(radius))
      .mul(mix(float(1), u.litterDamping, litter));

    // --- travelling gust ------------------------------------------------------
    // Phase from the island's WORLD position, so the wave crosses the room
    // rather than each mesh's own local space, and the two plant meshes stay in
    // one shared weather system despite their different object orientations.
    const windDirection = u.direction.normalize();
    const gustPhase = worldCenter.dot(windDirection).mul(u.gustScale);
    const gust = u.gustBase.add(
      u.gustAmount.mul(sin(u.time.mul(u.gustSpeed).add(gustPhase))),
    );

    // --- rotation axes --------------------------------------------------------
    // Built in world space from the wind heading, then pulled back into object
    // space. Doing it this way means the wind stays physically consistent for a
    // mesh that is rotated in the GLB (the wall ivy is turned 90° about Z) and
    // survives anything transform-overrides.json does to the model later.
    const swayAxisWorld = cross(vec3(0, 1, 0), windDirection)
      .add(jitter.mul(u.axisJitter))
      .normalize();
    const flutterAxisWorld = cross(swayAxisWorld, windDirection)
      .add(jitter.zxy.mul(u.axisJitter.mul(0.5)))
      .normalize();

    const swayAxis = modelWorldMatrixInverse
      .mul(vec4(swayAxisWorld, 0))
      .xyz.normalize();
    const flutterAxis = modelWorldMatrixInverse
      .mul(vec4(flutterAxisWorld, 0))
      .xyz.normalize();

    // --- compose --------------------------------------------------------------
    const swayAngle = angle
      .mul(gust)
      .mul(sin(u.time.mul(frequency).add(swayPhase)));

    const flutterAngle = angle
      .mul(u.flutterAmount)
      .mul(gust)
      .mul(sin(u.time.mul(frequency.mul(u.flutterSpeed)).add(flutterPhase)));

    // Rigid rotation about the island's own centroid — the island never
    // stretches, and its centre of mass stays exactly where Blender put it, so
    // nothing drifts out of its pot however long the page is left open.
    const local = positionLocal.sub(center);
    const rotated = rotateAboutAxis(
      rotateAboutAxis(local, swayAxis, swayAngle),
      flutterAxis,
      flutterAngle,
    );

    return center.add(rotated);
  }

  update(elapsedMilliseconds) {
    this.uniforms.time.value = elapsedMilliseconds * 0.001;
  }

  /**
   * Every control here is a live uniform — nothing below rebuilds the island
   * analysis, so all of it is safe to drag while the scene runs.
   */
  setupGUI(gui) {
    const folder = gui.addFolder("Wind");
    const u = this.uniforms;

    const bind = (key, min, max, step, label) =>
      folder
        .add(this.params, key, min, max, step)
        .name(label)
        .onChange((value) => {
          u[key].value = value;
        });

    bind("strength", 0, 3, 0.01, "Strength");
    folder
      .add(this.params, "directionDegrees", 0, 360, 1)
      .name("Direction")
      .onChange((value) => this.applyDirection(value));

    const motion = folder.addFolder("Motion");
    const bindIn = (group, key, min, max, step, label) =>
      group
        .add(this.params, key, min, max, step)
        .name(label)
        .onChange((value) => {
          u[key].value = value;
        });

    bindIn(motion, "baseAngle", 0, 0.4, 0.001, "Sway angle (rad)");
    bindIn(motion, "baseFrequency", 0, 12, 0.05, "Sway speed (rad/s)");
    bindIn(motion, "referenceRadius", 0.02, 0.5, 0.005, "Reference leaf size");
    bindIn(motion, "maxTipTravel", 0, 0.3, 0.001, "Max tip travel");
    bindIn(motion, "flutterAmount", 0, 1.5, 0.01, "Flutter amount");
    bindIn(motion, "flutterSpeed", 1, 6, 0.05, "Flutter speed x");
    bindIn(motion, "axisJitter", 0, 1.5, 0.01, "Axis variation");

    const gustFolder = folder.addFolder("Gust");
    bindIn(gustFolder, "gustBase", 0, 1, 0.01, "Base");
    bindIn(gustFolder, "gustAmount", 0, 1, 0.01, "Amount");
    bindIn(gustFolder, "gustSpeed", 0, 2, 0.01, "Speed");
    bindIn(gustFolder, "gustScale", 0, 4, 0.01, "Wave scale");

    // Damping for the dead leaves on the floor. To see exactly which islands
    // are being caught, drag "Damping" to 0 — anything that stops moving is
    // classified as litter.
    const litter = folder.addFolder("Ground litter");
    bindIn(litter, "litterDamping", 0, 1, 0.01, "Damping");
    bindIn(litter, "litterSlowdown", 0.1, 1, 0.01, "Slowdown");
    bindIn(litter, "litterHeight", 0, 2, 0.01, "Floor height");
    bindIn(litter, "litterUpness", 0, 1, 0.01, "Face-up threshold");

    return folder;
  }

  destroy() {
    for (const texture of this.textures) texture.dispose();
    this.textures.length = 0;
  }
}
