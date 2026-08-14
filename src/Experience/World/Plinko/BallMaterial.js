import * as THREE from "three/webgpu";
import {
  positionLocal,
  positionWorld,
  float,
  normalLocal,
  texture as textureNode,
  vec2,
  vec3,
  mix,
  uniform,
} from "three/tsl";

/**
 * The ball material — the one lit, PBR surface in an otherwise fully baked
 * scene.
 *
 * Everything else here is `MeshBasicNodeMaterial` with the lighting painted
 * into the texture, which is right for geometry that never moves. The balls do
 * move, so baked lighting is exactly wrong for them: a ball rolling across the
 * table would carry a shadow that never changes. Making them the only
 * lit material means the ambient and directional lights already
 * sitting in Environment.js finally do something, and only to the balls.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COORDINATES ARE PROJECTED, NOT SAMPLED FROM UVs
 *
 * `sixth_Ball_Baked` carries atlas UVs — they address a small island inside
 * sixth.webp, not a 0..1 square. Feeding a tiling wood texture through them
 * samples a sliver of the atlas and stretches it over the whole sphere. So the
 * textured path projects triplanar coordinates from local position instead,
 * which ignores the mesh UVs entirely.
 *
 * Local position also means the grain is fixed to the ball and rotates with it,
 * so a rolling ball reads as a solid object rather than a sphere with a
 * sliding decal.
 * ---------------------------------------------------------------------------
 *
 * Textures are optional. With none present it builds a procedural wood grain,
 * so the game looks right without waiting on assets. See staticAssets.js for
 * how to switch real maps on.
 */

export const BALL_DEFAULTS = {
  // Procedural grain, used only when no colour map is supplied. Colours sit
  // close together on purpose — high contrast between them stops reading as
  // grain and starts reading as stripes.
  lightColor: "#8a5a30",
  darkColor: "#5b3a1f",
  ringFrequency: 9.0,
  grainScale: 6.0,
  // Width of the light body between dark lines, 0..1. Low values give thin
  // pinstripes; near 1 the lines fatten into bands.
  grainWidth: 0.45,

  // Multiplied into the colour map. Wood048 is a pale tan on its own, which
  // reads as cream against this cabinet — this warms it into the same brown
  // family as the baked woodwork. White = the texture untouched.
  tint: "#b8874e",

  // ---------------------------------------------------------------------
  // SHADOW GRADIENT. The bake has the bottom of the playfield sitting in
  // shadow, and an unlit ball rolling into it stays bright and floats off the
  // surface. This darkens the albedo along the table's own downhill axis so a
  // ball dims as it reaches the drain, matching what is painted underneath it.
  //
  // Driven from world position rather than per-instance data, so it costs
  // nothing extra and works for every ball in the single instanced draw. Balls
  // still up on the peg board project well above `shadeStart` and are
  // unaffected.
  //
  // Origin/axis/start/end are supplied by Plinko from the measured table
  // frame; only the floor is a taste value.
  // ---------------------------------------------------------------------
  shadeFloor: 0.2,
  shadeStart: 0,
  shadeEnd: -2,

  // ---------------------------------------------------------------------
  // SURFACE. Dry, old, unfinished timber — no varnish, no wax, nothing that
  // was ever polished. That is two separate things, and roughness alone only
  // buys the first:
  //
  //   - roughness 1 spreads the highlight until it has no shape, but a rough
  //     dielectric still has a specular lobe, and it still flares at grazing
  //     angles. On a sphere that lands as a bright rim all the way round the
  //     silhouette, which is exactly the "finished bead" read.
  //   - specularIntensity 0 removes the lobe outright, leaving pure diffuse.
  //     No glint from the directional light at any angle.
  //
  // The second is why the material is Physical rather than Standard: Standard
  // has no way to switch the highlight off. Everything else Physical adds
  // (clearcoat, sheen, transmission, iridescence) stays at its zero default
  // and compiles out.
  // ---------------------------------------------------------------------
  roughness: 1.0,
  metalness: 0.0,
  specularIntensity: 0.0,
  // The glossiest the roughness MAP is allowed to make the ball. The wood set
  // is photographed off finished timber, so its darker regions are gloss and
  // would put shine back on in patches; the map is remapped into
  // [roughnessFloor, 1] to keep its variation and drop its polish.
  roughnessFloor: 0.85,
  textureScale: 3.0,
  // Only reachable if a ballEnv cubemap is switched on in staticAssets.js.
  // Kept low for the same reason as the above — a mirrored environment is the
  // one thing that would undo all of it.
  envMapIntensity: 0.15,
  normalScale: 0.6,
};

/**
 * Triplanar sample: project the texture down all three axes and blend by the
 * normal. No UVs involved, no seams, and correct on a sphere.
 */
function triplanar(map, scale) {
  const p = positionLocal.mul(scale);

  // Weights from the squared normal, normalised so they sum to 1.
  const n = normalLocal.abs();
  const sum = n.x.add(n.y).add(n.z).add(0.0001);
  const w = n.div(sum);

  return textureNode(map, vec2(p.z, p.y))
    .mul(w.x)
    .add(textureNode(map, vec2(p.x, p.z)).mul(w.y))
    .add(textureNode(map, vec2(p.x, p.y)).mul(w.z));
}

/**
 * Wood grain through the ball's local space, as a turned bead would show it.
 *
 * Two things separate this from stripes on a sphere:
 *
 *  1. The ring radius is WARPED by a couple of sine octaves. Perfectly circular
 *     rings on a sphere read as a beehive, because every band is a clean
 *     latitude line. Warping breaks the symmetry so the rings wander.
 *
 *  2. The output is a thin dark LINE, not a 50/50 band. Grain in real wood is
 *     narrow dark lines separated by wide light body, so the sawtooth gets
 *     folded into a triangle and thresholded near its base.
 *
 * Returns 0 on a grain line and 1 on the body between lines.
 */
function proceduralGrain(uniforms) {
  const p = positionLocal.mul(uniforms.grainScale);

  const warp = p.y
    .mul(2.1)
    .sin()
    .mul(0.35)
    .add(p.x.mul(5.3).add(p.z.mul(3.1)).sin().mul(0.18));

  const rings = vec2(p.x, p.z)
    .length()
    .add(warp)
    .mul(uniforms.ringFrequency)
    .fract();

  // Fold the 0..1 sawtooth into a triangle: 0 at each ring boundary, 1 midway
  // between. Thresholding near the base leaves a thin dark line at the
  // boundary and light wood everywhere else.
  return rings.min(rings.oneMinus()).mul(2.0).smoothstep(0.0, uniforms.grainWidth);
}

/**
 * Brightness multiplier from where the ball sits along the table's downhill
 * axis: 1 up-table, falling to `shadeFloor` at the drain.
 *
 * The projection is the same dot product the physics frame uses, so the
 * gradient lines up with the surface rather than with world height.
 */
function shadeGradient(uniforms) {
  const along = positionWorld.sub(uniforms.shadeOrigin).dot(uniforms.shadeAxis);
  const lit = along.smoothstep(uniforms.shadeEnd, uniforms.shadeStart);
  return mix(uniforms.shadeFloor, float(1.0), lit);
}

/**
 * @param resources  Experience resources, for the optional wood maps
 * @param settings   overrides merged onto BALL_DEFAULTS
 * @returns { material, uniforms, textured }
 */
export function createBallMaterial({ resources, settings = {} } = {}) {
  const config = { ...BALL_DEFAULTS, ...settings };

  const uniforms = {
    ringFrequency: uniform(config.ringFrequency),
    grainScale: uniform(config.grainScale),
    grainWidth: uniform(config.grainWidth),
    textureScale: uniform(config.textureScale),
    roughnessFloor: uniform(config.roughnessFloor),
    tint: uniform(new THREE.Color(config.tint)),
    shadeOrigin: uniform(
      (config.shadeOrigin ?? new THREE.Vector3()).clone(),
    ),
    shadeAxis: uniform(
      (config.shadeAxis ?? new THREE.Vector3(0, 1, 0)).clone(),
    ),
    shadeStart: uniform(config.shadeStart),
    shadeEnd: uniform(config.shadeEnd),
    shadeFloor: uniform(config.shadeFloor),
    lightColor: uniform(new THREE.Color(config.lightColor)),
    darkColor: uniform(new THREE.Color(config.darkColor)),
  };

  const items = resources?.items ?? {};
  const colorMap = items.woodColor ?? null;
  const roughnessMap = items.woodRoughness ?? null;
  const normalMap = items.woodNormal ?? null;
  const envMap = items.ballEnv ?? null;

  const material = new THREE.MeshPhysicalNodeMaterial({
    roughness: config.roughness,
    metalness: config.metalness,
    specularIntensity: config.specularIntensity,
  });
  material.name = "plinko_ball";

  try {
    if (colorMap) {
      prepare(colorMap, THREE.SRGBColorSpace);
      material.colorNode = triplanar(colorMap, uniforms.textureScale)
        .rgb.mul(vec3(uniforms.tint))
        .mul(shadeGradient(uniforms));
    } else {
      material.colorNode = mix(
        vec3(uniforms.darkColor),
        vec3(uniforms.lightColor),
        proceduralGrain(uniforms),
      ).mul(shadeGradient(uniforms));
    }

    // Note this OVERRIDES `material.roughness` outright — with a map present,
    // `roughnessFloor` is the live control, not the material property.
    if (roughnessMap) {
      prepare(roughnessMap, THREE.NoColorSpace);
      material.roughnessNode = mix(
        uniforms.roughnessFloor,
        float(1.0),
        triplanar(roughnessMap, uniforms.textureScale).r,
      );
    }

    // Normal maps are tangent-space and triplanar blending them properly needs
    // a per-axis basis swizzle, which is more machinery than a ball this size
    // repays. Left on the standard path — it will use the mesh UVs, which for
    // a subtle grain normal reads fine even though they are atlas UVs.
    if (normalMap) {
      prepare(normalMap, THREE.NoColorSpace);
      material.normalMap = normalMap;
      material.normalScale = new THREE.Vector2(
        config.normalScale,
        config.normalScale,
      );
    }
  } catch (error) {
    // TSL graphs fail at build time, not load time, and a broken one takes the
    // whole render with it. A flat wooden ball is a better outcome than a
    // black screen.
    console.error("[Plinko] ball material graph failed, using flat:", error);
    material.colorNode = null;
    material.color = new THREE.Color(config.lightColor);
  }

  if (envMap) {
    // Set on the material rather than scene.environment: everything else in
    // the scene is unlit and baked, and this keeps the reflection strictly on
    // the balls.
    envMap.mapping = THREE.CubeReflectionMapping;
    material.envMap = envMap;
    material.envMapIntensity = config.envMapIntensity;
  }

  return { material, uniforms, textured: Boolean(colorMap) };
}

function prepare(map, colorSpace) {
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = colorSpace;
  map.needsUpdate = true;
}
