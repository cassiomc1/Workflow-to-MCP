import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir, cpus, platform, release } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { startDemo } from "../../../apps/demo-site/src/server.js";
import { Registry } from "../../registry/src/index.js";
import { verifyWorkflow } from "./verify.js";
import { digest } from "../../shared/src/hash.js";
import { runWorkflow } from "../../runner/src/index.js";
const count = Number(process.env.BENCHMARK_RUNS ?? 100);
if (!Number.isInteger(count) || count < 1 || count > 1000)
  throw new Error("Invalid run count.");
const directory = await mkdtemp(join(tmpdir(), "workflow-benchmark-"));
const demo = await startDemo(0, { variation: true, seed: 0 }),
  registry = new Registry(directory);
try {
  const fixture = JSON.parse(
    await readFile("examples/demo-crm-lookup/workflow.json", "utf8"),
  );
  const w = JSON.parse(
    JSON.stringify(fixture).replaceAll("http://127.0.0.1:4173", demo.origin),
  );
  registry.setPolicy({
    version: 1,
    grants: [{ origin: demo.origin, fixture: true }],
  });
  const stored = registry.import(w);
  registry.trust(w.slug, stored.hash);
  const suite = JSON.parse(
    await readFile("examples/demo-crm-lookup/cases.json", "utf8"),
  );
  await verifyWorkflow(registry, stored, suite);
  const times: number[] = [],
    failures: string[] = [];
  let browserVersion = "";
  for (let i = 0; i < count; i++) {
    try {
      const r = await runWorkflow(registry, stored, {
        ticket_id: i % 2 ? "TICKET-1001" : "TICKET-1002",
      });
      times.push(r.metrics.durationMs);
      browserVersion = r.browserVersion;
    } catch {
      failures.push(`run-${i}`);
    }
    if ((i + 1) % 10 === 0)
      process.stderr.write(`Completed ${i + 1}/${count}\n`);
  }
  times.sort((a, b) => a - b);
  const report = {
    count,
    successes: times.length,
    successRate: times.length / count,
    failures,
    medianMs: times[Math.floor(times.length / 2)],
    p95Ms:
      times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)],
    os: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model,
    node: process.version,
    browserVersion,
    seed: 0,
    fixtureHash: digest(fixture),
    sourceTreeDirty:
      execFileSync("git", ["status", "--porcelain"], {
        encoding: "utf8",
      }).trim().length > 0,
    profile:
      "Alternating two ticket IDs; deterministic 0–179 ms rendering delay and changing wrappers/classes across navigations. Isolated browser startup included.",
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
  };
  await writeFile(
    "docs/benchmark-results.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (report.successRate < 0.95) process.exitCode = 1;
} finally {
  registry.close();
  await demo.close();
  await rm(directory, { recursive: true, force: true });
}
