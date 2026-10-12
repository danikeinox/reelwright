import { rmSync } from "node:fs";
for (const d of ["dist", "dist-test", "bundle"]) rmSync(d, { recursive: true, force: true });
