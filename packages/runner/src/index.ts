import { chromium, type Browser, type BrowserContext } from "playwright";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { executeStep } from "../../compiler/src/index.js";
import { validateContract } from "../../workflow-schema/src/index.js";
import { Registry, type StoredWorkflow } from "../../registry/src/index.js";
import { fail, safeError, WorkflowError } from "../../shared/src/index.js";
import { authorizeUrl } from "../../policy/src/index.js";
import { createGuardProxy } from "../../policy/src/proxy.js";
export const localActor = () => `${process.getuid?.() ?? userInfo().username}`;
export interface RunOptions {
  verification?: boolean;
  approval?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
  lifecycle?: (state: "opened" | "closed") => void;
}
export async function runWorkflow(
  registry: Registry,
  stored: StoredWorkflow,
  input: unknown,
  options: RunOptions = {},
) {
  const started = Date.now(),
    runId = `run_${randomUUID()}`;
  // Re-read immutable data and local policy at each invocation, including MCP calls.
  const current = registry.get(stored.workflow.slug, stored.workflow.version);
  if (current.hash !== stored.hash) fail("WORKFLOW_HASH_MISMATCH");
  const w = current.workflow;
  const inputs = validateContract(w.inputSchema, input);
  if (!current.trusted || ["unknown", "destructive"].includes(w.policy.risk))
    fail(
      "PERMISSION_DENIED",
      "Review and trust this exact revision using the local CLI.",
    );
  for (const step of w.steps) {
    const value =
      step.kind === "fill"
        ? step.value
        : step.kind === "select"
          ? step.option
          : undefined;
    if (value && typeof value === "object") {
      if ("secretRef" in value)
        fail(
          "SECRET_NOT_CONFIGURED",
          "Secret providers are not enabled in this release.",
        );
      if (inputs[value.param] === undefined || inputs[value.param] === null)
        fail("PARAMETER_INVALID");
    }
  }
  if (!options.verification) registry.assertVerified(current);
  const policy = registry.policy();
  for (const origin of w.policy.allowedOrigins)
    await authorizeUrl(`${origin}/`, w, policy);
  if (w.policy.risk === "write" || w.policy.requiresApproval)
    registry.consumeApproval(
      current,
      inputs,
      localActor(),
      options.approval ??
        registry.pendingApproval(current, inputs, localActor()),
    );
  if (options.signal?.aborted) fail("EXECUTION_CANCELLED");
  registry.startRun(runId, current.hash, options.idempotencyKey);
  let browser: Browser | undefined,
    context: BrowserContext | undefined,
    stepsCompleted = 0,
    submitted = false,
    violation: WorkflowError | undefined,
    browserVersion = "",
    timedOut = false;
  const output: Record<string, string | number | boolean | null> = {};
  let proxy: Awaited<ReturnType<typeof createGuardProxy>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    void context?.close().catch(() => {});
    void browser?.close().catch(() => {});
  };
  try {
    timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, w.policy.maxRuntimeMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    proxy = await createGuardProxy(w, policy, (error) => {
      violation = error;
    });
    browser = await chromium.launch({
      timeout: Math.min(30000, w.policy.maxRuntimeMs),
      headless: true,
      chromiumSandbox: true,
      proxy: proxy.config,
      args: [
        "--proxy-bypass-list=<-loopback>",
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ],
    });
    if (timedOut || options.signal?.aborted)
      fail(timedOut ? "EXECUTION_TIMEOUT" : "EXECUTION_CANCELLED");
    browserVersion = browser.version();
    context = await browser.newContext({
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    options.lifecycle?.("opened");
    let requests = 0;
    await context.route("**/*", async (route) => {
      try {
        if (++requests > 300)
          fail("PERMISSION_DENIED", "Request budget exceeded.");
        const request = route.request();
        await authorizeUrl(request.url(), w, policy);
        if (
          w.policy.risk === "read" &&
          !["GET", "HEAD"].includes(request.method())
        )
          fail(
            "PERMISSION_DENIED",
            "Read workflows cannot send mutating HTTP methods.",
          );
        if (request.isNavigationRequest() && request.frame().page() !== page)
          fail("PERMISSION_DENIED", "Multiple tabs are unsupported.");
        if (request.isNavigationRequest() && request.frame().parentFrame())
          fail(
            "UNSUPPORTED_FRAME_ORIGIN",
            "Frames are unsupported in this release.",
          );
        await route.continue();
      } catch (e) {
        violation =
          e instanceof WorkflowError
            ? e
            : new WorkflowError("ORIGIN_NOT_ALLOWED");
        await route.abort().catch(() => {});
      }
    });
    await context.routeWebSocket("**/*", (ws) => {
      violation = new WorkflowError(
        "PERMISSION_DENIED",
        "WebSockets are unsupported.",
      );
      ws.close();
    });
    const page = await context.newPage();
    context.on("page", (other) => {
      if (other !== page) {
        violation = new WorkflowError(
          "PERMISSION_DENIED",
          "Multiple tabs are unsupported.",
        );
        void other.close().catch(() => {});
      }
    });
    page.on("download", (d) => {
      violation = new WorkflowError(
        "PERMISSION_DENIED",
        "Downloads are unsupported.",
      );
      void d.cancel().catch(() => {});
    });
    const entryResponse = await page.goto(w.entrypoint, {
      waitUntil: "domcontentloaded",
      timeout: Math.min(30000, w.policy.maxRuntimeMs),
    });
    if (entryResponse && entryResponse.status() >= 400)
      fail(
        "NAVIGATION_FAILED",
        "The approved site returned an unsuccessful HTTP status.",
      );
    for (const step of w.steps) {
      if (violation) throw violation;
      if (timedOut || options.signal?.aborted)
        fail(timedOut ? "EXECUTION_TIMEOUT" : "EXECUTION_CANCELLED");
      // Conservatively mark uncertainty before any action which can submit or trigger a write.
      if (
        w.policy.risk === "write" &&
        ["click", "press", "check", "select", "fill"].includes(step.kind)
      )
        submitted = true;
      await executeStep(page, step, inputs, output);
      if (violation) throw violation;
      await authorizeUrl(page.url(), w, policy);
      stepsCompleted++;
    }
    const data = validateContract(
      w.outputSchema,
      output,
      "OUTPUT_SCHEMA_INVALID",
    );
    const metrics = { durationMs: Date.now() - started, stepsCompleted };
    registry.finishRun(runId, "SUCCEEDED", metrics);
    return {
      runId,
      workflowId: w.id,
      workflowVersion: w.version,
      status: "succeeded" as const,
      data,
      metrics,
      auditRef: runId,
      browserVersion,
      untrustedData: true as const,
    };
  } catch (e) {
    const error = submitted
      ? new WorkflowError(
          "OUTCOME_UNKNOWN",
          "A write may have committed. Inspect the application and run record before any new execution.",
        )
      : (violation ??
        (options.signal?.aborted
          ? new WorkflowError("EXECUTION_CANCELLED")
          : timedOut
            ? new WorkflowError("EXECUTION_TIMEOUT")
            : e));
    const safe = safeError(error);
    registry.finishRun(
      runId,
      submitted
        ? "OUTCOME_UNKNOWN"
        : options.signal?.aborted
          ? "CANCELLED"
          : "FAILED",
      { durationMs: Date.now() - started, stepsCompleted },
      safe.code,
    );
    throw Object.assign(
      error instanceof WorkflowError
        ? error
        : new WorkflowError(safe.code, safe.message),
      { runId },
    );
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await proxy?.close();
    options.lifecycle?.("closed");
  }
}
