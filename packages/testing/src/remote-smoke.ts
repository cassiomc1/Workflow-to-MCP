import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../../registry/src/index.js";
import { runWorkflow } from "../../runner/src/index.js";
const directory = await mkdtemp(join(tmpdir(), "workflow-public-https-")),
  registry = new Registry(directory);
try {
  registry.setPolicy({
    version: 1,
    grants: [{ origin: "https://example.com", fixture: false }],
  });
  const stored = registry.import({
    schemaVersion: "1.0.0",
    id: "wf_public_https_smoke",
    slug: "public_https_smoke",
    version: "1.0.0",
    title: "Public HTTPS smoke",
    description: "Verify one explicitly permitted public HTTPS navigation.",
    provenance: {
      source: "fixture",
      recorderVersion: "0.1.0",
      createdAt: "2026-10-29T23:00:00Z",
    },
    entrypoint: "https://example.com/",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    steps: [
      {
        id: "s1",
        kind: "waitForURL",
        urlPattern: "https://example.com/",
        timeoutMs: 10000,
      },
    ],
    policy: {
      risk: "read",
      allowedOrigins: ["https://example.com"],
      requiresApproval: false,
      maxRuntimeMs: 30000,
      maxSteps: 1,
    },
  });
  registry.trust(stored.workflow.slug, stored.hash);
  const result = await runWorkflow(
    registry,
    stored,
    {},
    { verification: true },
  );
  process.stdout.write(
    JSON.stringify({
      status: "PASS",
      data: result.data,
      browser: result.browserVersion,
    }) + "\n",
  );
} finally {
  registry.close();
  await rm(directory, { recursive: true, force: true });
}
