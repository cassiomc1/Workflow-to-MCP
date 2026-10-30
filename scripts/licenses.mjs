import { createRequire } from "node:module";
import { readFile, mkdir, writeFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
const allowed = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "Python-2.0",
]);
const collected = new Map();
async function inspect(name, from, optional = false) {
  const require = createRequire(join(from, "package.json"));
  let location;
  try {
    location = dirname(require.resolve(name));
  } catch (e) {
    if (optional) return;
    throw e;
  }
  let pkg;
  while (true) {
    try {
      const candidate = JSON.parse(
        await readFile(join(location, "package.json"), "utf8"),
      );
      if (candidate.name === name) {
        pkg = candidate;
        break;
      }
    } catch {
      /* ascend to package root */
    }
    const parent = dirname(location);
    if (parent === location) throw new Error(`Cannot locate ${name}`);
    location = parent;
  }
  const id = `${pkg.name}@${pkg.version}`;
  if (collected.has(id)) return;
  if (!allowed.has(pkg.license))
    throw new Error(`Review required for ${id}: ${pkg.license}`);
  const licenseFiles = (await readdir(location)).filter((f) =>
    /^(license|notice|copying)(\.|$)/i.test(f),
  );
  const notices = [];
  for (const file of licenseFiles)
    notices.push({ file, text: await readFile(join(location, file), "utf8") });
  if (!notices.length) throw new Error(`Missing license text: ${id}`);
  collected.set(id, {
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    notices,
  });
  for (const dep of Object.keys(pkg.dependencies ?? {}))
    await inspect(dep, location);
  for (const dep of Object.keys(pkg.optionalDependencies ?? {}))
    await inspect(dep, location, true);
  for (const dep of Object.keys(pkg.peerDependencies ?? {}))
    await inspect(dep, location, pkg.peerDependenciesMeta?.[dep]?.optional);
}
const root = resolve("."),
  pkg = JSON.parse(await readFile("package.json", "utf8"));
for (const name of Object.keys(pkg.dependencies)) await inspect(name, root);
await mkdir("docs/legal", { recursive: true });
await writeFile(
  "docs/legal/dependency-licenses.json",
  JSON.stringify(
    [...collected.values()].sort((a, b) => a.name.localeCompare(b.name)),
    null,
    2,
  ) + "\n",
);
console.log(
  `PASS: ${collected.size} production packages have compatible licenses and bundled notices.`,
);
