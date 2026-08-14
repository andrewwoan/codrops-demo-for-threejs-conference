import * as THREE from "three/webgpu";

/**
 * Geometry analysis for the plinko/pinball board. Pure functions — nothing here
 * touches the scene.
 *
 * The whole game is planar: the ball drops down the vertical peg board, hands
 * off at the hinge, then rolls around the raked playfield. Neither half needs
 * 3D physics, so this module's job is to reduce the baked cabinet mesh down to
 * two 2D worlds:
 *
 *   1. findPlanes()  — locate the peg board and the playfield by clustering
 *                      face normals, and build an orthonormal Frame for each.
 *   2. sliceMesh()   — cut the mesh with a plane one ball-radius above each
 *                      surface. Every triangle straddling the cut emits a
 *                      segment, which is exactly the silhouette the ball's
 *                      equator can touch.
 *   3. chainLoops()  — weld those loose segments into closed contours.
 *   4. classify()    — near-circular contours become circle colliders (the 39
 *                      pegs, the Eiffel tower's footprint), everything else
 *                      stays a polyline (walls, arch, divider).
 *
 * Slicing rather than matching connected components on vertex count matters:
 * Draco quantisation and glTF seam-splitting both change vertex counts from
 * what Blender reports, so any classification keyed on those numbers would
 * silently rot the first time the model is re-exported. A cross-section is
 * keyed on shape, which is the thing that actually has to be right.
 */

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ac = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _centroid = new THREE.Vector3();

// The GLB is exported +Y up, so Blender's (x, y, z) arrives as (x, z, -y).
// Everything below works in that converted space — "up" is +Y, and the
// playfield's downhill runs toward -Z (Blender's -Y, toward the flippers).
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * An origin plus an orthonormal basis, converting world-space points into the
 * 2D coordinates the physics solver runs in and back again.
 *
 * `up` is the in-plane direction pointing UPHILL, so 2D gravity is always
 * -Y in frame space regardless of how the cabinet is oriented in the scene.
 */
export class Frame {
  constructor(origin, normal, up) {
    this.origin = origin.clone();
    this.normal = normal.clone().normalize();

    // Re-orthogonalise: the caller's `up` is a projection and may drift.
    this.up = up.clone().projectOnPlane(this.normal).normalize();
    this.right = new THREE.Vector3()
      .crossVectors(this.up, this.normal)
      .normalize();

    // Angle of the SURFACE from horizontal — the rake. 0 for a flat table,
    // 90 for the vertical peg board. Drives gravity: g * sin(tilt).
    this.tiltDeg = THREE.MathUtils.radToDeg(Math.acos(
      THREE.MathUtils.clamp(Math.abs(this.normal.dot(WORLD_UP)), -1, 1),
    ));
  }

  /** World point → [x, y] in the plane. */
  to2D(point, target = []) {
    _p.copy(point).sub(this.origin);
    target[0] = _p.dot(this.right);
    target[1] = _p.dot(this.up);
    return target;
  }

  /** [x, y] → world point, optionally lifted `offset` along the normal. */
  to3D(x, y, offset = 0, target = new THREE.Vector3()) {
    return target
      .copy(this.origin)
      .addScaledVector(this.right, x)
      .addScaledVector(this.up, y)
      .addScaledVector(this.normal, offset);
  }

  /** Signed distance from a world point to the plane. */
  distanceTo(point) {
    return _p.copy(point).sub(this.origin).dot(this.normal);
  }
}

/** Iterate a mesh's triangles in world space. */
function forEachTriangle(mesh, callback) {
  mesh.updateWorldMatrix(true, false);
  const geometry = mesh.geometry;
  const position = geometry.attributes.position;
  const index = geometry.index;
  const matrix = mesh.matrixWorld;
  const count = index ? index.count : position.count;

  for (let i = 0; i < count; i += 3) {
    const i0 = index ? index.getX(i) : i;
    const i1 = index ? index.getX(i + 1) : i + 1;
    const i2 = index ? index.getX(i + 2) : i + 2;

    _a.fromBufferAttribute(position, i0).applyMatrix4(matrix);
    _b.fromBufferAttribute(position, i1).applyMatrix4(matrix);
    _c.fromBufferAttribute(position, i2).applyMatrix4(matrix);

    callback(_a, _b, _c);
  }
}

/**
 * Cluster the mesh's faces by world-space normal, area-weighted, and return the
 * clusters largest-first. Each entry carries the mean normal, the area-weighted
 * centroid, and the surface's tilt from horizontal.
 *
 * Bucketing on the normal rounded to one decimal is deliberately coarse: the
 * cabinet's flat surfaces are dead flat, so anything that lands in the same
 * bucket genuinely is the same surface, while bevels and decorative relief
 * scatter into dozens of tiny buckets that sort straight to the bottom.
 */
export function clusterFaces(mesh) {
  const buckets = new Map();

  forEachTriangle(mesh, (a, b, c) => {
    _ab.subVectors(b, a);
    _ac.subVectors(c, a);
    _n.crossVectors(_ab, _ac);

    const area = _n.length() * 0.5;
    if (area < 1e-12) return;
    _n.divideScalar(area * 2); // normalise

    const key = `${_n.x.toFixed(1)},${_n.y.toFixed(1)},${_n.z.toFixed(1)}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        area: 0,
        normal: new THREE.Vector3(),
        centroid: new THREE.Vector3(),
        faces: 0,
      };
      buckets.set(key, bucket);
    }

    bucket.area += area;
    bucket.normal.addScaledVector(_n, area);
    bucket.centroid
      .addScaledVector(a, area / 3)
      .addScaledVector(b, area / 3)
      .addScaledVector(c, area / 3);
    bucket.faces++;
  });

  const clusters = [];
  for (const bucket of buckets.values()) {
    const normal = bucket.normal.clone().divideScalar(bucket.area).normalize();
    const centroid = bucket.centroid.clone().divideScalar(bucket.area);
    const tiltDeg = THREE.MathUtils.radToDeg(
      Math.acos(THREE.MathUtils.clamp(normal.y, -1, 1)),
    );
    clusters.push({ area: bucket.area, faces: bucket.faces, normal, centroid, tiltDeg });
  }

  clusters.sort((x, y) => y.area - x.area);
  return clusters;
}

/**
 * Pick the playfield and the peg board out of the face clusters.
 *
 * The playfield is the largest surface whose normal points broadly upward — its
 * rake is then read straight off the geometry rather than authored, so nudging
 * the cabinet in Blender retunes the game's gravity automatically.
 *
 * The peg board is the largest near-vertical surface high enough above the
 * playfield to be the lid rather than a cabinet side wall.
 */
export function findPlanes(mesh) {
  const clusters = clusterFaces(mesh);

  const playfieldCluster = clusters.find((c) => c.tiltDeg < 45);
  if (!playfieldCluster) throw new Error("[Plinko] no upward-facing surface found");

  // Downhill is world -Z projected into the plane; uphill is the frame's +Y, so
  // the ball always falls toward -Y in 2D.
  const uphill = WORLD_UP.clone().projectOnPlane(playfieldCluster.normal);
  // A dead-flat table has no uphill; any in-plane axis will do as the frame's
  // +Y. -Z keeps 2D "up" pointing away from the player, same as the raked case.
  if (uphill.lengthSq() < 1e-9) uphill.set(0, 0, -1);
  const playfield = new Frame(
    playfieldCluster.centroid,
    playfieldCluster.normal,
    uphill,
  );

  // The board is vertical, so "uphill" in its plane is just world up.
  const boardCluster = clusters.find(
    (c) =>
      c.tiltDeg > 80 &&
      c.tiltDeg < 100 &&
      // High above the playfield, which rules out the cabinet's side walls —
      // they are just as vertical but sit down at floor level.
      c.centroid.y > playfieldCluster.centroid.y + 0.5,
  );
  if (!boardCluster) throw new Error("[Plinko] no vertical peg board found");

  const board = new Frame(boardCluster.centroid, boardCluster.normal, WORLD_UP);

  return { playfield, board, clusters };
}

/**
 * The 2D extent of the surface a Frame was built from — the peg board's panel,
 * or the playfield's floor.
 *
 * This is what tells the two worlds apart. A slice plane is infinite, so
 * cutting parallel to the peg board also cuts straight through the cabinet base
 * sitting in front of it, and cutting above the playfield clips the raised lid.
 * Both produce large, real contours that belong to the *other* half of the
 * game. Clipping each plane's contours to its own surface is what keeps the
 * peg board's world from inheriting the table's walls and vice versa.
 */
export function surfaceBounds2D(
  mesh,
  frame,
  { normalTolerance = 0.9, planeTolerance = 0.05 } = {},
) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  forEachTriangle(mesh, (a, b, c) => {
    _ab.subVectors(b, a);
    _ac.subVectors(c, a);
    _n.crossVectors(_ab, _ac);
    const area = _n.length() * 0.5;
    if (area < 1e-12) return;
    _n.divideScalar(area * 2);

    if (_n.dot(frame.normal) < normalTolerance) return;

    _centroid.copy(a).add(b).add(c).divideScalar(3);
    if (Math.abs(frame.distanceTo(_centroid)) > planeTolerance) return;

    for (const point of [a, b, c]) {
      const [x, y] = frame.to2D(point);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  });

  return { minX, minY, maxX, maxY };
}

/**
 * The `from`-frame Y coordinate at which its plane crosses the `onto` plane —
 * for this board, the hinge where the peg board meets the playfield.
 *
 * This is the handoff line, and it is NOT the bottom of the peg board panel:
 * the panel carries on past the hinge, behind the playfield. Using the panel's
 * extent instead hands the ball over below the table surface, buried inside the
 * back wall, where it sits motionless because it is inside solid geometry.
 *
 * Returns null if the planes are parallel, in which case there is no hinge and
 * the caller should fall back to the surface bounds.
 */
export function planeIntersectionY(from, onto) {
  const denominator = from.up.dot(onto.normal);
  if (Math.abs(denominator) < 1e-6) return null;

  _p.copy(from.origin).sub(onto.origin);
  return -_p.dot(onto.normal) / denominator;
}

/**
 * Drop contours that duplicate one already kept.
 *
 * Slicing at several heights catches low geometry the ball can still touch —
 * a ramp toe, a chamfered rail — but anything with vertical sides (the outer
 * walls, every peg) produces a near-identical contour at every height. Those
 * duplicates are harmless to the solver but they multiply the collider count
 * for nothing.
 *
 * Matching is on shape, not identity: same centre and same size means same
 * obstacle, whichever cut it came from.
 *
 * The default tolerance is a third of a ball radius. Tighter than that stops
 * merging anything useful, because a bevelled wall genuinely sits a few
 * millimetres further out at the lower cut — measured on this cabinet, 0.01
 * kept 73 contours where 0.03 keeps 59 for the same coverage.
 */
export function dedupeContours({ polylines = [], circles = [] }, tolerance = 0.03) {
  const quantise = (value) => Math.round(value / tolerance);

  const seenCircles = new Set();
  const keptCircles = [];
  for (const circle of circles) {
    const key = `${quantise(circle.x)},${quantise(circle.y)},${quantise(circle.radius)}`;
    if (seenCircles.has(key)) continue;
    seenCircles.add(key);
    keptCircles.push(circle);
  }

  const seenLoops = new Set();
  const keptLoops = [];
  for (const loop of polylines) {
    let cx = 0;
    let cy = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of loop) {
      cx += x;
      cy += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    cx /= loop.length;
    cy /= loop.length;

    const key = `${quantise(cx)},${quantise(cy)},${quantise(maxX - minX)},${quantise(maxY - minY)}`;
    if (seenLoops.has(key)) continue;
    seenLoops.add(key);
    keptLoops.push(loop);
  }

  return { polylines: keptLoops, circles: keptCircles };
}

/** Keep only the contours whose centre falls inside `bounds`, plus a margin. */
export function clipToBounds({ polylines, circles }, bounds, margin = 0) {
  const inside = (x, y) =>
    x >= bounds.minX - margin &&
    x <= bounds.maxX + margin &&
    y >= bounds.minY - margin &&
    y <= bounds.maxY + margin;

  const centreOf = (loop) => {
    let x = 0;
    let y = 0;
    for (const p of loop) {
      x += p[0];
      y += p[1];
    }
    return [x / loop.length, y / loop.length];
  };

  return {
    polylines: polylines.filter((loop) => inside(...centreOf(loop))),
    circles: circles.filter((c) => inside(c.x, c.y)),
  };
}

/**
 * Cut `mesh` with the plane sitting `offset` along `frame.normal`, and return
 * the cross-section as loose 2D segments in frame coordinates.
 *
 * Offset by one ball radius: the ball's widest point is what actually contacts
 * a wall, and slicing at the surface itself would trace the bevel where the
 * wall meets the floor instead of the flat above it.
 */
export function sliceMesh(mesh, frame, offset) {
  const segments = [];
  const distances = [0, 0, 0];
  const points = [_a, _b, _c];
  const crossing = [];

  forEachTriangle(mesh, (a, b, c) => {
    distances[0] = frame.distanceTo(a) - offset;
    distances[1] = frame.distanceTo(b) - offset;
    distances[2] = frame.distanceTo(c) - offset;

    // Entirely one side of the cut — no contribution.
    if (distances[0] > 0 && distances[1] > 0 && distances[2] > 0) return;
    if (distances[0] < 0 && distances[1] < 0 && distances[2] < 0) return;

    crossing.length = 0;
    for (let e = 0; e < 3; e++) {
      const d0 = distances[e];
      const d1 = distances[(e + 1) % 3];
      // Strictly opposite signs: a vertex sitting exactly on the plane would
      // otherwise emit the same point from both of its edges.
      if ((d0 > 0 && d1 > 0) || (d0 <= 0 && d1 <= 0)) continue;

      const t = d0 / (d0 - d1);
      _p.copy(points[e]).lerp(points[(e + 1) % 3], t);
      crossing.push(frame.to2D(_p));
    }

    if (crossing.length === 2) segments.push([crossing[0], crossing[1]]);
  });

  return segments;
}

/**
 * Weld the loose segments from sliceMesh() into contours.
 *
 * Endpoints are matched through a quantised spatial hash — floating-point
 * intersection points that ought to coincide land within a texel of each other
 * but are almost never bit-identical, so exact matching would leave every
 * contour shattered into individual segments.
 */
export function chainLoops(segments, tolerance = 1e-4) {
  const key = (p) =>
    `${Math.round(p[0] / tolerance)},${Math.round(p[1] / tolerance)}`;

  // endpoint key → segment indices touching it
  const at = new Map();
  segments.forEach((segment, i) => {
    for (const end of segment) {
      const k = key(end);
      if (!at.has(k)) at.set(k, []);
      at.get(k).push(i);
    }
  });

  const used = new Uint8Array(segments.length);
  const loops = [];

  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    used[start] = 1;

    const points = [segments[start][0], segments[start][1]];

    // Walk forward from the tail, then backward from the head. Open contours
    // (a wall that runs off the edge of the mesh) need both directions; closed
    // ones terminate on the first pass.
    for (let direction = 0; direction < 2; direction++) {
      for (;;) {
        const tail = points[points.length - 1];
        const candidates = at.get(key(tail));
        if (!candidates) break;

        const next = candidates.find((i) => !used[i]);
        if (next === undefined) break;

        used[next] = 1;
        const [p0, p1] = segments[next];
        points.push(key(p0) === key(tail) ? p1 : p0);
      }
      points.reverse();
    }

    // Two points is a lone segment the walk never extended — slicing noise off
    // a single stray triangle, not a wall.
    if (points.length > 2) loops.push(points);
  }

  return loops;
}

/** Perpendicular distance from `p` to the segment ab. */
function pointSegmentDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < 1e-18) return Math.hypot(p[0] - a[0], p[1] - a[1]);

  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq;
  t = THREE.MathUtils.clamp(t, 0, 1);
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Douglas-Peucker. The raw contours carry a vertex per triangle crossed, which
 * for a beveled cabinet wall is hundreds of near-collinear points; the solver
 * pays for every one of them on every step and none of them change the shape.
 */
export function simplifyLoop(points, tolerance) {
  if (points.length < 3) return points;

  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    if (last <= first + 1) continue;

    let worst = -1;
    let worstIndex = -1;
    for (let i = first + 1; i < last; i++) {
      const d = pointSegmentDistance(points[i], points[first], points[last]);
      if (d > worst) {
        worst = d;
        worstIndex = i;
      }
    }

    if (worst > tolerance) {
      keep[worstIndex] = 1;
      stack.push([first, worstIndex], [worstIndex, last]);
    }
  }

  return points.filter((_, i) => keep[i]);
}

/**
 * Split contours into circles and polylines.
 *
 * A peg sliced at its equator comes out as a 64-gon that is, to within a
 * fraction of a percent, a circle — and a circle collider is both cheaper and
 * better-behaved than a 64-segment polyline, which can catch a fast ball on a
 * vertex. Same for the Eiffel tower's footprint.
 */
export function classify(loops, { maxCircleRadius = 0.06, roundness = 0.15 } = {}) {
  const circles = [];
  const polylines = [];

  for (const loop of loops) {
    const closed =
      Math.hypot(
        loop[0][0] - loop[loop.length - 1][0],
        loop[0][1] - loop[loop.length - 1][1],
      ) < 1e-3;

    if (!closed) {
      polylines.push(loop);
      continue;
    }

    let cx = 0;
    let cy = 0;
    for (const p of loop) {
      cx += p[0];
      cy += p[1];
    }
    cx /= loop.length;
    cy /= loop.length;

    let min = Infinity;
    let max = 0;
    for (const p of loop) {
      const r = Math.hypot(p[0] - cx, p[1] - cy);
      if (r < min) min = r;
      if (r > max) max = r;
    }

    const isRound = max > 1e-6 && (max - min) / max < roundness;
    if (isRound && max <= maxCircleRadius) {
      circles.push({ x: cx, y: cy, radius: (min + max) * 0.5 });
    } else {
      polylines.push(loop);
    }
  }

  return { circles, polylines };
}
