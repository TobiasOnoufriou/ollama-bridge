// Run before packaging: records this checkout's path so the packaged app on this machine uses it (and its
// logs/config) instead of the copy bundled into the package. Other machines fall back to the bundled copy.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
fs.writeFileSync(path.join(here, "bridge-home.json"), JSON.stringify({ home: path.resolve(here, "..") }) + "\n");
