import overrides from "./transform-overrides.json";

// Transforms saved out of the #debug gizmo, re-applied on load. Written by
// scripts/vite-plugin-transform-overrides.mjs; the JSON is a normal import, so
// whatever you saved in dev is baked into the production bundle too.
//
// The same file is the handoff to Blender: the asset-reloader addon reads it on
// shift+I, writes the transforms onto the matching Blender objects, re-exports
// the GLBs, then empties it.

const ENDPOINT = "/__transforms";

// Stamps each loaded glTF root with the asset name it came from, so paths can
// be namespaced per-GLB. Blender always exports its root as "Scene" and hands
// out repeating default names (Cube.001, Empty.003) — two models in one scene
// would otherwise produce identical paths and steal each other's transforms.
//
// Keyed off the generated asset list rather than the class name, which a
// production build is free to mangle.
export function tagTransformNamespaces(items) {
  for (const [name, item] of Object.entries(items)) {
    if (item?.scene) item.scene.userData.transformNamespace = name;
  }
}

function nodeKey(object) {
  return (
    object.userData?.transformNamespace ||
    object.name ||
    `${object.type}[${object.parent?.children.indexOf(object) ?? 0}]`
  );
}

// Objects are keyed by their name path from the scene root
// ("<asset>/Parent/Mesh_1") rather than uuid — uuids are regenerated on every
// load, names survive as long as the GLB keeps them.
export function transformPath(object, root) {
  const parts = [];

  for (let current = object; current && current !== root; ) {
    parts.unshift(nodeKey(current));
    current = current.parent;
  }

  return parts.join("/");
}

// Called once the world is built, so model classes have already done their own
// positioning and we land on top of it.
export function applyTransformOverrides(root) {
  const saved = new Map(Object.entries(overrides));
  if (!saved.size) return 0;

  const matched = new Set();

  root.traverse((object) => {
    const path = transformPath(object, root);
    const data = saved.get(path);
    if (!data) return;

    object.position.fromArray(data.position);
    object.rotation.fromArray(data.rotation);
    object.scale.fromArray(data.scale);
    matched.add(path);
  });

  // Renaming an object in Blender, or a re-export that renumbers .001 suffixes,
  // orphans its override. Applying nothing at all and staying quiet is the
  // worst way to find that out.
  const orphaned = [...saved.keys()].filter((path) => !matched.has(path));
  if (orphaned.length) {
    console.warn(
      `[TransformOverrides] ${orphaned.length} saved transform(s) match nothing in the scene:`,
      orphaned,
    );
  }

  return matched.size;
}

export function serializeTransform(object, root) {
  const { position: p, rotation: r, scale: s } = object;

  return [
    transformPath(object, root),
    {
      name: object.name || object.type,
      position: p.toArray(),
      rotation: [r.x, r.y, r.z],
      scale: s.toArray(),
    },
  ];
}

export async function saveTransforms(objects, root) {
  // The endpoint is a dev-server middleware; there's nothing to write to in a
  // built bundle, so fail loudly rather than firing a request into the void.
  if (!import.meta.env.DEV) {
    throw new Error("transform saving is dev-only");
  }

  const payload = Object.fromEntries(
    [...objects].map((object) => serializeTransform(object, root)),
  );

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) throw new Error(`save failed (${response.status})`);

  return Object.keys(payload).length;
}

export async function clearTransforms() {
  if (!import.meta.env.DEV) throw new Error("transform saving is dev-only");

  const response = await fetch(ENDPOINT, { method: "DELETE" });
  if (!response.ok) throw new Error(`clear failed (${response.status})`);
}
