import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  cp,
  readdir,
  readFile,
  writeFile,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
const exec = promisify(execFile);
await mkdir("artifacts", { recursive: true });
const cache = await mkdtemp(join(tmpdir(), "workflow-release-cache-"));
try {
  await exec("npm", [
    "pack",
    "--pack-destination",
    "artifacts",
    "--cache",
    cache,
  ]);
} finally {
  await rm(cache, { recursive: true, force: true });
}
await exec("python3", ["scripts/create-zip.py"]);
await cp("dist/workflow.schema.json", "artifacts/workflow.schema.json");
await cp("docs/benchmark-results.json", "artifacts/benchmark-results.json");
await cp(
  "docs/implementation-progress.md",
  "artifacts/implementation-progress.md",
);
const lines = [];
for (const file of (await readdir("artifacts"))
  .filter((f) => f !== "SHA256SUMS")
  .sort()) {
  const content = await readFile(`artifacts/${file}`);
  lines.push(`${createHash("sha256").update(content).digest("hex")}  ${file}`);
}
await writeFile("artifacts/SHA256SUMS", lines.join("\n") + "\n");
console.log(
  "Built local package, extension ZIP, schema and SHA256SUMS in artifacts/. No public release was created.",
);
