// Pre-bundles the Remotion composition at build time so that users never wait
// for webpack on first run and the published package is fully self-contained.
import { bundle } from "@remotion/bundler";
import { readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const out = await bundle({
  entryPoint: resolve("src/remotion/index.ts"),
  outDir: resolve("bundle"),
  enableCaching: false,
  onProgress: () => {},
});
console.log(`remotion bundle ready: ${out}`);

// The renderer reads bundle.js.map when it reports errors, so that one must stay.
// The per-chunk maps are ~50% of the bundle size and only help debugging the composition.
for (const f of readdirSync(out)) if (f.endsWith(".map") && f !== "bundle.js.map") rmSync(join(out, f));
