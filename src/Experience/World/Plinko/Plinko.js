import * as THREE from "three/webgpu";
import { Experience } from "../../Experience";
import {
  findPlanes,
  sliceMesh,
  chainLoops,
  simplifyLoop,
  classify,
  surfaceBounds2D,
  clipToBounds,
  dedupeContours,
  planeIntersectionY,
} from "./Extract.js";
import { PhysicsPlane, ZONE, SCALE } from "./Physics.js";
import { Balls } from "./Balls.js";
import { ArchRail } from "./ArchRail.js";
import { Audio } from "./Audio.js";
import { Flippers } from "./Flippers.js";
import { Plunger } from "./Plunger.js";
import { Controls } from "./Controls.js";

/**
 * The drop-disk / pinball board.
 *
 * Two 2D physics worlds — the vertical peg board and the raked playfield —
 * joined by a handoff at the hinge. Colliders are derived from the baked
 * cabinet mesh at load rather than authored: the surfaces are found by
 * clustering face normals, and the walls, pegs and obstacles come from slicing
 * the mesh one ball-radius above each surface. Nothing in Blender has to be
 * maintained alongside the model. See Extract.js for how that works.
 *
 * Load with `#debug` to draw the extracted contours in place over the render.
 */

// Heights to cut the mesh at, as multiples of the ball radius.
//
// The ball is a SPHERE sitting on the surface, so it occupies 0..2r vertically
// and anything in that band can touch it. One cut at the equator only catches
// obstacles that happen to straddle exactly 1r.
//
// Measured on this cabinet, the arch runs from -2.38r to +3.87r above the
// playfield: it starts below the floor line and climbs clear over the ball.
// Cutting at 0.3r and 1.0r caught its toe and nothing else, so through the
// whole stretch where it sits between 1r and 2r there was no collider at all
// and the ball drove straight into it.
//
// Four cuts spanning the ball's body fix that. Above 2r nothing is cut, which
// is correct — the arch genuinely clears the ball up there. Vertical-sided
// geometry (walls, all 39 pegs) repeats at every height and is merged back
// down by dedupeContours.
const SLICE_HEIGHTS = [0.25, 0.8, 1.35, 1.9];

const SIMPLIFY_TOLERANCE = 0.002;
const MIN_CONTOUR_EXTENT = 0.01;

// Contours are clipped to their own surface, with a margin so a wall standing
// just outside the floor's footprint still counts.
const CLIP_MARGIN = 0.25;

const DEBUG_COLORS = {
  playfieldPolyline: 0x00ffc8,
  playfieldCircle: 0xff4fd8,
  boardPolyline: 0xffd400,
  boardCircle: 0x4fa8ff,
};

// The sound switch's two faces. Drawn in `currentColor` so they take the same
// engraved lettering colour as the buttons beside them, including the dimmed
// state — one less place for the palette to be restated.
//
// The cone is filled and the waves are stroked, which is what keeps the glyph
// readable at 18px: an all-stroke speaker turns to mush at this size.
const SOUND_ICON = (paths) => `
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"
       focusable="false" fill="none" stroke="currentColor" stroke-width="1.7"
       stroke-linecap="round">
    <path d="M4 9.3h3.4L11.6 5.8v12.4L7.4 14.7H4z" fill="currentColor"
          stroke-linejoin="round" />
    ${paths}
  </svg>`;

const SOUND_ON_ICON = SOUND_ICON(`
    <path d="M15.1 9.4a3.7 3.7 0 0 1 0 5.2" />
    <path d="M17.8 6.9a7.4 7.4 0 0 1 0 10.2" />`);

const SOUND_OFF_ICON = SOUND_ICON(`
    <path d="M15.4 9.6l5 4.8" />
    <path d="M20.4 9.6l-5 4.8" />`);

export class Plinko {
  constructor() {
    this.experience = Experience.getInstance();
    this.scene = this.experience.scene;

    this.ready = false;
    this.materials = [];

    this.debugGroup = new THREE.Group();
    this.debugGroup.name = "PlinkoDebug";
    this.debugGroup.visible = this.experience.debug;

    this.init();
  }

  async init() {
    const model = this.experience.resources.items.baked.scene;

    // GLTFLoader strips dots from node names, so `fourth_Cube.002_Baked`
    // arrives as `fourth_Cube002_Baked` — match on the prefix instead.
    this.cabinet = this.findMesh(model, "fourth_Cube");
    this.ballMesh = this.findMesh(model, "sixth_Ball");
    this.hitterMeshes = this.findMeshes(model, /^fourth_(left|right)_hitter/);
    this.plungerMesh = this.findMesh(model, "fourth_reset_hitter");
    this.archMesh = this.findMesh(model, "fourth_arch");

    if (!this.cabinet) {
      console.warn("[Plinko] no `fourth_Cube*` mesh in Baked.glb — skipping.");
      return;
    }

    // Everything the ball can bump into. The arch is its own mesh now, so it
    // has to be sliced alongside the cabinet or it stops existing to physics
    // entirely and the ball sails through it.
    this.obstacles = [this.cabinet, this.archMesh].filter(Boolean);
    if (!this.archMesh) {
      console.warn(
        "[Plinko] no `fourth_arch` mesh — arch will not be solid. Re-export?",
      );
    }

    this.radius = this.measureBallRadius();

    const { playfield, board } = findPlanes(this.cabinet);
    this.tableSurface = this.extract(
      playfield,
      DEBUG_COLORS.playfieldPolyline,
      DEBUG_COLORS.playfieldCircle,
    );
    this.boardSurface = this.extract(
      board,
      DEBUG_COLORS.boardPolyline,
      DEBUG_COLORS.boardCircle,
    );

    this.scene.add(this.debugGroup);
    this.report();

    // rapier2d-compat ships the solver as inlined wasm, so this is a real
    // async boundary. Everything above is synchronous and safe to inspect even
    // if the solver never arrives.
    const RAPIER = await import("@dimforge/rapier2d-compat");
    await RAPIER.init();

    this.buildWorlds(RAPIER);
    this.setupGUI();
    this.ready = true;
  }

  findMesh(root, prefix) {
    let found = null;
    root.traverse((child) => {
      if (!found && child.isMesh && child.name.startsWith(prefix)) found = child;
    });
    return found;
  }

  findMeshes(root, pattern) {
    const found = [];
    root.traverse((child) => {
      if (child.isMesh && pattern.test(child.name)) found.push(child);
    });
    return found;
  }

  /** World-space ball radius, read off the mesh so a resize in Blender carries. */
  measureBallRadius() {
    if (!this.ballMesh) {
      console.warn("[Plinko] no `sixth_Ball*` mesh — assuming radius 0.0885.");
      return 0.0885;
    }
    const size = new THREE.Box3()
      .setFromObject(this.ballMesh)
      .getSize(new THREE.Vector3());
    return Math.max(size.x, size.y, size.z) * 0.5;
  }

  /**
   * Slice the cabinet in one plane and reduce the result to colliders. The cut
   * sits one ball-radius off the surface — where the ball's equator rides — so
   * the contours trace the flats the ball touches, not the bevels below them.
   */
  extract(frame, polylineColor, circleColor) {
    const loops = [];
    let rawSegments = 0;

    for (const mesh of this.obstacles) {
      for (const height of SLICE_HEIGHTS) {
        const segments = sliceMesh(mesh, frame, this.radius * height);
        rawSegments += segments.length;
        loops.push(...chainLoops(segments));
      }
    }

    const raw = classify(loops);

    const bounds = surfaceBounds2D(this.cabinet, frame);
    const contours = clipToBounds(
      dedupeContours({
        polylines: raw.polylines
          .filter((loop) => extentOf(loop) >= MIN_CONTOUR_EXTENT)
          .map((loop) => simplifyLoop(loop, SIMPLIFY_TOLERANCE)),
        circles: raw.circles.filter((c) => c.radius >= MIN_CONTOUR_EXTENT * 0.5),
      }),
      bounds,
      CLIP_MARGIN,
    );

    const surface = {
      frame,
      bounds,
      ...contours,
      rawSegments,
      // Gravity for this plane: full g scaled by the surface's rake. The
      // vertical board comes out at sin(90°) = 1, the playfield at its
      // measured rake — no authored constant either way.
      gravityScale: Math.sin(THREE.MathUtils.degToRad(frame.tiltDeg)),
    };

    this.drawDebug(surface, polylineColor, circleColor);
    return surface;
  }

  buildWorlds(RAPIER) {
    this.boardPlane = new PhysicsPlane(RAPIER, {
      frame: this.boardSurface.frame,
      gravityScale: this.boardSurface.gravityScale,
      name: "board",
    });
    this.boardPlane.addStatics(this.boardSurface, ZONE.TABLE);

    this.tablePlane = new PhysicsPlane(RAPIER, {
      frame: this.tableSurface.frame,
      gravityScale: this.tableSurface.gravityScale,
      name: "table",
    });
    this.tablePlane.addStatics(this.tableSurface, ZONE.TABLE);

    // Where the peg board plane crosses the playfield plane. Falls back to the
    // panel's bottom edge only if the two are somehow parallel.
    const hingeY =
      planeIntersectionY(this.boardSurface.frame, this.tableSurface.frame) ??
      this.boardSurface.bounds.minY;

    // The arch as a rideable rail. Solid colliders for it stay in place — only
    // its two mouths capture, so a side-on hit still bounces.
    this.archRail = this.archMesh
      ? new ArchRail({
          mesh: this.archMesh,
          frame: this.tableSurface.frame,
          ballRadius: this.radius,
        })
      : null;

    if (this.archRail && !this.archRail.valid) {
      console.warn(
        "[Plinko] arch ridge came out too short to ride — rail disabled.",
      );
    }
    this.drawRailDebug();

    // Ahead of Balls: contacts that happen on the arch rail are resolved in
    // 1D and never reach the solver, so Balls raises their sound itself.
    this.audio = new Audio({ muted: this.experience.audioMuted });

    this.balls = new Balls({
      scene: this.scene,
      sourceMesh: this.ballMesh,
      radius: this.radius,
      boardPlane: this.boardPlane,
      tablePlane: this.tablePlane,
      resources: this.experience.resources,
      rail: this.archRail?.valid ? this.archRail : null,
      audio: this.audio,
      // Shadow gradient, keyed to the table's own frame. The bake darkens the
      // lower part of the playfield; the ramp runs from the drain up to 45% of
      // the way along, which is roughly where the painted shadow fades out.
      shading: {
        shadeOrigin: this.tableSurface.frame.origin,
        shadeAxis: this.tableSurface.frame.up,
        shadeEnd: this.tableSurface.bounds.minY,
        shadeStart:
          this.tableSurface.bounds.minY +
          (this.tableSurface.bounds.maxY - this.tableSurface.bounds.minY) * 0.45,
      },
      bounds: {
        // Hand off at the hinge — where the two planes actually meet — lifted
        // by a radius so the ball leaves the board before any part of it can
        // cross under the playfield. The panel's own bottom edge is 0.14 lower
        // and would bury the ball in the back wall.
        board: { exitY: hingeY + this.radius, box: this.boardSurface.bounds },
        table: {
          drainY: this.tableSurface.bounds.minY - this.radius * 4,
          maxY: this.tableSurface.bounds.maxY,
          box: this.tableSurface.bounds,
        },
      },
    });

    // Before the controls: the flippers and plunger hold a reference to it
    // so they can sound their own mechanism, independent of ball contact.

    // Always constructed: the thumb bar inside it is touch-only, but the
    // utility buttons (reset) show everywhere.
    this.controls = new Controls({
      touch: this.experience.device.isMobileDevice,
    });

    if (this.hitterMeshes.length) {
      this.flippers = new Flippers({
        plane: this.tablePlane,
        meshes: this.hitterMeshes,
        gui: this.experience.gui,
        controls: this.controls,
        audio: this.audio,
      });
    } else {
      console.warn("[Plinko] no hitter meshes found — flippers disabled.");
    }

    if (this.plungerMesh) {
      this.plunger = new Plunger({
        plane: this.tablePlane,
        mesh: this.plungerMesh,
        controls: this.controls,
        gui: this.experience.gui,
        audio: this.audio,
      });
    } else {
      console.warn("[Plinko] no `fourth_reset_hitter` mesh — plunger disabled.");
    }

    // Registered before the reset button so it sits to its left, leaving the
    // button anchored in the corner where it has always been.
    this.ballCounter = this.controls.addReadout({ label: "Balls" });
    // Nothing can ever be this, so the first sync always writes.
    this.shownBallCount = -1;

    this.controls.addAction({
      label: "Reset Board",
      onClick: () => this.balls.reset(),
    });

    // Last in the row, so it sits hard in the corner. It starts wherever the
    // preloader left the flag — someone who entered without audio should not
    // have to press this to agree with the choice they just made.
    this.soundToggle = this.controls.addToggle({
      value: this.experience.audioMuted,
      icon: (muted) => (muted ? SOUND_OFF_ICON : SOUND_ON_ICON),
      description: (muted) => (muted ? "Turn sound on" : "Turn sound off"),
      onChange: (muted) => this.experience.setAudioMuted(muted),
    });

    this.bindDropZone();
  }

  /**
   * Click anywhere on the peg board to drop a ball at that column.
   *
   * Intersecting the pointer ray with the board's plane rather than raycasting
   * the mesh: the drop zone is a region of empty space above the top peg row,
   * so there is nothing there to hit.
   */
  bindDropZone() {
    const frame = this.boardSurface.frame;
    const bounds = this.boardSurface.bounds;

    this.dropPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      frame.normal,
      frame.origin,
    );
    this.dropRaycaster = new THREE.Raycaster();

    this.onDrop = (event) => {
      // Let the debug gizmo and any overlay own the pointer when they want it.
      if (!this.experience.raycaster?.isActive?.()) return;
      if (event.target !== this.experience.canvasElement) return;

      this.dropRaycaster.setFromCamera(
        this.experience.mouse.instance,
        this.experience.camera.instance,
      );

      const hit = this.dropRaycaster.ray.intersectPlane(
        this.dropPlane,
        new THREE.Vector3(),
      );
      if (!hit) return;

      const [x, y] = frame.to2D(hit);
      if (y < bounds.minY || y > bounds.maxY) return;
      if (x < bounds.minX || x > bounds.maxX) return;

      this.audio?.drop();
      this.balls.spawn(
        THREE.MathUtils.clamp(
          x,
          bounds.minX + this.radius,
          bounds.maxX - this.radius,
        ),
        bounds.maxY - this.radius * 2,
        this.experience.time.elapsed,
      );
    };

    this.experience.canvasElement.addEventListener("click", this.onDrop);
  }

  /** The extracted ridge, drawn one ball radius up — where the ball will ride. */
  drawRailDebug() {
    if (!this.archRail?.valid) return;

    const ridge = this.archRail.toWorldPoints(this.radius);
    const lines = [];
    for (let i = 0; i < ridge.length - 1; i++) {
      lines.push(ridge[i], ridge[i + 1]);
    }
    this.addLines(lines, 0xff5b3a);
  }

  drawDebug(surface, polylineColor, circleColor) {
    const { frame } = surface;

    const lines = [];
    for (const loop of surface.polylines) {
      for (let i = 0; i < loop.length - 1; i++) {
        lines.push(
          frame.to3D(loop[i][0], loop[i][1], this.radius),
          frame.to3D(loop[i + 1][0], loop[i + 1][1], this.radius),
        );
      }
    }
    this.addLines(lines, polylineColor);

    const circleLines = [];
    const SEGMENTS = 20;
    for (const circle of surface.circles) {
      for (let i = 0; i < SEGMENTS; i++) {
        const t0 = (i / SEGMENTS) * Math.PI * 2;
        const t1 = ((i + 1) / SEGMENTS) * Math.PI * 2;
        circleLines.push(
          frame.to3D(
            circle.x + Math.cos(t0) * circle.radius,
            circle.y + Math.sin(t0) * circle.radius,
            this.radius,
          ),
          frame.to3D(
            circle.x + Math.cos(t1) * circle.radius,
            circle.y + Math.sin(t1) * circle.radius,
            this.radius,
          ),
        );
      }
    }
    this.addLines(circleLines, circleColor);
  }

  addLines(points, color) {
    if (!points.length) return;

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    // depthTest off so the overlay reads through the cabinet — half of these
    // contours sit inside solid geometry.
    const material = new THREE.LineBasicNodeMaterial({
      color,
      depthTest: false,
      transparent: true,
      opacity: 0.9,
    });

    const lines = new THREE.LineSegments(geometry, material);
    lines.renderOrder = 999;
    this.debugGroup.add(lines);
    this.materials.push(material);
  }

  report() {
    const summary = (surface) => ({
      "tilt°": +surface.frame.tiltDeg.toFixed(2),
      gravityScale: +surface.gravityScale.toFixed(4),
      circles: surface.circles.length,
      polylines: surface.polylines.length,
      polylineVerts: surface.polylines.reduce((n, l) => n + l.length, 0),
      rawSegments: surface.rawSegments,
    });

    console.log(
      `[Plinko] ball radius ${this.radius.toFixed(4)} — colliders cut one radius above each surface`,
    );
    console.table({
      playfield: summary(this.tableSurface),
      pegBoard: summary(this.boardSurface),
    });
  }

  setupGUI() {
    const folder = this.experience.gui.addFolder("Plinko");
    folder.add(this.debugGroup, "visible").name("show colliders");
    folder
      .add({ drop: () => this.dropRandom() }, "drop")
      .name("drop a ball");
    folder
      .add({ reset: () => this.balls?.reset() }, "reset")
      .name("reset board");

    this.setupBallGUI();
    this.setupShadowGUI();
    this.setupRailGUI();
    this.setupAudioGUI();
  }

  /** The faked contact shadows under the balls. See BallShadows.js. */
  setupShadowGUI() {
    const shadows = this.balls?.shadows;
    if (!shadows) return;

    const folder = this.experience.gui.addFolder("Plinko Ball Shadows");
    const { uniforms, settings } = shadows;

    folder.add(shadows.mesh, "visible").name("enabled");
    folder
      .add({ strength: uniforms.strength.value }, "strength", 0, 1, 0.01)
      .name("darkness")
      .onChange((v) => {
        uniforms.strength.value = v;
      });
    folder
      .addColor({ color: `#${uniforms.color.value.getHexString()}` }, "color")
      .name("colour")
      .onChange((v) => uniforms.color.value.set(v));
    folder
      .add({ core: uniforms.core.value }, "core", 0, 0.9, 0.01)
      .name("hard core")
      .onChange((v) => {
        uniforms.core.value = v;
      });
    folder
      .add({ falloff: uniforms.falloff.value }, "falloff", 0.2, 4, 0.05)
      .name("edge softness")
      .onChange((v) => {
        uniforms.falloff.value = v;
      });

    // These land in the instance matrix on the next write rather than in a
    // uniform, so they take effect as soon as a ball moves — no rebuild.
    folder.add(settings, "spread", 0.6, 4, 0.05).name("size (radii)");
    folder.add(settings, "offsetX", -2, 2, 0.05).name("offset right");
    folder.add(settings, "offsetY", -2, 2, 0.05).name("offset uphill");
    folder.add(settings, "lift", 0, 0.3, 0.005).name("surface clearance");

    // On the arch. `rail fit` only bites while it is the smaller of the two
    // sizes — see BallShadows.writeRail().
    folder.add(settings, "railLift", 0, 0.6, 0.01).name("arch clearance");
    folder.add(settings, "railFit", 0.2, 1.5, 0.05).name("arch size (of width)");
    folder
      .add(
        {
          info: () =>
            console.log(
              `[Plinko] arch running width ${(shadows.railWidth || 0).toFixed(4)} ` +
                `(${((shadows.railWidth || 0) / shadows.radius).toFixed(2)} ball radii); ` +
                `shadow on rail ${Math.min(
                  shadows.radius * 2 * settings.spread,
                  shadows.railWidth > 0
                    ? shadows.railWidth * settings.railFit
                    : Infinity,
                ).toFixed(4)}`,
            ),
        },
        "info",
      )
      .name("Log Arch Fit");
  }

  setupAudioGUI() {
    if (!this.audio) return;
    const folder = this.experience.gui.addFolder("Plinko Audio");
    folder
      .add({ v: this.audio.settings.volume }, "v", 0, 1, 0.01)
      .name("master volume")
      .onChange((v) => this.audio.setVolume(v));
    folder
      .add(this.audio.settings, "rollVolume", 0, 1, 0.01)
      .name("rolling bed");
    // Through Experience, not straight at Audio: the corner nameplate is
    // showing this same state and has to follow it.
    folder
      .add({ m: this.audio.settings.muted }, "m")
      .name("mute")
      .onChange((m) => this.experience.setAudioMuted(m));
  }

  /** Arch rail tuning. See ArchRail.js for what the rail actually is. */
  setupRailGUI() {
    if (!this.archRail?.valid || !this.balls?.railSettings) return;

    const folder = this.experience.gui.addFolder("Plinko Arch Rail");
    const settings = this.balls.railSettings;

    folder
      .add(settings, "minEntrySpeed", 0, 6, 0.1)
      .name("min entry speed");
    folder
      .add(settings, "maxEntrySpeed", 1, 12, 0.25)
      .name("max entry speed");
    folder
      .add(settings, "minExitSpeed", 0, 4, 0.1)
      .name("min exit speed");
    folder.add(settings, "gravity", 0.1, 1.5, 0.05).name("rail gravity");
    folder.add(settings, "damping", 0, 3, 0.05).name("rolling drag");
    folder
      .add(settings, "captureRadius", 0.5, 4, 0.1)
      .name("mouth reach (radii)");

    folder
      .add(
        {
          info: () =>
            console.log(
              `[Plinko] arch rail: ${this.archRail.points.length} points, ` +
                `length ${this.archRail.length.toFixed(3)} ` +
                `(${(this.archRail.length / this.radius).toFixed(1)} ball radii)`,
            ),
        },
        "info",
      )
      .name("Log Rail Info");
  }

  /** Live controls for the one lit material in the scene. See BallMaterial.js. */
  setupBallGUI() {
    const material = this.balls?.instanced?.material;
    if (!material) return;

    const folder = this.experience.gui.addFolder("Plinko Balls");
    // 0 is bone-dry unfinished wood — no specular lobe at all. Anything much
    // above 0.15 starts reading as varnish. See BallMaterial.js.
    if ("specularIntensity" in material) {
      folder.add(material, "specularIntensity", 0, 1, 0.01).name("shine");
    }
    // Inert once a roughness map is loaded — "roughness floor" below is the
    // live one then.
    folder.add(material, "roughness", 0, 1, 0.01).name("roughness");
    folder.add(material, "metalness", 0, 1, 0.01).name("metalness");

    if ("envMapIntensity" in material) {
      folder
        .add(material, "envMapIntensity", 0, 3, 0.05)
        .name("env intensity");
    }

    if (material.normalMap) {
      // Unlike colour and roughness, the normal map goes through the mesh's
      // own atlas UVs rather than triplanar — see BallMaterial.js. Set this to
      // 0 if the grain bumps look smeared or seamed.
      folder
        .add({ strength: material.normalScale.x }, "strength", 0, 2, 0.05)
        .name("normal strength")
        .onChange((v) => material.normalScale.set(v, v));
    }

    const uniforms = this.balls.materialUniforms;
    if (!uniforms) return;

    // How glossy the roughness map is allowed to make the ball at its darkest.
    if (material.roughnessNode) {
      folder
        .add({ floor: uniforms.roughnessFloor.value }, "floor", 0, 1, 0.01)
        .name("roughness floor")
        .onChange((v) => {
          uniforms.roughnessFloor.value = v;
        });
    }

    // Matching the baked shadow at the bottom of the playfield.
    const shade = folder.addFolder("Shadow gradient");
    shade
      .add({ floor: uniforms.shadeFloor.value }, "floor", 0, 1, 0.01)
      .name("darkest")
      .onChange((v) => {
        uniforms.shadeFloor.value = v;
      });
    shade
      .add({ start: uniforms.shadeStart.value }, "start", -3, 3, 0.02)
      .name("fade top")
      .onChange((v) => {
        uniforms.shadeStart.value = v;
      });
    shade
      .add({ end: uniforms.shadeEnd.value }, "end", -3, 3, 0.02)
      .name("fade bottom")
      .onChange((v) => {
        uniforms.shadeEnd.value = v;
      });

    if (this.balls.textured) {
      // Triplanar tiling density — only meaningful once real maps are loaded.
      folder
        .add({ scale: uniforms.textureScale.value }, "scale", 0.25, 12, 0.05)
        .name("texture tiling")
        .onChange((v) => {
          uniforms.textureScale.value = v;
        });
      // Multiplied into the albedo. White leaves the texture as-shipped.
      folder
        .addColor({ tint: `#${uniforms.tint.value.getHexString()}` }, "tint")
        .name("tint")
        .onChange((v) => uniforms.tint.value.set(v));
      return;
    }

    // Procedural grain, used while no colour map is registered.
    folder
      .add({ rings: uniforms.ringFrequency.value }, "rings", 0.5, 20, 0.1)
      .name("grain rings")
      .onChange((v) => {
        uniforms.ringFrequency.value = v;
      });
    folder
      .add({ scale: uniforms.grainScale.value }, "scale", 0.5, 20, 0.1)
      .name("grain scale")
      .onChange((v) => {
        uniforms.grainScale.value = v;
      });
    folder
      .add({ width: uniforms.grainWidth.value }, "width", 0.05, 1, 0.01)
      .name("grain line width")
      .onChange((v) => {
        uniforms.grainWidth.value = v;
      });
    folder
      .addColor({ light: `#${uniforms.lightColor.value.getHexString()}` }, "light")
      .name("grain light")
      .onChange((v) => uniforms.lightColor.value.set(v));
    folder
      .addColor({ dark: `#${uniforms.darkColor.value.getHexString()}` }, "dark")
      .name("grain dark")
      .onChange((v) => uniforms.darkColor.value.set(v));
  }

  dropRandom() {
    const bounds = this.boardSurface.bounds;
    this.audio?.drop();
    this.balls?.spawn(
      THREE.MathUtils.lerp(
        bounds.minX + this.radius,
        bounds.maxX - this.radius,
        Math.random(),
      ),
      bounds.maxY - this.radius * 2,
      this.experience.time.elapsed,
    );
  }

  /**
   * Push the live ball count to the readout, but only when it has actually
   * moved. The count changes a handful of times a game — writing textContent
   * every frame would invalidate layout sixty times a second to say the same
   * thing.
   *
   * Zero-padded to the cap's width so the number can't change the plaque's
   * width as it ticks between 9 and 10.
   */
  syncBallCounter() {
    const live = this.balls.liveCount;
    if (live === this.shownBallCount) return;
    this.shownBallCount = live;

    const cap = this.balls.capacity;
    const padded = String(live).padStart(String(cap).length, "0");

    this.ballCounter.textContent = `${padded} / ${cap}`;
    // At the cap the next drop recycles the oldest ball rather than adding
    // one. Worth saying, since the ball that vanishes is otherwise a mystery.
    this.ballCounter.dataset.full = String(live >= cap);
  }

  /**
   * Turn this frame's contacts into impacts. Volume comes from the ball's own
   * speed rather than a contact force, which is cheaper and, for a board where
   * everything is wood on wood, indistinguishable.
   */
  playContactSounds(plane) {
    plane.drainCollisions((handleA, handleB, kindA, kindB) => {
      const ballHandle = kindA === "ball" ? handleA : handleB;
      const otherKind = kindA === "ball" ? kindB : kindA;
      if (kindA !== "ball" && kindB !== "ball") return;

      const ball = this.balls.ballByCollider(ballHandle);
      if (!ball?.handle) return;

      const velocity = ball.handle.body.linvel();
      const speed = Math.hypot(velocity.x, velocity.y) / SCALE;
      this.audio.impact(otherKind ?? "wall", speed);
    });
  }

  resize() {}

  update() {
    if (!this.ready) return;

    const delta = this.experience.time.delta;

    this.flippers?.update(delta);
    this.plunger?.update(delta);
    this.boardPlane.step(delta);
    this.tablePlane.step(delta);
    this.balls.update(this.experience.time.elapsed, delta);

    // Sound last: the drain has to happen after both worlds have stepped, and
    // reading a ball's speed is only meaningful once its pose is final.
    if (this.audio) {
      this.playContactSounds(this.boardPlane);
      this.playContactSounds(this.tablePlane);
      this.audio.updateRolling(this.balls.rollingActivity, delta);
      this.audio.endFrame();
    }
    this.syncBallCounter();
  }

  destroy() {
    this.experience.canvasElement.removeEventListener("click", this.onDrop);
    this.flippers?.destroy();
    this.plunger?.destroy();
    this.audio?.destroy();
    this.controls?.destroy();
    this.balls?.destroy();
    this.boardPlane?.destroy();
    this.tablePlane?.destroy();

    for (const material of this.materials) material.dispose();
    this.materials.length = 0;
    this.debugGroup.traverse((child) => child.geometry?.dispose());
    this.scene.remove(this.debugGroup);
  }
}

/** Longest side of a contour's bounding box. */
function extentOf(loop) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of loop) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Math.max(maxX - minX, maxY - minY);
}
