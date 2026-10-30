import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../packages/registry/src/index.js";
import { startDemo } from "../apps/demo-site/src/server.js";
import { type Workflow } from "../packages/workflow-schema/src/index.js";
export async function fixtureWorkflow(
  origin = "http://127.0.0.1:4173",
  write = false,
): Promise<Workflow> {
  const body = await readFile(
    `examples/${write ? "demo-crm-create-ticket" : "demo-crm-lookup"}/workflow.json`,
    "utf8",
  );
  return JSON.parse(body.replaceAll("http://127.0.0.1:4173", origin));
}
export async function setup(write = false) {
  const directory = await mkdtemp(join(tmpdir(), "workflow-test-")),
    demo = await startDemo(0),
    registry = new Registry(directory);
  registry.setPolicy({
    version: 1,
    grants: [{ origin: demo.origin, fixture: true }],
  });
  const w = await fixtureWorkflow(demo.origin, write),
    stored = registry.import(w);
  registry.trust(w.slug, stored.hash);
  return {
    directory,
    demo,
    registry,
    stored: registry.get(w.slug),
    async close() {
      registry.close();
      await demo.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
