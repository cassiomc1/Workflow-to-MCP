import { chromium, type BrowserContext, type Browser } from "playwright";
import { randomUUID } from "node:crypto";
import type { Workflow } from "../../workflow-schema/src/index.js";
import {
  authorizeUrl,
  permittedReadRequest,
  type InstallationPolicy,
} from "../../policy/src/index.js";
import { createGuardProxy } from "../../policy/src/proxy.js";
import { fail, WorkflowError } from "../../shared/src/index.js";
import type { AuthState } from "../../auth/src/schema.js";
export async function openControlledBrowser(
  w: Workflow,
  policy: InstallationPolicy,
  options: {
    headless?: boolean;
    state?: AuthState;
    signal?: AbortSignal;
    assertAccess?: () => void;
    requestLimit?: number;
    watchAccess?: boolean;
  } = {},
) {
  let violation: WorkflowError | undefined,
    browser: Browser | undefined,
    context: BrowserContext | undefined,
    closed: Promise<void> | undefined;
  let monitor: ReturnType<typeof setInterval> | undefined;
  const proxy = await createGuardProxy(w, policy, (e) => {
    violation = e;
  });
  const close = () =>
    (closed ??= (async () => {
      if (monitor) clearInterval(monitor);
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
      await proxy.close();
    })());
  const abort = () => {
    void close();
  };
  try {
    browser = await chromium.launch({
      headless: options.headless ?? true,
      chromiumSandbox: true,
      timeout: Math.min(30000, w.policy.maxRuntimeMs),
      proxy: proxy.config,
      args: [
        "--proxy-bypass-list=<-loopback>",
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ],
    });
    if (options.signal?.aborted) fail("EXECUTION_CANCELLED");
    context = await browser.newContext({
      serviceWorkers: "block",
      acceptDownloads: false,
      storageState: options.state?.storage as
        Awaited<ReturnType<BrowserContext["storageState"]>> | undefined,
    });
    if (options.state)
      await context.addInitScript(
        ({ entries, nonce }) => {
          if (window.top !== window) return;
          const entry = entries.find((e) => e.origin === location.origin);
          if (
            entry &&
            sessionStorage.getItem("__workflow_auth_restored__") !== nonce
          ) {
            for (const [key, value] of entry.values)
              sessionStorage.setItem(key, value);
            sessionStorage.setItem("__workflow_auth_restored__", nonce);
          }
        },
        { entries: options.state.session, nonce: randomUUID() },
      );
    let requests = 0;
    await context.route("**/*", async (route) => {
      try {
        options.assertAccess?.();
        if (++requests > (options.requestLimit ?? 300))
          fail("PERMISSION_DENIED", "Request budget exceeded.");
        const request = route.request();
        await authorizeUrl(request.url(), w, policy);
        if (w.policy.risk === "read" && !permittedReadRequest(request.method()))
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
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) fail("EXECUTION_CANCELLED");
    if (options.watchAccess)
      monitor = setInterval(() => {
        try {
          options.assertAccess?.();
        } catch (e) {
          violation =
            e instanceof WorkflowError
              ? e
              : new WorkflowError("PERMISSION_DENIED");
          void close();
        }
      }, 100);
    return {
      browser,
      context,
      page,
      error: () => violation,
      close: async () => {
        options.signal?.removeEventListener("abort", abort);
        await close();
      },
    };
  } catch (e) {
    await close();
    throw e;
  }
}
