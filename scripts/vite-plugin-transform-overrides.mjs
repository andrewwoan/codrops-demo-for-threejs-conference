// Vite plugin backing the #debug transform gizmo's save.
//
// The browser can't write to disk, so the gizmo POSTs the objects it moved to
// a dev-only endpoint and this writes them into transform-overrides.json.
// That file is imported by the app, so the edits survive a reload and ship
// with the production build. It's also the file the Blender asset-reloader
// addon reads on shift+I ("Pull Web Edits") to push the same transforms back
// onto the Blender objects.
//
// Dev only — the endpoint doesn't exist in `vite build` output.

import fs from "node:fs";
import path from "node:path";

const ENDPOINT = "/__transforms";
const OVERRIDES_FILE = "src/Experience/Utils/transform-overrides.json";

const normalize = (value) => value.replace(/\\/g, "/");

export default function transformOverrides() {
  let file;

  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return {};
    }
  };

  const write = (data) =>
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);

  return {
    name: "transform-overrides",
    apply: "serve",

    configureServer(server) {
      const root = server.config.root || process.cwd();
      file = path.resolve(root, OVERRIDES_FILE);

      if (!fs.existsSync(file)) write({});

      server.middlewares.use(ENDPOINT, (req, res, next) => {
        const respond = (count) => {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, count }));
        };

        if (req.method === "DELETE") {
          write({});
          server.config.logger.info(
            `\x1b[35m[transform-overrides]\x1b[0m cleared`,
          );
          respond(0);
          return;
        }

        if (req.method !== "POST") return next();

        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            // Merge rather than replace: the gizmo only sends what you moved
            // this session, and earlier edits shouldn't vanish.
            const merged = { ...read(), ...JSON.parse(body) };
            write(merged);

            const count = Object.keys(merged).length;
            server.config.logger.info(
              `\x1b[35m[transform-overrides]\x1b[0m saved ${count} object(s)`,
            );
            respond(count);
          } catch (error) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: error.message }));
          }
        });
      });
    },

    // Saving would otherwise full-reload the page (the JSON is in the module
    // graph) — throwing away the very scene state you just saved. The addon
    // clearing the file on a pull does trigger a reload, which is what you
    // want: the re-exported GLB is the truth by then.
    handleHotUpdate({ file: changed }) {
      if (file && normalize(changed) === normalize(file)) return [];
    },
  };
}
