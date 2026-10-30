import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { runWorkflow } from "../../runner/src/index.js";
import type { Registry, StoredWorkflow } from "../../registry/src/index.js";
import { fail } from "../../shared/src/index.js";
import { digest } from "../../shared/src/hash.js";
export const suiteSchema = z.strictObject({
  version: z.literal(1),
  cases: z
    .array(
      z.strictObject({
        input: z.record(z.string(), z.unknown()),
        expected: z.record(z.string(), z.unknown()),
      }),
    )
    .min(1)
    .max(100),
});
export async function verifyWorkflow(
  registry: Registry,
  stored: StoredWorkflow,
  raw: unknown,
  approve?: (input: unknown) => Promise<string>,
) {
  const suite = suiteSchema.parse(raw),
    report = [];
  const authentication = registry.authDigest(stored.hash),
    policy = digest(registry.policy());
  const assertScope = () => {
    if (
      registry.authDigest(stored.hash) !== authentication ||
      digest(registry.policy()) !== policy
    )
      fail(
        "WORKFLOW_NOT_VERIFIED",
        "Authentication or policy changed during verification. Run the whole suite again.",
      );
  };
  registry.invalidate(stored.hash);
  let browser = "";
  for (const c of suite.cases) {
    assertScope();
    const approval = approve ? await approve(c.input) : undefined;
    assertScope();
    const result = await runWorkflow(registry, stored, c.input, {
      verification: true,
      approval,
    });
    assertScope();
    if (!isDeepStrictEqual(result.data, c.expected))
      fail("ASSERTION_FAILED", "Verification output differs from the suite.");
    report.push({ runId: result.runId, passed: true, metrics: result.metrics });
    browser = result.browserVersion;
  }
  assertScope();
  registry.attest(stored, suite, browser, report, authentication, policy);
  return { passed: report.length, hash: stored.hash, report };
}
