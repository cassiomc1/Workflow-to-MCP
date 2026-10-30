import { it, expect } from "vitest";
import { chromium, type Page } from "playwright";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { startDemo } from "../../apps/demo-site/src/server.js";
import { Registry } from "../../packages/registry/src/index.js";
import { verifyWorkflow } from "../../packages/testing/src/verify.js";
import type { Session } from "../../apps/extension/src/session.js";
import { parseWorkflow } from "../../packages/workflow-schema/src/index.js";
async function eventually(fn: () => Promise<boolean>, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Condition not met");
}
it("real MV3 UI capture → worker restart → parameterize → download → import → verify → MCP", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-extension-")),
    demo = await startDemo(0);
  const extension = resolve("dist/extension");
  const context = await chromium.launchPersistentContext(join(dir, "chrome"), {
    channel: "chromium",
    headless: true,
    chromiumSandbox: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      "--enable-unsafe-extension-debugging",
    ],
    acceptDownloads: true,
  });
  let registry: Registry | undefined, client: Client | undefined;
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`${demo.origin}/tickets`);
    await page.bringToFront();
    const browserCdp = await context.browser()!.newBrowserCDPSession();
    const { targetInfos } = await browserCdp.send("Target.getTargets", {
      filter: [{ type: "tab", exclude: false }],
    });
    const tabTarget = targetInfos.find((t) => t.url.startsWith(demo.origin));
    if (!tabTarget) throw new Error(JSON.stringify(targetInfos));
    await browserCdp.send("Extensions.triggerAction", {
      id,
      targetId: tabTarget.targetId,
    });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await page.bringToFront();
    await popup
      .getByRole("button", { name: "Permit this origin & record" })
      .click();
    await eventually(
      async () =>
        (await popup.locator("#status").textContent())?.includes("RECORDING") ??
        false,
    ).catch(async (e) => {
      throw new Error(
        String(e) + " / " + (await popup.locator("body").innerText()),
      );
    });
    await popup
      .getByRole("button", { name: "Choose an input to permit" })
      .click();
    await page.getByLabel("Ticket ID").click();
    await eventually(async () =>
      worker.evaluate(
        async () =>
          ((await chrome.storage.local.get("session")).session as Session)
            .safeFields.length === 1,
      ),
    );
    await page.getByLabel("Ticket ID").fill("TICKET-1001");
    await page.getByLabel("Ticket ID").press("Enter");
    await page.getByTestId("ticket-results").waitFor();
    await eventually(async () =>
      worker.evaluate(async () =>
        (
          (await chrome.storage.local.get("session")).session as Session
        ).steps.some((s: { kind: string }) => s.kind === "fill"),
      ),
    );
    // Terminate the actual MV3 worker through CDP; its next message must reconstruct state.
    const cdp = await context.newCDPSession(page);
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers");
    await popup.getByRole("button", { name: "Pause", exact: true }).click();
    await eventually(
      async () =>
        (await popup.locator("#status").textContent())?.includes("PAUSED") ??
        false,
    );
    await popup.getByRole("button", { name: "Resume", exact: true }).click();
    for (const testId of [
      "ticket-found",
      "ticket-status",
      "ticket-summary",
      "ticket-results",
    ]) {
      await popup
        .getByRole("button", { name: "Choose an output element" })
        .click();
      if (testId === "ticket-results")
        await page
          .getByTestId("ticket-summary")
          .click({ modifiers: ["Shift"] });
      else await page.getByTestId(testId).click();
      await eventually(async () => page.evaluate(() => true));
      // Wait on the durable checkpoint, avoiding dependence on the terminated worker object.
      await eventually(async () =>
        popup.evaluate(
          async () =>
            (await chrome.runtime.sendMessage({ type: "status" })).data.mode ===
            "none",
        ),
      );
    }
    const reviewPromise = context.waitForEvent("page");
    await popup.getByRole("button", { name: "Stop & review" }).click();
    const review: Page = await reviewPromise;
    await review.waitForLoadState();
    await review
      .getByLabel("Parameter for s2", { exact: true })
      .fill("ticket_id");
    for (const [index, field] of ["found", "status", "summary"].entries())
      await review
        .getByLabel(`Output name ${index + 1}`, { exact: true })
        .fill(field);
    await review
      .getByLabel("Output mode 1", { exact: true })
      .selectOption("isVisible");
    await review
      .getByRole("button", { name: "Wait until visible", exact: true })
      .last()
      .click();
    await review.locator("#risk").selectOption("read");
    await review.locator("#reviewed").check();
    const downloadPromise = review.waitForEvent("download");
    await review.getByRole("button", { name: "Export .workflow.json" }).click();
    const download = await downloadPromise,
      file = join(dir, "recording.workflow.json");
    await download.saveAs(file);
    const workflow = parseWorkflow(JSON.parse(await readFile(file, "utf8")));
    expect(workflow.inputSchema.required).toEqual(["ticket_id"]);
    expect(
      workflow.steps.some(
        (s) => s.kind === "fill" && typeof s.value === "object",
      ),
    ).toBe(true);
    await mkdir(resolve("test-results"), { recursive: true });
    await review.screenshot({
      path: resolve("test-results/extension-review.png"),
      fullPage: true,
    });
    registry = new Registry(join(dir, "registry"));
    registry.setPolicy({
      version: 1,
      grants: [{ origin: demo.origin, fixture: true }],
    });
    const stored = registry.import(workflow);
    registry.trust(workflow.slug, stored.hash);
    await verifyWorkflow(
      registry,
      stored,
      JSON.parse(await readFile("examples/demo-crm-lookup/cases.json", "utf8")),
    );
    registry.publish(workflow.slug, "1.0.0");
    client = new Client({ name: "recorded-flow-client", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          resolve("dist/cli.js"),
          "serve",
          "--stdio",
          "--home",
          join(dir, "registry"),
        ],
        env: {
          PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? "",
        },
        stderr: "pipe",
      }),
    );
    const result = await client.callTool({
      name: "wf_lookup_support_ticket",
      arguments: { ticket_id: "TICKET-1002" },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      found: true,
      status: "closed",
      summary: "A second synthetic ticket",
    });
    // Record actual sensitive field interactions and prove they never reach extension storage.
    await popup.getByRole("button", { name: "Delete recording" }).click();
    await eventually(
      async () =>
        (await popup.locator("#status").textContent()) === "Ready to record",
    );
    await page.goto(`${demo.origin}/secrets`);
    await page.bringToFront();
    const targets = await browserCdp.send("Target.getTargets", {
      filter: [{ type: "tab", exclude: false }],
    });
    const target = targets.targetInfos.find(
      (t) => t.url === `${demo.origin}/secrets`,
    )!;
    await browserCdp.send("Extensions.triggerAction", {
      id,
      targetId: target.targetId,
    });
    await popup
      .getByRole("button", { name: "Permit this origin & record" })
      .click();
    await eventually(
      async () =>
        (await popup.locator("#status").textContent())?.includes("RECORDING") ??
        false,
    );
    for (const [label, value] of [
      ["Password", "private-password-value"],
      ["Token", "ghp_abcdefghijklmnopqrstuvwxyz123456"],
      ["Card", "4111111111111111"],
      ["Unknown", "unapproved-private-field"],
    ]) {
      await page.getByLabel(label!).fill(value!);
      await page.getByLabel(label!).press("Tab");
    }
    await popup
      .getByRole("button", { name: "Choose an input to permit" })
      .click();
    await page.getByLabel("Card").click();
    await eventually(
      async () =>
        (await popup.locator("#message").textContent())?.includes(
          "SENSITIVE_VALUE_REDACTED",
        ) ?? false,
    );
    const privateState = await popup.evaluate(async () =>
      JSON.stringify(await chrome.storage.local.get(null)),
    );
    for (const value of [
      "private-password-value",
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
      "4111111111111111",
      "unapproved-private-field",
    ])
      expect(privateState).not.toContain(value);
    expect(JSON.parse(privateState).session.safeFields).toEqual([]);
  } finally {
    await client?.close();
    registry?.close();
    await context.close();
    await demo.close();
    await rm(dir, { recursive: true, force: true });
  }
});
