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
it("executes 1.1.0 scoped locators, state waits, conditions, assertions, and transforms", async () => {
  const s = await setup();
  try {
    const scopedWorkflow = {
      ...s.stored.workflow,
      schemaVersion: "1.1.0" as const,
      version: "1.1.0",
      entrypoint: s.demo.origin + "/scoped",
      inputSchema: {
        type: "object" as const,
        properties: {
          add_note: { type: "boolean" as const },
          note: { type: "string" as const, maxLength: 100 },
          target_flag: { type: "string" as const },
        },
        required: ["add_note", "target_flag"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          selected: { type: "string" as const },
          raw_badge: { type: "string" as const },
          trimmed: { type: "string" as const },
          lower: { type: "string" as const },
          upper: { type: "string" as const },
          digits: { type: "string" as const },
          parsed_int: { type: "integer" as const },
          parsed_num: { type: "number" as const },
          parsed_bool: { type: "boolean" as const },
          bool_text: { type: "string" as const },
          missing_scoped: { type: ["string", "null"] as ["string", "null"] },
          missing_visible: { type: "boolean" as const },
          missing_count: { type: "integer" as const },
        },
        required: [
          "selected",
          "raw_badge",
          "trimmed",
          "lower",
          "upper",
          "digits",
          "parsed_int",
          "parsed_num",
          "parsed_bool",
          "bool_text",
          "missing_scoped",
          "missing_visible",
          "missing_count",
        ],
        additionalProperties: false as const,
      },
      steps: [
        {
          id: "s1",
          kind: "fill" as const,
          when: {
            source: { source: "input" as const, field: "add_note" },
            operator: "isTrue" as const,
          },
          locator: { strategy: "label" as const, value: "Note" },
          value: { param: "note" },
          timeoutMs: 2000,
        },
        {
          id: "s2",
          kind: "waitForState" as const,
          locator: { strategy: "testId" as const, value: "loading-banner" },
          state: "visible" as const,
          timeoutMs: 2000,
        },
        {
          id: "s3",
          kind: "waitForState" as const,
          locator: { strategy: "testId" as const, value: "never-banner" },
          state: "detached" as const,
          timeoutMs: 2000,
        },
        {
          id: "s4",
          kind: "click" as const,
          locator: {
            strategy: "within" as const,
            scopes: [
              {
                strategy: "role" as const,
                role: "main" as const,
                name: "Scoped workspace",
              },
              {
                strategy: "role" as const,
                role: "group" as const,
                name: "Queue container",
              },
              {
                strategy: "role" as const,
                role: "region" as const,
                name: "Primary queue",
              },
              {
                strategy: "role" as const,
                role: "group" as const,
                name: "Primary card",
              },
            ],
            target: {
              strategy: "role" as const,
              role: "button" as const,
              name: "Select",
            },
          },
          timeoutMs: 2000,
        },
        {
          id: "s5",
          kind: "waitForState" as const,
          locator: { strategy: "testId" as const, value: "loading-banner" },
          state: "detached" as const,
          timeoutMs: 2000,
        },
        {
          id: "s6",
          kind: "assert" as const,
          locator: { strategy: "testId" as const, value: "loading-banner" },
          predicate: "visible" as const,
          expected: false,
          timeoutMs: 2000,
        },
        {
          id: "s7",
          kind: "waitForState" as const,
          locator: { strategy: "testId" as const, value: "selected-out" },
          state: "attached" as const,
          timeoutMs: 2000,
        },
        {
          id: "s8",
          kind: "extract" as const,
          locator: { strategy: "testId" as const, value: "selected-out" },
          field: "selected",
          mode: "textContent" as const,
          allowMissing: false,
          timeoutMs: 2000,
        },
        {
          id: "s9",
          kind: "click" as const,
          when: {
            source: { source: "output" as const, field: "selected" },
            operator: "equals" as const,
            value: "Primary queue:extra",
          },
          locator: {
            strategy: "within" as const,
            scopes: [
              {
                strategy: "role" as const,
                role: "region" as const,
                name: "Archive queue",
              },
            ],
            target: {
              strategy: "role" as const,
              role: "button" as const,
              name: "Select",
            },
          },
          timeoutMs: 2000,
        },
        {
          id: "s10",
          kind: "extract" as const,
          locator: {
            strategy: "within" as const,
            scopes: [
              {
                strategy: "role" as const,
                role: "region" as const,
                name: "Primary queue",
              },
            ],
            target: { strategy: "testId" as const, value: "row-badge" },
          },
          field: "raw_badge",
          mode: "textContent" as const,
          allowMissing: false,
          timeoutMs: 2000,
        },
        {
          id: "s11",
          kind: "extract" as const,
          locator: {
            strategy: "within" as const,
            scopes: [
              {
                strategy: "role" as const,
                role: "region" as const,
                name: "Missing queue",
              },
            ],
            target: { strategy: "testId" as const, value: "row-badge" },
          },
          field: "missing_scoped",
          mode: "textContent" as const,
          allowMissing: true,
          timeoutMs: 1000,
        },
        {
          id: "s12",
          kind: "extract" as const,
          locator: {
            strategy: "within" as const,
            scopes: [
              {
                strategy: "role" as const,
                role: "region" as const,
                name: "Missing queue",
              },
            ],
            target: { strategy: "testId" as const, value: "row-badge" },
          },
          field: "missing_visible",
          mode: "isVisible" as const,
          allowMissing: true,
          timeoutMs: 1000,
        },
        {
          id: "s13",
          kind: "extract" as const,
          locator: {
            strategy: "within" as const,
            scopes: [
              {
                strategy: "role" as const,
                role: "region" as const,
                name: "Missing queue",
              },
            ],
            target: { strategy: "testId" as const, value: "row-badge" },
          },
          field: "missing_count",
          mode: "count" as const,
          allowMissing: true,
          timeoutMs: 1000,
        },
        {
          id: "s14",
          kind: "transform" as const,
          source: { source: "output" as const, field: "raw_badge" },
          operation: "trim" as const,
          field: "trimmed",
          timeoutMs: 1000,
        },
        {
          id: "s15",
          kind: "transform" as const,
          source: { source: "output" as const, field: "trimmed" },
          operation: "lowercase" as const,
          field: "lower",
          timeoutMs: 1000,
        },
        {
          id: "s16",
          kind: "transform" as const,
          source: { source: "output" as const, field: "trimmed" },
          operation: "uppercase" as const,
          field: "upper",
          timeoutMs: 1000,
        },
        {
          id: "s17",
          kind: "transform" as const,
          source: { source: "output" as const, field: "trimmed" },
          operation: "digitsOnly" as const,
          field: "digits",
          timeoutMs: 1000,
        },
        {
          id: "s18",
          kind: "transform" as const,
          source: { source: "output" as const, field: "digits" },
          operation: "parseInteger" as const,
          field: "parsed_int",
          timeoutMs: 1000,
        },
        {
          id: "s19",
          kind: "transform" as const,
          source: { source: "input" as const, field: "target_flag" },
          operation: "parseNumber" as const,
          field: "parsed_num",
          timeoutMs: 1000,
        },
        {
          id: "s20",
          kind: "transform" as const,
          source: { source: "output" as const, field: "raw_badge" },
          operation: "parseBoolean" as const,
          when: undefined,
          field: "parsed_bool",
          timeoutMs: 1000,
        },
      ],
    };
    // Swap s20 to parse row-flag so all 8 transforms pass cleanly.
    const fullWorkflow = {
      ...scopedWorkflow,
      steps: [
        ...scopedWorkflow.steps.slice(0, 19),
        {
          id: "s20",
          kind: "extract" as const,
          locator: {
            strategy: "within" as const,
            scopes: [
              {
                strategy: "role" as const,
                role: "region" as const,
                name: "Primary queue",
              },
            ],
            target: { strategy: "testId" as const, value: "row-flag" },
          },
          field: "raw_flag",
          mode: "textContent" as const,
          allowMissing: false,
          timeoutMs: 1000,
        },
        {
          id: "s21",
          kind: "transform" as const,
          source: { source: "output" as const, field: "raw_flag" },
          operation: "parseBoolean" as const,
          field: "parsed_bool",
          timeoutMs: 1000,
        },
        {
          id: "s22",
          kind: "transform" as const,
          source: { source: "output" as const, field: "parsed_bool" },
          operation: "stringify" as const,
          field: "bool_text",
          timeoutMs: 1000,
        },
      ],
      outputSchema: {
        ...scopedWorkflow.outputSchema,
        properties: {
          ...scopedWorkflow.outputSchema.properties,
          raw_flag: { type: "string" as const },
        },
        required: [...scopedWorkflow.outputSchema.required, "raw_flag"],
      },
    };
    const stored = s.registry.import(fullWorkflow);
    s.registry.trust(fullWorkflow.slug, stored.hash, fullWorkflow.version);

    // Optional note omitted with add_note: false skips conditional fill cleanly.
    const skipped = await runWorkflow(
      s.registry,
      stored,
      { add_note: false, target_flag: "-0" },
      { verification: true },
    );
    expect(skipped.data).toEqual({
      selected: "Primary queue:",
      raw_badge: "Order #0042",
      raw_flag: "true",
      trimmed: "Order #0042",
      lower: "order #0042",
      upper: "ORDER #0042",
      digits: "0042",
      parsed_int: 42,
      parsed_num: 0,
      parsed_bool: true,
      bool_text: "true",
      missing_scoped: null,
      missing_visible: false,
      missing_count: 0,
    });
    expect(Object.is(skipped.data.parsed_num, -0)).toBe(false);

    // Output-sourced when condition triggers when selected === "Primary queue:extra".
    const updated = await runWorkflow(
      s.registry,
      stored,
      { add_note: true, note: "extra", target_flag: "19.5" },
      { verification: true },
    );
    expect(updated.data.parsed_num).toBe(19.5);
    expect(updated.data.selected).toBe("Primary queue:extra");

    // Ambiguous scope & ambiguous target inside unique scope fail with LOCATOR_AMBIGUOUS;
    // missing scope fails with LOCATOR_NOT_FOUND; null stringify fails with TRANSFORM_INPUT_INVALID.
    for (const [label, step, expectedCode] of [
      [
        "ambiguous-scope",
        {
          id: "s1",
          kind: "click" as const,
          locator: {
            strategy: "within" as const,
            scopes: [
              {
                strategy: "role" as const,
                role: "group" as const,
                name: "Duplicate group",
              },
            ],
            target: {
              strategy: "role" as const,
              role: "button" as const,
              name: "Go",
            },
          },
          timeoutMs: 1000,
        },
        "LOCATOR_AMBIGUOUS",
      ],
      [
        "ambiguous-target",
        {
          id: "s1",
          kind: "click" as const,
          locator: {
            strategy: "within" as const,
            scopes: [
              {
                strategy: "role" as const,
                role: "group" as const,
                name: "Unique group",
              },
            ],
            target: {
              strategy: "role" as const,
              role: "button" as const,
              name: "Dup",
            },
          },
          timeoutMs: 1000,
        },
        "LOCATOR_AMBIGUOUS",
      ],
      [
        "missing-scope",
        {
          id: "s1",
          kind: "click" as const,
          locator: {
            strategy: "within" as const,
            scopes: [
              {
                strategy: "role" as const,
                role: "group" as const,
                name: "Nonexistent",
              },
            ],
            target: {
              strategy: "role" as const,
              role: "button" as const,
              name: "Go",
            },
          },
          timeoutMs: 300,
        },
        "LOCATOR_NOT_FOUND",
      ],
    ] as const) {
      const bad = s.registry.import({
        ...fullWorkflow,
        version:
          label === "ambiguous-scope"
            ? "1.1.1"
            : label === "ambiguous-target"
              ? "1.1.2"
              : "1.1.3",
        inputSchema: {
          type: "object" as const,
          properties: {},
          required: [],
          additionalProperties: false as const,
        },
        outputSchema: {
          type: "object" as const,
          properties: {},
          required: [],
          additionalProperties: false as const,
        },
        steps: [step],
      });
      s.registry.trust(bad.workflow.slug, bad.hash, bad.workflow.version);
      await expect(
        runWorkflow(s.registry, bad, {}, { verification: true }),
      ).rejects.toMatchObject({ code: expectedCode });
    }

    // Null output into stringify fails closed with TRANSFORM_INPUT_INVALID.
    const nullTransform = s.registry.import({
      ...fullWorkflow,
      version: "1.1.4",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          missing_text: { type: ["string", "null"] as ["string", "null"] },
          derived: { type: "string" as const },
        },
        required: ["missing_text", "derived"],
        additionalProperties: false as const,
      },
      steps: [
        {
          id: "s1",
          kind: "extract" as const,
          locator: { strategy: "testId" as const, value: "never" },
          field: "missing_text",
          mode: "textContent" as const,
          allowMissing: true,
          timeoutMs: 500,
        },
        {
          id: "s2",
          kind: "transform" as const,
          source: { source: "output" as const, field: "missing_text" },
          operation: "stringify" as const,
          field: "derived",
          timeoutMs: 500,
        },
      ],
    });
    s.registry.trust(
      nullTransform.workflow.slug,
      nullTransform.hash,
      nullTransform.workflow.version,
    );
    await expect(
      runWorkflow(s.registry, nullTransform, {}, { verification: true }),
    ).rejects.toMatchObject({ code: "TRANSFORM_INPUT_INVALID" });
  } finally {
    await s.close();
  }
});
