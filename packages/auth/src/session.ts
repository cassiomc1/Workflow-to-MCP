import { randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "playwright";
import type { Registry } from "../../registry/src/index.js";
import { type Workflow } from "../../workflow-schema/src/index.js";
import { authorizeUrl } from "../../policy/src/index.js";
import { openControlledBrowser } from "../../runner/src/browser.js";
import { resolveLocator } from "../../compiler/src/index.js";
import { fail, WorkflowError } from "../../shared/src/index.js";
import {
  authConfigSchema,
  authStateSchema,
  type AuthConfig,
  type AuthState,
  type AuthProfile,
} from "./schema.js";
import { AuthStore, MAX_AUTH_BYTES } from "./store.js";
import { digest } from "../../shared/src/hash.js";
export function scopedState(
  state: AuthState,
  origins: readonly string[],
): AuthState {
  const hosts = [...new Set(origins.map((raw) => new URL(raw).hostname))];
  const cookies: AuthState["storage"]["cookies"] = [];
  for (const cookie of state.storage.cookies) {
    const domain = cookie.domain.replace(/^\./, "").toLowerCase();
    const includesSubdomains = cookie.domain.startsWith(".");
    for (const host of hosts)
      if (
        host === domain ||
        (includesSubdomains && host.endsWith(`.${domain}`))
      )
        cookies.push({ ...cookie, domain: host });
  }
  const unique = new Map(
    cookies.map((c) => [
      `${c.domain}/${c.path}/${c.name}/${c.partitionKey ?? ""}`,
      c,
    ]),
  );
  return authStateSchema.parse({
    storage: {
      cookies: [...unique.values()],
      origins: state.storage.origins.filter((s) => origins.includes(s.origin)),
    },
    session: state.session.filter((s) => origins.includes(s.origin)),
  });
}
export async function captureState(
  context: BrowserContext,
  origins: readonly string[],
): Promise<AuthState> {
  const storage = await context.storageState({ indexedDB: true });
  const session: AuthState["session"] = [];
  for (const page of context.pages()) {
    let origin: string;
    try {
      origin = new URL(page.url()).origin;
    } catch {
      continue;
    }
    if (origins.includes(origin))
      session.push({
        origin,
        values: await page.evaluate(() =>
          Object.entries(sessionStorage).filter(
            ([key]) => key !== "__workflow_auth_restored__",
          ),
        ),
      });
  }
  if (Buffer.byteLength(JSON.stringify({ storage, session })) > MAX_AUTH_BYTES)
    fail("AUTH_STATE_TOO_LARGE");
  return scopedState(authStateSchema.parse({ storage, session }), origins);
}
export async function checkAuthentication(page: Page, profile: AuthProfile) {
  const target = new URL(profile.config.check.url);
  const response = await page.goto(target.href, {
    waitUntil: "domcontentloaded",
    timeout: 15000,
  });
  const actual = new URL(page.url());
  if (
    response?.status() === 401 ||
    response?.status() === 403 ||
    actual.origin !== target.origin ||
    actual.pathname !== target.pathname
  )
    fail(
      "AUTHENTICATION_REQUIRED",
      "The application requires login again for this profile.",
    );
  if (response && response.status() >= 400)
    fail(
      "AUTH_CHECK_FAILED",
      "The authentication check endpoint did not succeed.",
    );
  const locator = resolveLocator(page, profile.config.check.locator);
  if ((await locator.count()) > 1)
    fail("AUTH_CHECK_FAILED", "The authenticated marker must be unique.");
  await locator
    .waitFor({ state: "visible", timeout: 5000 })
    .catch(() =>
      fail(
        "AUTHENTICATION_REQUIRED",
        "The authenticated marker is missing. Log in again.",
      ),
    );
  if ((await locator.count()) !== 1) fail("AUTH_CHECK_FAILED");
}
function loginWorkflow(config: AuthConfig): Workflow {
  return {
    schemaVersion: "1.0.0",
    id: "wf_auth_login",
    slug: "auth_login",
    version: "1.0.0",
    title: "Manual authentication",
    description: "Local user authentication in a dedicated ephemeral browser.",
    provenance: {
      source: "fixture",
      recorderVersion: "0.1.0",
      createdAt: new Date().toISOString(),
    },
    entrypoint: config.loginUrl,
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
    steps: [],
    policy: {
      risk: "write",
      requiresApproval: true,
      allowedOrigins: config.allowedOrigins,
      maxRuntimeMs: 120000,
      maxSteps: 1,
    },
  };
}
export async function beginLogin(
  registry: Registry,
  raw: unknown,
  options: { headless?: boolean; signal?: AbortSignal } = {},
) {
  const config = authConfigSchema.parse(raw),
    store = new AuthStore(registry.directory);
  await store.initialize();
  const workflow = loginWorkflow(config),
    policy = registry.policy(),
    policyDigest = digest(policy);
  for (const origin of config.allowedOrigins)
    await authorizeUrl(`${origin}/`, workflow, policy);
  const previous = registry.authProfile(config.id, true),
    lease = registry.acquireAuthLease(config.id);
  let expectedGeneration = previous?.generation ?? null;
  let session: Awaited<ReturnType<typeof openControlledBrowser>> | undefined,
    done = false;
  const timeout = AbortSignal.timeout(30 * 60000),
    signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
  const close = async () => {
    if (done) return;
    done = true;
    await session?.close();
    registry.releaseAuthLease(config.id, lease);
  };
  try {
    const assertScope = () => {
      registry.assertAuthLease(config.id, lease);
      if (digest(registry.policy()) !== policyDigest)
        fail("PERMISSION_DENIED", "Installation policy changed during login.");
      if (
        (registry.authProfile(config.id, true)?.generation ?? null) !==
        expectedGeneration
      )
        fail("AUTH_PROFILE_REVOKED");
    };
    session = await openControlledBrowser(workflow, policy, {
      headless: options.headless ?? false,
      signal,
      requestLimit: 1000,
      assertAccess: assertScope,
      watchAccess: true,
    });
    await session.page.goto(config.loginUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    if (session.error()) throw session.error();
    const browserSession = session;
    return {
      page: session.page,
      context: session.context,
      close,
      async save() {
        assertScope();
        if (done || signal.aborted) fail("AUTH_LOGIN_CANCELLED");
        if (browserSession.error()) throw browserSession.error();
        const profile: AuthProfile = {
          config,
          generation: randomUUID(),
          expiresAt: Date.now() + config.ttlHours * 3600000,
          createdAt: new Date().toISOString(),
          status: "READY",
        };
        await checkAuthentication(browserSession.page, profile);
        if (browserSession.error()) throw browserSession.error();
        const state = await captureState(
          browserSession.context,
          config.allowedOrigins,
        );
        // Re-open the captured state before saving: a login only held in page memory
        // must not be advertised as a reusable authenticated profile.
        const proof = await openControlledBrowser(
          {
            ...workflow,
            policy: {
              ...workflow.policy,
              risk: "read",
              requiresApproval: false,
            },
          },
          policy,
          {
            state,
            signal,
            assertAccess: assertScope,
            watchAccess: true,
          },
        );
        try {
          await checkAuthentication(proof.page, profile);
          if (proof.error()) throw proof.error();
          const checked = await captureState(
            proof.context,
            config.allowedOrigins,
          );
          await store.write(config.id, profile.generation, checked);
          try {
            registry.saveAuthProfile(
              profile,
              previous?.generation ?? null,
              lease,
              policyDigest,
            );
            expectedGeneration = profile.generation;
          } catch (e) {
            await store.remove(config.id, profile.generation);
            throw e;
          }
        } finally {
          await proof.close();
        }
        if (previous) await store.remove(config.id, previous.generation);
        await close();
        registry.assertAuthProfile(profile);
        return profile;
      },
    };
  } catch (e) {
    await close();
    if (signal.aborted)
      throw new WorkflowError(
        "AUTH_LOGIN_CANCELLED",
        "Login cancelled or timed out.",
      );
    throw e;
  }
}
export async function revokeProfile(registry: Registry, id: string) {
  registry.revokeAuth(id);
  await new AuthStore(registry.directory).eraseProfile(id);
}
export function credentialRedactor(state: AuthState) {
  const values = state.storage.cookies.map((c) => c.value).filter(Boolean);
  for (const origin of state.storage.origins)
    for (const item of origin.localStorage)
      if (/token|secret|auth|session|credential/i.test(item.name))
        values.push(item.value);
  for (const origin of state.session)
    for (const [name, value] of origin.values)
      if (/token|secret|auth|session|credential/i.test(name))
        values.push(value);
  const known = [...new Set(values.filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  return (value: string) => {
    for (const secret of known) {
      if (value === secret) return "[REDACTED]";
      if (secret.length >= 8) value = value.replaceAll(secret, "[REDACTED]");
    }
    return value;
  };
}
