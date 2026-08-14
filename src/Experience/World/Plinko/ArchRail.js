import * as THREE from "three/webgpu";

/**
 * The arch, as a rail the ball can ride over.
 *
 * The arch is narrow, so a ball on it is not doing 2D motion — it is a bead on
 * a wire. While a ball is on the arch it leaves the 2D solver entirely and
 * becomes a single scalar `s` along the arc, with one acceleration term. Two
 * consequences fall out for free:
 *
 *   - Height comes from the curve, so the ball visibly rises over the arch
 *     without any extra machinery.
 *   - Enter too slowly and it rolls back down. That is just the dynamics; the
 *     classic pinball ramp reject needs no special case.
 *
 * The arch stays SOLID along its length (it is sliced into colliders like
 * everything else), so a ball arriving side-on still bounces. Only the two ends
 * capture, which is what makes it read as a ramp rather than a hole in the wall.
 *
 * ---------------------------------------------------------------------------
 * EXTRACTING THE RIDGE — and two ways of getting it wrong
 *
 * The ridge is built from the arch's TOP-FACING FACES ONLY, area-weighted, in
 * angular bins about the arch's FITTED ARC CENTRE. Both halves matter, and both
 * were learned the hard way:
 *
 *   Selecting by HEIGHT instead of by FACING put the ridge on whichever rim of
 *   the arch happened to be raised. The top is subtly banked, and banked
 *   differently at different points along the sweep, so the ridge snapped to one
 *   edge and jumped to the other partway round — on screen, the ball rode the
 *   rim and then flicked across to the far rim halfway over. Top-facing faces
 *   are the running surface by definition and contain no rims at all.
 *
 *   Binning about the footprint CENTROID rather than the fitted arc centre made
 *   bins run ALONG the arch instead of across it, because the centroid of a
 *   horseshoe is not its centre of curvature. Measured on this arch that is a
 *   worst-case radial spread of 1.03 per bin versus 0.49, and 17 unusable bins
 *   versus 7.
 *
 * Together those took side-flips from 10-13 down to 1 and put the mean ridge
 * position at 0.49 across the band — dead centre.
 * ---------------------------------------------------------------------------
 */

const ANGULAR_BINS = 64;

// A face counts as running surface if its normal is within ~60 degrees of the
// playfield normal. Loose enough to keep the steep stretches near the mouths,
// tight enough to reject the arch's sides.
const TOP_FACING = 0.5;

// Median window applied BEFORE smoothing. Averaging cannot remove an outlier,
// only spread it — a single bad bin becomes a wide gentle bend instead of a
// spike, and the ball still rides the bend. A median rejects it outright.
const MEDIAN_WINDOW = 5;

// Neighbour-averaging passes over the finished ridge.
const SMOOTH_PASSES = 3;

// Ridge points are respaced to this fraction of a ball radius before use.
// Angular binning samples the curve unevenly — bins near the mouths cover far
// more arc than bins over the crown — and uneven spacing means the tangent
// jumps at the wide segments, which the ball rides as a visible kink.
const RESAMPLE_SPACING = 0.5;

// Bins dropped from each end before anything else. The top-face ribbon frays
// where it meets the end caps, and the final bin there mixes cap geometry into
// the average — measured, one landed hard against the inner rim. They are
// replaced by the extrapolation below, so nothing is lost.
const TRIM_END_BINS = 1;

// The mouths must meet the floor. Measured, they sat at 0.76 and 0.91 ball
// radii ABOVE the playfield, and since a ball renders at ridge height plus its
// radius, every exit dropped it most of a radius the instant it rejoined the
// table — and every entry popped it up the same amount. At the mouth, which is
// exactly where it looked like the ball fell through the ramp.
//
// Each end is extrapolated along its own last segment until it reaches floor
// level. The cap is on how far that is allowed to run, so a ridge that happens
// to end level cannot throw a point off into space.
const MAX_END_EXTENSION = 3;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ac = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _centroid = new THREE.Vector3();

export class ArchRail {
  constructor({ mesh, frame, ballRadius }) {
    this.frame = frame;
    this.ballRadius = ballRadius;

    this.points = this.extract(mesh);
    this.length = this.points.length
      ? this.points[this.points.length - 1].s
      : 0;
  }

  get valid() {
    return this.points.length >= 4 && this.length > this.ballRadius * 4;
  }

  extract(mesh) {
    const faces = this.topFaces(mesh);
    if (faces.length < 8) return [];

    const centre = this.fitCentre(faces);
    const ordered = this.binAndAverage(faces, centre);
    if (ordered.length < 4) return [];

    this.trimEnds(ordered);
    if (ordered.length < 4) return [];

    this.medianFilter(ordered);
    this.smooth(ordered);
    this.extendToFloor(ordered);
    this.measure(ordered);

    const even = this.resample(ordered);
    this.measure(even);
    return even;
  }

  /**
   * Every upward-facing triangle of the arch, as a point in the table frame
   * plus its area. Area is carried through so a bin dominated by one large face
   * is not outvoted by a cluster of slivers.
   */
  topFaces(mesh) {
    mesh.updateWorldMatrix(true, false);

    const geometry = mesh.geometry;
    const position = geometry.attributes.position;
    const index = geometry.index;
    const matrix = mesh.matrixWorld;
    const count = index ? index.count : position.count;

    const faces = [];
    for (let i = 0; i < count; i += 3) {
      const i0 = index ? index.getX(i) : i;
      const i1 = index ? index.getX(i + 1) : i + 1;
      const i2 = index ? index.getX(i + 2) : i + 2;

      _a.fromBufferAttribute(position, i0).applyMatrix4(matrix);
      _b.fromBufferAttribute(position, i1).applyMatrix4(matrix);
      _c.fromBufferAttribute(position, i2).applyMatrix4(matrix);

      _ab.subVectors(_b, _a);
      _ac.subVectors(_c, _a);
      _normal.crossVectors(_ab, _ac);

      const area = _normal.length() * 0.5;
      if (area < 1e-12) continue;
      _normal.divideScalar(area * 2);

      if (_normal.dot(this.frame.normal) < TOP_FACING) continue;

      _centroid.copy(_a).add(_b).add(_c).divideScalar(3);
      const [x, y] = this.frame.to2D(_centroid);
      faces.push({ x, y, h: this.frame.distanceTo(_centroid), area });
    }

    return faces;
  }

  /**
   * Least-squares circle through the running surface (Kasa), giving the arch's
   * centre of curvature. Falls back to the plain centroid if the fit is
   * degenerate — a straight ramp has no arc centre.
   */
  fitCentre(faces) {
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    let sz = 0;
    let sxz = 0;
    let syz = 0;
    const n = faces.length;

    for (const f of faces) {
      const z = f.x * f.x + f.y * f.y;
      sx += f.x;
      sy += f.y;
      sxx += f.x * f.x;
      syy += f.y * f.y;
      sxy += f.x * f.y;
      sz += z;
      sxz += f.x * z;
      syz += f.y * z;
    }

    // Normal equations for 2ax + 2by + c = x^2 + y^2, solved by Gauss-Jordan.
    const m = [
      [4 * sxx, 4 * sxy, 2 * sx, 2 * sxz],
      [4 * sxy, 4 * syy, 2 * sy, 2 * syz],
      [2 * sx, 2 * sy, n, sz],
    ];

    for (let col = 0; col < 3; col++) {
      let pivot = col;
      for (let row = col + 1; row < 3; row++) {
        if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
      }
      if (Math.abs(m[pivot][col]) < 1e-12) return this.centroidOf(faces);

      const swap = m[col];
      m[col] = m[pivot];
      m[pivot] = swap;

      for (let row = 0; row < 3; row++) {
        if (row === col) continue;
        const factor = m[row][col] / m[col][col];
        for (let k = col; k < 4; k++) m[row][k] -= factor * m[col][k];
      }
    }

    const x = m[0][3] / m[0][0];
    const y = m[1][3] / m[1][1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return this.centroidOf(faces);
    }

    return { x, y };
  }

  centroidOf(faces) {
    let x = 0;
    let y = 0;
    for (const f of faces) {
      x += f.x;
      y += f.y;
    }
    return { x: x / faces.length, y: y / faces.length };
  }

  /**
   * Bin by angle about `centre` and take each bin's area-weighted mean. The
   * mean of the running surface across the band IS the centreline, which is why
   * nothing here looks at height to decide where the ridge goes.
   *
   * Ordering starts just after the largest circular gap — that gap is the
   * arch's opening, so the walk runs mouth to mouth rather than wrapping
   * through thin air.
   */
  binAndAverage(faces, centre) {
    const bins = new Map();
    for (const f of faces) {
      const angle = Math.atan2(f.y - centre.y, f.x - centre.x);
      const key =
        Math.floor(((angle + Math.PI) / (Math.PI * 2)) * ANGULAR_BINS) %
        ANGULAR_BINS;
      if (!bins.has(key)) bins.set(key, []);
      bins.get(key).push(f);
    }

    const occupied = [...bins.keys()].sort((a, b) => a - b);
    if (occupied.length < 4) return [];

    let gapAt = 0;
    let gapSize = -1;
    for (let i = 0; i < occupied.length; i++) {
      const size =
        (occupied[(i + 1) % occupied.length] - occupied[i] + ANGULAR_BINS) %
        ANGULAR_BINS;
      if (size > gapSize) {
        gapSize = size;
        gapAt = (i + 1) % occupied.length;
      }
    }

    const ordered = [];
    for (let i = 0; i < occupied.length; i++) {
      const bucket = bins.get(occupied[(gapAt + i) % occupied.length]);

      let weight = 0;
      let x = 0;
      let y = 0;
      let h = 0;
      for (const f of bucket) {
        weight += f.area;
        x += f.x * f.area;
        y += f.y * f.area;
        h += f.h * f.area;
      }
      if (weight <= 0) continue;

      ordered.push({ x: x / weight, y: y / weight, h: h / weight, s: 0 });
    }

    return ordered;
  }

  /** Drop the frayed bins where the ribbon meets the end caps. */
  trimEnds(points) {
    if (points.length <= TRIM_END_BINS * 2 + 4) return;
    points.splice(0, TRIM_END_BINS);
    points.splice(points.length - TRIM_END_BINS, TRIM_END_BINS);
  }

  /**
   * Run each end on along its own last segment until it reaches the playfield,
   * so a ball rolls onto and off the rail without a step in height.
   */
  extendToFloor(points) {
    const project = (endIndex, innerIndex) => {
      const end = points[endIndex];
      const inner = points[innerIndex];

      // Height change moving OUTWARD, toward the mouth. If it is not
      // descending there is nothing sensible to extend toward.
      const drop = end.h - inner.h;
      if (drop >= -1e-6) return null;

      const steps = end.h / -drop;
      if (!(steps > 0) || steps > MAX_END_EXTENSION) return null;

      return {
        x: end.x + (end.x - inner.x) * steps,
        y: end.y + (end.y - inner.y) * steps,
        h: 0,
        s: 0,
      };
    };

    const head = project(0, 1);
    const tail = project(points.length - 1, points.length - 2);

    if (head) points.unshift(head);
    if (tail) points.push(tail);
  }

  /**
   * Reject isolated bad bins. The mouths are left alone: they are where the
   * ball gets on and off, and a median would drag them toward the middle of the
   * curve.
   */
  medianFilter(points) {
    if (points.length < MEDIAN_WINDOW) return;

    const half = Math.floor(MEDIAN_WINDOW / 2);
    const copy = points.map((p) => ({ ...p }));
    const median = (values) =>
      values.sort((a, b) => a - b)[Math.floor(values.length / 2)];

    for (let i = 1; i < points.length - 1; i++) {
      const lo = Math.max(0, i - half);
      const hi = Math.min(points.length - 1, i + half);

      const xs = [];
      const ys = [];
      const hs = [];
      for (let k = lo; k <= hi; k++) {
        xs.push(copy[k].x);
        ys.push(copy[k].y);
        hs.push(copy[k].h);
      }

      points[i].x = median(xs);
      points[i].y = median(ys);
      points[i].h = median(hs);
    }
  }

  smooth(points) {
    for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
      // Endpoints are left alone — dragging them inward would open a gap
      // between the rail and the floor.
      const copy = points.map((p) => ({ ...p }));
      for (let i = 1; i < points.length - 1; i++) {
        points[i].x = (copy[i - 1].x + copy[i].x * 2 + copy[i + 1].x) / 4;
        points[i].y = (copy[i - 1].y + copy[i].y * 2 + copy[i + 1].y) / 4;
        points[i].h = (copy[i - 1].h + copy[i].h * 2 + copy[i + 1].h) / 4;
      }
    }
  }

  /** Re-space the ridge evenly along its own arc length. */
  resample(points) {
    const total = points[points.length - 1].s;
    const spacing = this.ballRadius * RESAMPLE_SPACING;
    const count = Math.max(8, Math.ceil(total / spacing));

    const out = [];
    let i = 1;
    for (let k = 0; k <= count; k++) {
      const target = (k / count) * total;
      while (i < points.length - 1 && points[i].s < target) i++;

      const a = points[i - 1];
      const b = points[i];
      const span = b.s - a.s;
      const t = span > 1e-9 ? (target - a.s) / span : 0;

      out.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        h: a.h + (b.h - a.h) * t,
        s: 0,
      });
    }
    return out;
  }

  /** Cumulative arc length, measured in 3D so climbs count toward distance. */
  measure(points) {
    let total = 0;
    points[0].s = 0;
    for (let i = 1; i < points.length; i++) {
      const dx = points[i].x - points[i - 1].x;
      const dy = points[i].y - points[i - 1].y;
      const dh = points[i].h - points[i - 1].h;
      total += Math.sqrt(dx * dx + dy * dy + dh * dh);
      points[i].s = total;
    }
  }

  /**
   * Position and unit tangent at arc length `s`, clamped to the rail. The
   * tangent carries all three components — the height term is what makes
   * gravity slow the ball on the way up.
   */
  sample(s, target = {}) {
    const points = this.points;
    const clamped = THREE.MathUtils.clamp(s, 0, this.length);

    let i = 1;
    while (i < points.length - 1 && points[i].s < clamped) i++;

    const a = points[i - 1];
    const b = points[i];
    const span = b.s - a.s;
    const t = span > 1e-9 ? (clamped - a.s) / span : 0;

    target.x = a.x + (b.x - a.x) * t;
    target.y = a.y + (b.y - a.y) * t;
    target.h = a.h + (b.h - a.h) * t;

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dh = b.h - a.h;
    const inverse = 1 / (Math.hypot(dx, dy, dh) || 1);
    target.tx = dx * inverse;
    target.ty = dy * inverse;
    target.th = dh * inverse;

    return target;
  }

  /** The two mouths, with the tangent pointing INTO the rail. */
  get ends() {
    if (!this.valid) return [];

    const start = this.sample(0, {});
    const finish = this.sample(this.length, {});

    return [
      { s: 0, direction: 1, x: start.x, y: start.y, tx: start.tx, ty: start.ty },
      {
        s: this.length,
        direction: -1,
        x: finish.x,
        y: finish.y,
        // Reversed: entering from this end means travelling toward decreasing s.
        tx: -finish.tx,
        ty: -finish.ty,
      },
    ];
  }

  /** Ridge as world-space points, for the debug overlay. */
  toWorldPoints(lift = 0) {
    return this.points.map((p) =>
      this.frame.to3D(p.x, p.y, p.h + lift, new THREE.Vector3()),
    );
  }
}
