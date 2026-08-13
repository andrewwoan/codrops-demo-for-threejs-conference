// Vite plugin for the Asset Reloader pipeline.
//
// On dev-server start and whenever the Blender addon writes into the configured
// models/textures folders, it regenerates the JS (asset list, World classes,
// registry) and triggers a full page reload.

import path from "node:path";
import { generate, loadConfig } from "./asset-codegen.mjs";

export default function assetReloader() {
  return {
    name: "asset-reloader",

    buildStart() {
      generate(process.cwd()); // keep generated files fresh on every start
    },

    configureServer(server) {
      const root = server.config.root || process.cwd();
      const cfg = loadConfig(root);
      const dirs = [cfg.modelsDir, cfg.texturesDir].map((d) => path.resolve(root, d));
      server.watcher.add(dirs);

      const onChange = (file) => {
        if (!dirs.some((d) => file.startsWith(d))) return;
        const r = generate(root);
        server.config.logger.info(
          `\x1b[35m[asset-reloader]\x1b[0m ${path.basename(file)} → ${r.count} model(s)` +
            (r.created.length ? `, scaffolded ${r.created.join(", ")}` : ""),
        );
        server.ws.send({ type: "full-reload" });
      };

      server.watcher.on("add", onChange);
      server.watcher.on("change", onChange);
    },
  };
}
