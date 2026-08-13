import * as THREE from "three/webgpu";

import { EventEmitter } from "events";
import { Loaders } from "./Loaders";
import assets from "./assets";
import staticAssets from "./staticAssets";

export class Resources extends EventEmitter {
  constructor() {
    super();

    this.loaders = new Loaders().loaders;
    // Merge codegen'd model assets with hand-managed static assets (skybox, etc.)
    this.assets = [...assets, ...staticAssets];

    this.items = {};
    this.queue = this.assets.length;
    this.loaded = 0;

    this.startLoading();
  }

  startLoading() {
    // Nothing registered yet (a fresh project, before any model is exported).
    // "ready" is what World builds off, so it still has to fire — deferred by a
    // microtask because Resources is constructed before World attaches its
    // listener, and a synchronous emit here would be heard by nobody.
    if (!this.queue) {
      queueMicrotask(() => this.emit("ready"));
      return;
    }

    for (const asset of this.assets) {
      // A failed asset must still SETTLE. "ready" fires on loaded === queue, and
      // World builds the entire experience off that event — so an asset that
      // errors without counting leaves the promise-count one short forever, and
      // the whole site is a black screen with no clue as to why. Guard for a
      // missing `items[name]` in consumers — degrading to "that model is
      // absent" is strictly better than never starting.
      const onError = (err) => {
        console.error(
          `[Resources] Failed to load "${asset.name}" (${asset.path}) — ` +
            "continuing without it.",
          err,
        );
        this.assetSettled();
      };

      if (asset.type === "texture") {
        this.loaders.textureLoader.load(
          asset.path,
          (file) => this.singleAssetLoaded(asset.name, file),
          undefined,
          onError,
        );
      } else if (asset.type === "glbModel") {
        this.loaders.gltfLoader.load(
          asset.path,
          (file) => this.singleAssetLoaded(asset.name, file),
          undefined,
          onError,
        );
      } else if (asset.type === "skybox") {
        this.loaders.cubeTextureLoader.load(
          asset.path,
          (file) => this.singleAssetLoaded(asset.name, file),
          undefined,
          onError,
        );
      } else if (asset.type === "ktx2Texture") {
        // 2D .ktx2 → CompressedTexture. KTX2Loader resolves via callback only,
        // so preloading through the queue lets consumers read items[name]
        // synchronously once "ready" fires.
        this.loaders.ktx2Loader.load(
          asset.path,
          (file) => this.singleAssetLoaded(asset.name, file),
          undefined,
          onError,
        );
      }
    }
  }

  singleAssetLoaded(asset, file) {
    this.items[asset] = file;
    this.assetSettled();
  }

  /** One asset finished, successfully or not. Fires "ready" on the last one. */
  assetSettled() {
    this.loaded++;
    this.emit("progress", this.loaded / this.queue);

    if (this.loaded === this.queue) {
      this.emit("ready");
    }
  }
}
