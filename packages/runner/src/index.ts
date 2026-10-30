import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { executeStep } from "../../compiler/src/index.js";
import { validateContract } from "../../workflow-schema/src/index.js";
import { Registry, type StoredWorkflow } from "../../registry/src/index.js";
import { fail, safeError, WorkflowError } from "../../shared/src/index.js";
import { authorizeUrl } from "../../policy/src/index.js";
import { AuthStore } from "../../auth/src/store.js";
import type { AuthState } from "../../auth/src/schema.js";
import {
  scopedState,
  captureState,
  checkAuthentication,
  credentialRedactor,
} from "../../auth/src/session.js";
import { openControlledBrowser } from "./browser.js";
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
    runId = `run_${randomUUID()}`,
    current = registry.get(stored.workflow.slug, stored.workflow.version);
  if (current.hash !== stored.hash) fail("WORKFLOW_HASH_MISMATCH");
  const w = current.workflow,
    inputs = validateContract(w.inputSchema, input);
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
  const profile = registry.authBinding(current.hash),
    authDigest = registry.authDigest(current.hash);
  if (!options.verification) registry.assertVerified(current);
  const policy = registry.policy();
  for (const origin of w.policy.allowedOrigins)
    await authorizeUrl(`${origin}/`, w, policy);
  if (
    profile &&
    (!w.policy.allowedOrigins.every((o) =>
      profile.config.allowedOrigins.includes(o),
    ) ||
      !w.policy.allowedOrigins.includes(
        new URL(profile.config.check.url).origin,
      ))
  )
    fail("AUTH_ORIGIN_MISMATCH");
  if (options.signal?.aborted) fail("EXECUTION_CANCELLED");
  let lease: string | undefined,
    originalState: AuthState | undefined,
    session: Awaited<ReturnType<typeof openControlledBrowser>> | undefined;
  let stepsCompleted = 0,
    submitted = false,
    timedOut = false,
    runStarted = false;
  let timer: ReturnType<typeof setTimeout> | undefined,
    monitor: ReturnType<typeof setInterval> | undefined,
    authViolation: WorkflowError | undefined;
  const cancel = new AbortController(),
    signal = options.signal
      ? AbortSignal.any([options.signal, cancel.signal])
      : cancel.signal;
  const output: Record<string, string | number | boolean | null> = {},
    store = new AuthStore(registry.directory);
  const assertAccess = () => {
    if (profile) {
      registry.assertAuthProfile(profile);
      registry.assertAuthLease(profile.config.id, lease!);
      if (registry.authDigest(current.hash) !== authDigest)
        fail(
          "AUTH_PROFILE_REVOKED",
          "Authentication binding changed; verify and restart the MCP server.",
        );
    }
  };
  try {
    if (profile) {
      lease = registry.acquireAuthLease(profile.config.id);
      originalState = await store.read(profile.config.id, profile.generation);
      assertAccess();
    }
    if (w.policy.risk === "write" || w.policy.requiresApproval)
      registry.consumeApproval(
        current,
        inputs,
        localActor(),
        options.approval ??
          registry.pendingApproval(current, inputs, localActor()),
      );
    registry.startRun(runId, current.hash, options.idempotencyKey);
    runStarted = true;
    timer = setTimeout(() => {
      timedOut = true;
      cancel.abort();
    }, w.policy.maxRuntimeMs);
    session = await openControlledBrowser(w, policy, {
      state: originalState
        ? scopedState(originalState, w.policy.allowedOrigins)
        : undefined,
      signal,
      assertAccess,
    });
    options.lifecycle?.("opened");
    // A write page can submit from startup/navigation scripts before any IR
    // interaction. Conservatively preserve uncertainty from first page load.
    if (w.policy.risk === "write") submitted = true;
    if (profile) {
      monitor = setInterval(() => {
        try {
          assertAccess();
        } catch (e) {
          authViolation =
            e instanceof WorkflowError
              ? e
              : new WorkflowError("AUTH_PROFILE_REVOKED");
          cancel.abort();
        }
      }, 100);
      await checkAuthentication(session.page, profile);
      if (session.error()) throw session.error();
    }
    const response = await session.page.goto(w.entrypoint, {
      waitUntil: "domcontentloaded",
      timeout: Math.min(30000, w.policy.maxRuntimeMs),
    });
    if (
      profile &&
      (response?.status() === 401 ||
        response?.status() === 403 ||
        (session.page.url() !== w.entrypoint &&
          new URL(session.page.url()).pathname ===
            new URL(profile.config.loginUrl).pathname))
    )
      fail("AUTHENTICATION_REQUIRED", "The application requires login again.");
    if (response && response.status() >= 400)
      fail(
        "NAVIGATION_FAILED",
        "The approved site returned an unsuccessful HTTP status.",
      );
    for (const step of w.steps) {
      assertAccess();
      if (session.error()) throw session.error();
      if (timedOut || options.signal?.aborted)
        fail(timedOut ? "EXECUTION_TIMEOUT" : "EXECUTION_CANCELLED");
      if (
        w.policy.risk === "write" &&
        ["click", "press", "check", "select", "fill"].includes(step.kind)
      )
        submitted = true;
      await executeStep(session.page, step, inputs, output);
      if (session.error()) throw session.error();
      await authorizeUrl(session.page.url(), w, policy);
      stepsCompleted++;
    }
    assertAccess();
    if (profile && originalState) {
      const refreshed = await captureState(
          session.context,
          w.policy.allowedOrigins,
        ),
        hosts = w.policy.allowedOrigins.map((o) => new URL(o).hostname);
      // Preserve approved IdP state that was deliberately not loaded into this run.
      const merged: AuthState = {
        storage: {
          cookies: [
            ...originalState.storage.cookies.filter(
              (c) => !hosts.includes(c.domain.replace(/^\./, "")),
            ),
            ...refreshed.storage.cookies,
          ],
          origins: [
            ...originalState.storage.origins.filter(
              (o) => !w.policy.allowedOrigins.includes(o.origin),
            ),
            ...refreshed.storage.origins,
          ],
        },
        session: [
          ...originalState.session.filter(
            (o) => !w.policy.allowedOrigins.includes(o.origin),
          ),
          ...refreshed.session,
        ],
      };
      const redactCurrent = credentialRedactor(merged),
        redactPrevious = credentialRedactor(originalState);
      const redact = (value: string) => redactCurrent(redactPrevious(value));
      for (const [field, value] of Object.entries(output))
        if (typeof value === "string") output[field] = redact(value);
      await store.write(profile.config.id, profile.generation, merged);
      try {
        assertAccess();
      } catch (e) {
        await store.remove(profile.config.id, profile.generation);
        throw e;
      }
    }
    // Encode only after matching raw previous/current credentials. Encoding first
    // would conceal angle-containing credentials from the known-value redactor.
    for (const [field, value] of Object.entries(output))
      if (typeof value === "string")
        output[field] = value.replace(/[<>]/g, (c) =>
          c === "<" ? "&lt;" : "&gt;",
        );
    const data = validateContract(
        w.outputSchema,
        output,
        "OUTPUT_SCHEMA_INVALID",
      ),
      metrics = { durationMs: Date.now() - started, stepsCompleted };
    registry.finishRun(runId, "SUCCEEDED", metrics);
    return {
      runId,
      workflowId: w.id,
      workflowVersion: w.version,
      status: "succeeded" as const,
      data,
      metrics,
      auditRef: runId,
      browserVersion: session.browser.version(),
      untrustedData: true as const,
    };
  } catch (e) {
    const error = submitted
      ? new WorkflowError(
          "OUTCOME_UNKNOWN",
          "A write may have committed. Inspect the application and run record before any new execution.",
        )
      : (authViolation ??
        session?.error() ??
        (options.signal?.aborted
          ? new WorkflowError("EXECUTION_CANCELLED")
          : timedOut
            ? new WorkflowError("EXECUTION_TIMEOUT")
            : e));
    const safe = safeError(error);
    if (runStarted)
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
    if (monitor) clearInterval(monitor);
    await session?.close();
    if (profile && lease) registry.releaseAuthLease(profile.config.id, lease);
    if (runStarted) options.lifecycle?.("closed");
  }
}
