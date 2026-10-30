import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { setup } from "../helpers.js";
import { runWorkflow } from "../../packages/runner/src/index.js";
import { verifyWorkflow } from "../../packages/testing/src/verify.js";
it("replays select, check, Enter, exact URL and declarative assertions on actual DOM controls", async () => {
  const s = await setup();
  try {
    const w = {
      ...s.stored.workflow,
      version: "1.0.1",
      entrypoint: s.demo.origin + "/controls",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { result: { type: "string" }, count: { type: "integer" } },
        required: ["result", "count"],
        additionalProperties: false,
      },
      steps: [
        {
          id: "s1",
          kind: "select",
          locator: { strategy: "label", value: "Priority" },
          option: "urgent",
          timeoutMs: 1000,
        },
        {
          id: "s2",
          kind: "check",
          locator: { strategy: "label", value: "Include archived" },
          checked: true,
          timeoutMs: 1000,
        },
        {
          id: "s3",
          kind: "fill",
          locator: { strategy: "label", value: "Query" },
          value: "synthetic",
          timeoutMs: 1000,
        },
        {
          id: "s4",
          kind: "press",
          locator: { strategy: "label", value: "Query" },
          key: "Enter",
          timeoutMs: 1000,
        },
        {
          id: "s5",
          kind: "waitForURL",
          urlPattern: s.demo.origin + "/controls",
          timeoutMs: 1000,
        },
        {
          id: "s6",
          kind: "waitForVisible",
          locator: { strategy: "testId", value: "control-result" },
          timeoutMs: 1000,
        },
        {
          id: "s7",
          kind: "assert",
          locator: { strategy: "testId", value: "control-result" },
          predicate: "textEquals",
          expected: "urgent:true:synthetic",
          timeoutMs: 1000,
        },
        {
          id: "s8",
          kind: "extract",
          locator: { strategy: "testId", value: "control-result" },
          field: "result",
          mode: "textContent",
          allowMissing: false,
          timeoutMs: 1000,
        },
        {
          id: "s9",
          kind: "extract",
          locator: { strategy: "testId", value: "control-result" },
          field: "count",
          mode: "count",
          allowMissing: false,
          timeoutMs: 1000,
        },
      ],
    };
    const stored = s.registry.import(w);
    s.registry.trust(w.slug, stored.hash, w.version);
    expect(
      (await runWorkflow(s.registry, stored, {}, { verification: true })).data,
    ).toEqual({ result: "urgent:true:synthetic", count: 1 });
  } finally {
    await s.close();
  }
});
it("rejects unsupported frame navigation before replay", async () => {
  const s = await setup();
  try {
    const w = {
      ...s.stored.workflow,
      version: "1.0.1",
      entrypoint: s.demo.origin + "/frames",
    };
    const stored = s.registry.import(w);
    s.registry.trust(w.slug, stored.hash, w.version);
    await expect(
      runWorkflow(
        s.registry,
        stored,
        { ticket_id: "TICKET-1001" },
        { verification: true },
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FRAME_ORIGIN" });
  } finally {
    await s.close();
  }
});
it("runs real Chromium lookup, missing outputs and exact content verification", async () => {
  const s = await setup();
  const lifecycle: string[] = [];
  try {
    const suite = JSON.parse(
      await readFile("examples/demo-crm-lookup/cases.json", "utf8"),
    );
    const verification = await verifyWorkflow(s.registry, s.stored, suite);
    expect(verification.passed).toBe(3);
    s.registry.publish(s.stored.workflow.slug, "1.0.0");
    const result = await runWorkflow(
      s.registry,
      s.stored,
      { ticket_id: "TICKET-1001" },
      { lifecycle: (v) => lifecycle.push(v) },
    );
    expect(result.data).toEqual(suite.cases[0].expected);
    expect(lifecycle).toEqual(["opened", "closed"]);
    expect(s.registry.inspectRun(result.runId).status).toBe("SUCCEEDED");
  } finally {
    await s.close();
  }
});
it("invalid arguments and missing approval fail before browser allocation", async () => {
  const s = await setup(true);
  const lifecycle: string[] = [];
  try {
    await expect(
      runWorkflow(
        s.registry,
        s.stored,
        { summary: 3 },
        { verification: true, lifecycle: (v) => lifecycle.push(v) },
      ),
    ).rejects.toMatchObject({ code: "PARAMETER_INVALID" });
    await expect(
      runWorkflow(
        s.registry,
        s.stored,
        { summary: "test" },
        { verification: true, lifecycle: (v) => lifecycle.push(v) },
      ),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(lifecycle).toEqual([]);
    expect(s.demo.writes).toBe(0);
  } finally {
    await s.close();
  }
});
it("rejects unresolved secret refs before allocating a browser", async () => {
  const s = await setup(),
    states: string[] = [];
  try {
    const w = {
      ...s.stored.workflow,
      version: "1.0.1",
      steps: s.stored.workflow.steps.map((step) =>
        step.kind === "fill"
          ? { ...step, value: { secretRef: "demo/ticket" } }
          : step,
      ),
    };
    const stored = s.registry.import(w);
    s.registry.trust(w.slug, stored.hash, w.version);
    await expect(
      runWorkflow(
        s.registry,
        stored,
        { ticket_id: "x" },
        { verification: true, lifecycle: (v) => states.push(v) },
      ),
    ).rejects.toMatchObject({ code: "SECRET_NOT_CONFIGURED" });
    expect(states).toEqual([]);
  } finally {
    await s.close();
  }
});
it("fails ambiguity, redirect and missing locator with browser cleanup", async () => {
  const s = await setup();
  try {
    for (const [path, code] of [
      ["/duplicate", "LOCATOR_AMBIGUOUS"],
      ["/redirect", "ORIGIN_NOT_ALLOWED"],
      ["/tickets", "LOCATOR_NOT_FOUND"],
    ] as const) {
      const w = {
        ...s.stored.workflow,
        version:
          path === "/duplicate"
            ? "1.0.1"
            : path === "/redirect"
              ? "1.0.2"
              : "1.0.3",
        entrypoint: s.demo.origin + path,
        outputSchema: {
          type: "object" as const,
          properties: {},
          required: [],
          additionalProperties: false as const,
        },
        steps: [
          {
            id: "s1",
            kind: "click" as const,
            locator: {
              strategy: "role" as const,
              role: "button" as const,
              name: path === "/tickets" ? "Missing" : "Search",
            },
            timeoutMs: 500,
          },
        ],
      };
      const stored = s.registry.import(w);
      s.registry.trust(w.slug, stored.hash, w.version);
      const lifecycle: string[] = [];
      await expect(
        runWorkflow(
          s.registry,
          stored,
          { ticket_id: "TICKET-1001" },
          { verification: true, lifecycle: (v) => lifecycle.push(v) },
        ),
      ).rejects.toMatchObject({ code });
      expect(lifecycle).toEqual(["opened", "closed"]);
    }
  } finally {
    await s.close();
  }
});
it("cancellation closes a live context and records CANCELLED", async () => {
  const s = await setup();
  try {
    const w = {
      ...s.stored.workflow,
      version: "1.0.1",
      steps: [
        {
          id: "s1",
          kind: "waitForVisible",
          locator: { strategy: "testId", value: "never" },
          timeoutMs: 20000,
        },
      ],
      outputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    };
    const stored = s.registry.import(w);
    s.registry.trust(w.slug, stored.hash, w.version);
    const controller = new AbortController(),
      states: string[] = [];
    await expect(
      runWorkflow(
        s.registry,
        stored,
        { ticket_id: "x" },
        {
          verification: true,
          signal: controller.signal,
          lifecycle: (v) => {
            states.push(v);
            if (v === "opened") setTimeout(() => controller.abort(), 200);
          },
        },
      ),
    ).rejects.toMatchObject({ code: "EXECUTION_CANCELLED" });
    expect(states).toEqual(["opened", "closed"]);
  } finally {
    await s.close();
  }
});
