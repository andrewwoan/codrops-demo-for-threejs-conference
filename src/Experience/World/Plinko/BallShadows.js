import * as THREE from "three/webgpu";
import { attribute, float, uniform, uv, vec3 } from "three/tsl";

/**
 * Soft contact shadows for the ball pool — faked, not cast.
 *
 * A real shadow map is the wrong tool here twice over. The scene is fully baked
 * (see Baked.js): nothing but the balls is lit at all, so a shadow map would
 * exist to darken a texture that already has its own painted shadows in it, and
 * the two would disagree. And the cost is a whole extra depth pass per frame
 * for fifty objects that are each a few pixels across.
 *
 * What actually reads as a shadow at this size is a soft dark blob under the
 * ball, so that is what this draws: one quad per ball, lying flat on whichever
 * surface the ball is rolling on, with a radial gradient for the falloff. The
 * gradient is procedural — no texture to load, no atlas slot, and softness and
 * size stay tunable live.
 *
 * It is one InstancedMesh for the whole pool, sharing the ball pool's indices:
 * ball `n` owns shadow `n`. That makes the whole system one extra draw call and
 * one matrix write per live ball per frame.
 *
 * Height: the balls live in 2D solvers pinned to their surface, so almost every
 * shadow is a straight contact shadow. The exception is a ball riding the arch
 * (see ArchRail.js), which climbs away from the playfield — that one grows and
 * fades out with the climb, via a per-instance alpha attribute.
 */

export const SHADOW_DEFAULTS = {
  // Not black: the cabinet is warm wood, and a neutral black blob on it reads
  // as a hole rather than a shadow. Dark enough to still read against the
  // playfield, which is itself dark wood in the bake.
  color: "#1d1108",

  // Opacity at the darkest point, under the ball.
  strength: 0.54,

  // Shadow radius as a multiple of the ball radius.
  //
  // Tight, because this is a contact shadow rather than a cast one — the ball
  // is never more than touching the surface, and a wide soft disc under it
  // reads as the ball floating. The floor on this value is what makes it
  // visible at all: the ball is a sphere of radius 1r sitting ON the surface,
  // so anything near 1 is hidden behind the ball's own silhouette and only a
  // hairline rim ever reaches the screen. 1.55 plus the offset below keeps a
  // clear crescent out from under it.
  spread: 1.55,

  // Fraction of the radius that stays at full strength before the falloff
  // starts. 0 is a pure gradient from the centre; higher values give a solid
  // core with a soft rim, which is what a contact shadow actually looks like —
  // and at this spread the core is what carries it, since the rim is small.
  core: 0.34,

  // Exponent on the falloff. Above 1 the edge softens and the shadow pulls in
  // toward its centre; below 1 it fattens toward a hard disc.
  falloff: 1.5,

  // Clearance above the surface, in ball radii, so the quad never z-fights the
  // board it lies on.
  lift: 0.04,

  // Offset from directly under the ball, in ball radii, along the surface's own
  // right/up axes.
  //
  // Effectively centred, with a hair of uphill bias. A directional offset reads
  // as a cast shadow and needs to agree with wherever the bake's key light was,
  // which at this size is more trouble than it buys; sitting under the ball
  // reads as ambient contact and is right from every camera angle. The nudge
  // uphill just tips the visible crescent to the far side of the ball, away
  // from the camera.
  offsetX: 0,
  offsetY: 0.05,

  // --- On the arch rail ------------------------------------------------
  // A ball riding the arch gets its shadow on the arch, not on the playfield
  // below it. Two things differ up there: the surface is curved along the
  // direction of travel, and it is narrow.

  // Clearance above the rail, in ball radii. Larger than `lift` because the
  // arch curves AWAY under a flat quad — the middle sits on the surface while
  // the leading and trailing edges dip inside it and get depth-clipped, which
  // eats the disc down to a band. This is the sag it has to clear.
  railLift: 0.18,

  // Shadow size as a fraction of the rail's measured running width. The disc is
  // whichever is smaller, this or the normal `spread` size, so it can never
  // overhang the sides of the arch into open air.
  railFit: 0.9,
};

const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _hidden = new THREE.Matrix4().makeScale(0, 0, 0);
const _along = new THREE.Vector3();
const _across = new THREE.Vector3();
const _surface = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();

export class BallShadows {
  /**
   * @param parent     Object3D to add the mesh to
   * @param count      pool size — must match the ball pool, indices are shared
   * @param radius     world-space ball radius
   * @param railWidth  running width of the arch, 0 if there is no rail
   * @param settings   overrides merged onto SHADOW_DEFAULTS
   */
  constructor({ parent, count, radius, railWidth = 0, settings = {} }) {
    this.radius = radius;
    this.railWidth = railWidth;
    this.settings = { ...SHADOW_DEFAULTS, ...settings };

    this.uniforms = {
      color: uniform(new THREE.Color(this.settings.color)),
      strength: uniform(this.settings.strength),
      core: uniform(this.settings.core),
      falloff: uniform(this.settings.falloff),
    };

    // Per-instance opacity. Only the arch ever moves it off 1, but it also
    // carries the spawn fade-in for free.
    this.alphaAttribute = new THREE.InstancedBufferAttribute(
      new Float32Array(count),
      1,
    );
    this.alphaAttribute.setUsage(THREE.DynamicDrawUsage);

    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.setAttribute("shadowAlpha", this.alphaAttribute);

    this.mesh = new THREE.InstancedMesh(geometry, this.build(), count);
    this.mesh.name = "plinko_ball_shadows";
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Same reasoning as the balls: the pool is always on screen, and culling it
    // would mean recomputing the bounding sphere every frame.
    this.mesh.frustumCulled = false;

    for (let i = 0; i < count; i++) this.mesh.setMatrixAt(i, _hidden);
    this.mesh.instanceMatrix.needsUpdate = true;

    this.matrixDirty = false;
    this.alphaDirty = false;

    // Which slots are already collapsed. A ball sitting at the crown of the
    // arch has no shadow but is still written every frame, and without this it
    // would re-upload the same zero matrix sixty times a second.
    this.hidden = new Uint8Array(count).fill(1);

    // Cached per surface: a Frame's basis is fixed for the life of the board,
    // so the quad's orientation only ever has to be derived twice.
    this.orientations = new Map();

    parent.add(this.mesh);
  }

  /**
   * Unlit, additive-free, depth-writing-free: a shadow is a darkening of what
   * is already painted underneath it, not a surface of its own.
   *
   * `depthWrite: false` with `depthTest: true` is the important pair — the quad
   * is still occluded by the cabinet geometry in front of it, but two shadows
   * overlapping just darken each other rather than fighting over the depth
   * buffer.
   */
  build() {
    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
    });
    material.name = "plinko_ball_shadow";

    try {
      // 0 at the quad's centre, 1 at the inscribed circle — a disc, so the
      // square corners of the quad are always fully transparent.
      const distance = uv().sub(0.5).length().mul(2.0);

      const falloff = distance
        .smoothstep(this.uniforms.core, float(1.0))
        .oneMinus()
        .pow(this.uniforms.falloff);

      material.colorNode = vec3(this.uniforms.color);
      material.opacityNode = falloff
        .mul(this.uniforms.strength)
        .mul(attribute("shadowAlpha", "float"));
    } catch (error) {
      // Same guard as the ball material: a TSL graph fails when it is built,
      // and a broken one takes the whole render down. No shadows is a far
      // better failure than no scene.
      console.error("[Plinko] shadow graph failed, disabling:", error);
      material.opacityNode = null;
      material.visible = false;
    }

    this.material = material;
    return material;
  }

  /** The quad's rotation on a given surface: lie in the plane, face outward. */
  orientationFor(frame) {
    let quaternion = this.orientations.get(frame);
    if (!quaternion) {
      // PlaneGeometry lies in XY facing +Z, so mapping local X/Y/Z onto the
      // frame's right/up/normal drops it flat onto the surface.
      quaternion = new THREE.Quaternion().setFromRotationMatrix(
        _basis.makeBasis(frame.right, frame.up, frame.normal),
      );
      this.orientations.set(frame, quaternion);
    }
    return quaternion;
  }

  /**
   * Place one shadow flat on a plane — the peg board or the playfield.
   *
   * There is no height term: a ball in a 2D solver is always in contact with
   * its own surface. The one case that leaves a surface, the arch rail, has its
   * own path in writeRail().
   *
   * @param index   pool index — the same slot the ball occupies
   * @param frame   the surface it sits on
   * @param x,y     the ball's position in that frame's 2D space
   * @param grow    the ball's spawn scale-in, 0..1
   */
  write(index, frame, x, y, grow = 1) {
    const settings = this.settings;

    if (grow <= 0) {
      this.hide(index);
      return;
    }

    const size = this.radius * 2 * settings.spread * grow;

    frame.to3D(
      x + settings.offsetX * this.radius,
      y + settings.offsetY * this.radius,
      settings.lift * this.radius,
      _position,
    );
    _scale.set(size, size, 1);

    this.mesh.setMatrixAt(
      index,
      _matrix.compose(_position, this.orientationFor(frame), _scale),
    );
    this.matrixDirty = true;
    this.hidden[index] = 0;
    this.setAlpha(index, grow);
  }

  /**
   * Place a shadow on the arch's running surface, under a ball riding the rail.
   *
   * Nothing is projected here. A ball on the rail is TOUCHING the arch, so it
   * gets an ordinary contact shadow — just on a surface that is tilted, curved
   * and narrow rather than flat. Dropping the shadow down onto the playfield
   * instead (which is what this used to do) put it under the arch, where the
   * arch itself hides it, which is why a ball going over the ramp looked like
   * it had lost its shadow.
   *
   * @param sample  an ArchRail sample: x, y, h and the unit tangent tx/ty/th
   */
  writeRail(index, frame, sample, grow = 1) {
    if (grow <= 0) {
      this.hide(index);
      return;
    }

    const settings = this.settings;

    // A basis on the running surface: X across the rail, Y along it, Z out of
    // it. The tangent is the only measured direction; the other two follow from
    // it and the playfield normal.
    _along
      .copy(frame.right)
      .multiplyScalar(sample.tx)
      .addScaledVector(frame.up, sample.ty)
      .addScaledVector(frame.normal, sample.th)
      .normalize();
    _across.crossVectors(_along, frame.normal);

    // Only degenerate if the rail runs straight up the playfield normal, which
    // an arch lying on the table cannot do — but a zero-length basis vector
    // would produce a NaN matrix and take out the whole instanced draw.
    if (_across.lengthSq() < 1e-9) {
      this.hide(index);
      return;
    }
    _across.normalize();
    _surface.crossVectors(_across, _along).normalize();

    // Never wider than the rail. A disc sized for the open playfield overhangs
    // the arch's sides and the overhang reads as a dark flap in mid-air, since
    // there is nothing under it to be shadowed.
    const size = Math.min(
      this.radius * 2 * settings.spread,
      this.railWidth > 0 ? this.railWidth * settings.railFit : Infinity,
    );

    frame.to3D(sample.x, sample.y, sample.h, _position);
    // Along the SURFACE normal, not the table's: on the flanks of the arch
    // those diverge, and lifting the wrong way buries one edge of the quad.
    _position.addScaledVector(_surface, settings.railLift * this.radius);

    _scale.set(size * grow, size * grow, 1);
    _quaternion.setFromRotationMatrix(
      _basis.makeBasis(_across, _along, _surface),
    );

    this.mesh.setMatrixAt(index, _matrix.compose(_position, _quaternion, _scale));
    this.matrixDirty = true;
    this.hidden[index] = 0;
    this.setAlpha(index, grow);
  }

  hide(index) {
    if (this.hidden[index]) return;
    this.hidden[index] = 1;

    this.mesh.setMatrixAt(index, _hidden);
    this.matrixDirty = true;
    this.setAlpha(index, 0);
  }

  setAlpha(index, value) {
    if (this.alphaAttribute.getX(index) === value) return;
    this.alphaAttribute.setX(index, value);
    this.alphaDirty = true;
  }

  /** One upload per frame, however many shadows moved. */
  flush() {
    if (this.matrixDirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.matrixDirty = false;
    }
    if (this.alphaDirty) {
      this.alphaAttribute.needsUpdate = true;
      this.alphaDirty = false;
    }
  }

  destroy() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
    this.mesh.removeFromParent();
    this.orientations.clear();
  }
}
