import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";

import * as THREE from "three/webgpu";
import { Experience } from "../Experience";

export class Loaders {
  constructor() {
    this.init();
  }

  init() {
    this.loaders = {};
    this.loaders.gltfLoader = new GLTFLoader();
    this.loaders.dracoLoader = new DRACOLoader();
    this.loaders.dracoLoader.setDecoderPath("/draco/");
    this.loaders.gltfLoader.setDRACOLoader(this.loaders.dracoLoader);

    // KTX2 / Basis Universal (ETC1S) transcoding, for GLBs that embed
    // KHR_texture_basisu textures — the loader needs a transcoder plus
    // GPU-support detection. The WebGPU renderer is already initialised by the
    // time Resources (which constructs us) runs, so detectSupport() can be
    // called synchronously here.
    this.loaders.ktx2Loader = new KTX2Loader();
    this.loaders.ktx2Loader.setTranscoderPath("/basis/");
    this.loaders.ktx2Loader.detectSupport(
      Experience.getInstance().renderer.renderer,
    );
    this.loaders.gltfLoader.setKTX2Loader(this.loaders.ktx2Loader);

    this.loaders.textureLoader = new THREE.TextureLoader();
    this.loaders.imageBitmapLoader = new THREE.ImageBitmapLoader();
    this.loaders.imageBitmapLoader.setOptions({ imageOrientation: "flipY" });
    this.loaders.cubeTextureLoader = new THREE.CubeTextureLoader();
  }
}
