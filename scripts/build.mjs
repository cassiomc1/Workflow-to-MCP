import { build } from "esbuild";
import { mkdir, cp, writeFile } from "node:fs/promises";
await mkdir("dist/extension", { recursive: true });
await import("./licenses.mjs");
await build({
  entryPoints: {
    cli: "packages/cli/src/index.ts",
    demo: "apps/demo-site/src/index.ts",
    "demo-server": "apps/demo-site/src/server.ts",
    benchmark: "packages/testing/src/benchmark.ts",
    schema: "packages/workflow-schema/src/index.ts",
    "remote-smoke": "packages/testing/src/remote-smoke.ts",
  },
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "external",
  sourcemap: true,
  banner: { js: "" },
});
await build({
  entryPoints: {
    background: "apps/extension/src/background.ts",
    content: "apps/extension/src/content.ts",
    popup: "apps/extension/src/popup.ts",
    review: "apps/extension/src/review.ts",
  },
  outdir: "dist/extension",
  bundle: true,
  platform: "browser",
  target: "chrome130",
  format: "iife",
});
await cp(
  "docs/legal/dependency-licenses.json",
  "dist/extension/THIRD_PARTY_LICENSES.json",
);
await cp(
  "docs/legal/headless-recorder-MIT.txt",
  "dist/extension/HEADLESS_RECORDER_MIT.txt",
);
for (const file of ["manifest.json", "popup.html", "review.html", "style.css"])
  await cp(`apps/extension/${file}`, `dist/extension/${file}`);
const { workflowJsonSchema } = await import("../dist/schema.js");
await writeFile(
  "dist/workflow.schema.json",
  JSON.stringify(workflowJsonSchema, null, 2),
);
