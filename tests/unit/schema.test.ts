import { describe, it, expect } from "vitest";
import {
  parseWorkflow,
  canonicalize,
  validateContract,
  migrateWorkflow,
} from "../../packages/workflow-schema/src/index.js";
import { digest } from "../../packages/shared/src/hash.js";
import {
  sanitizeValue,
  secretLike,
  safeCapturedStep,
} from "../../packages/recorder-core/src/index.js";
import { fixtureWorkflow } from "../helpers.js";
describe("versioned workflow contract", () => {
  it("round-trips and hashes canonically", async () => {
    const w = await fixtureWorkflow();
    expect(parseWorkflow(JSON.parse(canonicalize(w)))).toEqual(w);
    expect(digest({ a: 1, b: 2 })).toBe(digest({ b: 2, a: 1 }));
    expect(migrateWorkflow(w)).toEqual(w);
  });
  it.each(["exec", "eval", "script", "shell", "httpRequest"])(
    "rejects %s actions",
    async (kind) => {
      const w = await fixtureWorkflow();
      expect(() =>
        parseWorkflow({
          ...w,
          steps: [{ id: "s1", kind, timeoutMs: 1000, code: "process.exit()" }],
        }),
      ).toThrow();
    },
  );
  it.each(["2.0.0", "0.1.0", "1.2.0"])(
    "fails closed on unsupported format %s",
    async (schemaVersion) => {
      const w = await fixtureWorkflow();
      expect(() => parseWorkflow({ ...w, schemaVersion })).toThrow(
        "WORKFLOW_SCHEMA_UNSUPPORTED",
      );
    },
  );
  it("fails closed on non-string schemaVersion and unserializable workflows", async () => {
    const w = await fixtureWorkflow();
    expect(() => parseWorkflow({ ...w, schemaVersion: ["1.0.0"] })).toThrow(
      "WORKFLOW_SCHEMA_UNSUPPORTED",
    );
    const circular: Record<string, unknown> = { ...w };
    circular.self = circular;
    expect(() => parseWorkflow(circular)).toThrowError(
      expect.objectContaining({ code: "WORKFLOW_INVALID" }),
    );
  });
  it("rejects unknown properties and locator syntax", async () => {
    const w = await fixtureWorkflow();
    expect(() => parseWorkflow({ ...w, script: "alert(1)" })).toThrow();
    expect(() =>
      parseWorkflow({
        ...w,
        steps: [
          {
            id: "s1",
            kind: "click",
            locator: { strategy: "css", value: "body >> script" },
            timeoutMs: 1000,
          },
        ],
      }),
    ).toThrow();
    expect(() => parseWorkflow({ ...w, slug: "constructor" })).toThrow();
  });
  it("rejects URL credentials, query, fragments, unknown schemes and unapproved origins", async () => {
    const w = await fixtureWorkflow();
    for (const entrypoint of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "http://user:pass@127.0.0.1:4173",
      "http://127.0.0.1:4173/?token=x",
      "http://127.0.0.1:4173/#secret",
      "https://unapproved.example",
    ])
      expect(() => parseWorkflow({ ...w, entrypoint })).toThrow();
  });
  it("validates types, missing args, bounds and unknown args before execution", async () => {
    const w = await fixtureWorkflow();
    for (const args of [
      {},
      { ticket_id: 1 },
      { ticket_id: "a", approved: true },
      { ticket_id: "x".repeat(5000) },
      { __proto__: { admin: true } },
    ])
      expect(() => validateContract(w.inputSchema, args)).toThrow();
    expect(
      validateContract(w.inputSchema, {
        ticket_id: 'x\" ] $(touch /tmp/never)',
      }),
    ).toEqual({ ticket_id: 'x\" ] $(touch /tmp/never)' });
  });
  it("fuzzes unknown fields without accepting executable content", async () => {
    const w = await fixtureWorkflow();
    for (let i = 0; i < 150; i++)
      expect(() =>
        parseWorkflow({ ...w, [`untrusted_${i}`]: { exec: `payload-${i}` } }),
      ).toThrow();
  });
});
describe("workflow format 1.1.0", () => {
  const valid110 = async () => {
    const base = await fixtureWorkflow();
    return {
      ...base,
      schemaVersion: "1.1.0" as const,
      version: "1.1.0",
      inputSchema: {
        type: "object" as const,
        properties: {
          ticket_id: { type: "string" as const, minLength: 1, maxLength: 40 },
          include_note: { type: "boolean" as const },
          note: { type: "string" as const, maxLength: 100 },
        },
        required: ["ticket_id", "include_note"],
        additionalProperties: false as const,
      },
      outputSchema: {
        type: "object" as const,
        properties: {
          raw_badge: { type: "string" as const },
          clean_badge: { type: "string" as const },
          digits: { type: "string" as const },
          order_num: { type: "integer" as const },
          price_num: { type: "number" as const },
          flag: { type: "boolean" as const },
          flag_text: { type: "string" as const },
          lower_badge: { type: "string" as const },
          upper_badge: { type: "string" as const },
        },
        required: [
          "raw_badge",
          "clean_badge",
          "digits",
          "order_num",
          "price_num",
          "flag",
          "flag_text",
          "lower_badge",
          "upper_badge",
        ],
        additionalProperties: false as const,
      },
      steps: [
        {
          id: "s1",
          kind: "navigate" as const,
          url: base.entrypoint,
          timeoutMs: 5000,
        },
        {
          id: "s2",
          kind: "fill" as const,
          when: {
            source: { source: "input" as const, field: "include_note" },
            operator: "isTrue" as const,
          },
          locator: {
            strategy: "within" as const,
            scopes: [
              { strategy: "role" as const, role: "main" as const, name: "CRM" },
              {
                strategy: "role" as const,
                role: "group" as const,
                name: "Queues",
              },
              {
                strategy: "role" as const,
                role: "region" as const,
                name: "Primary",
              },
              {
                strategy: "role" as const,
                role: "row" as const,
                name: "Ticket 1",
              },
            ],
            target: { strategy: "label" as const, value: "Note" },
          },
          value: { param: "note" },
          timeoutMs: 5000,
        },
        {
          id: "s3",
          kind: "waitForState" as const,
          locator: { strategy: "testId" as const, value: "loading-banner" },
          state: "detached" as const,
          timeoutMs: 5000,
        },
        {
          id: "s4",
          kind: "assert" as const,
          locator: { strategy: "testId" as const, value: "loading-banner" },
          predicate: "visible" as const,
          expected: false,
          timeoutMs: 5000,
        },
        {
          id: "s5",
          kind: "extract" as const,
          locator: { strategy: "testId" as const, value: "row-badge" },
          field: "raw_badge",
          mode: "textContent" as const,
          allowMissing: false,
          timeoutMs: 5000,
        },
        {
          id: "s6",
          kind: "transform" as const,
          source: { source: "output" as const, field: "raw_badge" },
          operation: "trim" as const,
          field: "clean_badge",
          timeoutMs: 1000,
        },
        {
          id: "s7",
          kind: "transform" as const,
          source: { source: "output" as const, field: "clean_badge" },
          operation: "lowercase" as const,
          field: "lower_badge",
          timeoutMs: 1000,
        },
        {
          id: "s8",
          kind: "transform" as const,
          source: { source: "output" as const, field: "clean_badge" },
          operation: "uppercase" as const,
          field: "upper_badge",
          timeoutMs: 1000,
        },
        {
          id: "s9",
          kind: "transform" as const,
          source: { source: "output" as const, field: "clean_badge" },
          operation: "digitsOnly" as const,
          field: "digits",
          timeoutMs: 1000,
        },
        {
          id: "s10",
          kind: "transform" as const,
          source: { source: "output" as const, field: "digits" },
          operation: "parseInteger" as const,
          field: "order_num",
          timeoutMs: 1000,
        },
        {
          id: "s11",
          kind: "transform" as const,
          source: { source: "output" as const, field: "digits" },
          operation: "parseNumber" as const,
          field: "price_num",
          timeoutMs: 1000,
        },
        {
          id: "s12",
          kind: "transform" as const,
          source: { source: "input" as const, field: "ticket_id" },
          operation: "parseBoolean" as const,
          field: "flag",
          timeoutMs: 1000,
        },
        {
          id: "s13",
          kind: "transform" as const,
          when: undefined,
          source: { source: "output" as const, field: "flag" },
          operation: "stringify" as const,
          field: "flag_text",
          timeoutMs: 1000,
        },
      ],
    };
  };
  it("parses valid 1.1.0 workflows with scoped locators, waits, conditions, and all transforms", async () => {
    const w = await valid110();
    const cleaned = JSON.parse(JSON.stringify(w));
    expect(parseWorkflow(cleaned)).toEqual(cleaned);
  });
  it("rejects 1.1.0 features in 1.0.0 workflows", async () => {
    const base = await fixtureWorkflow();
    for (const steps of [
      [
        {
          id: "s1",
          kind: "waitForState",
          locator: { strategy: "testId", value: "ticket-results" },
          state: "visible",
          timeoutMs: 1000,
        },
        ...base.steps.slice(1),
      ],
      [
        {
          id: "s1",
          kind: "click",
          locator: {
            strategy: "within",
            scopes: [{ strategy: "role", role: "region", name: "Main" }],
            target: { strategy: "role", role: "button", name: "Search" },
          },
          timeoutMs: 1000,
        },
        ...base.steps.slice(1),
      ],
      [
        {
          id: "s1",
          kind: "click",
          locator: { strategy: "role", role: "region", name: "Main" },
          timeoutMs: 1000,
        },
        ...base.steps.slice(1),
      ],
      [
        {
          ...base.steps[0],
          when: {
            source: { source: "input", field: "ticket_id" },
            operator: "isNotEmpty",
          },
        },
        ...base.steps.slice(1),
      ],
    ])
      expect(() =>
        parseWorkflow({
          ...base,
          schemaVersion: "1.0.0",
          steps,
        }),
      ).toThrowError(expect.objectContaining({ code: "WORKFLOW_INVALID" }));
    expect(() =>
      parseWorkflow({
        ...base,
        schemaVersion: "1.0.0",
        outputSchema: {
          ...base.outputSchema,
          properties: {
            ...base.outputSchema.properties,
            trimmed: { type: "string" },
          },
          required: [...base.outputSchema.required, "trimmed"],
        },
        steps: [
          ...base.steps,
          {
            id: "s8",
            kind: "transform",
            source: { source: "input", field: "ticket_id" },
            operation: "trim",
            field: "trimmed",
            timeoutMs: 1000,
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "WORKFLOW_INVALID" }));
  });
  it("rejects invalid scopes, forward/type-mismatched conditions & transforms, mismatched assertions, and invalid bounds", async () => {
    const w = JSON.parse(JSON.stringify(await valid110()));
    // Empty scopes & >4 scopes
    expect(() =>
      parseWorkflow({
        ...w,
        steps: [
          {
            ...w.steps[1],
            locator: {
              strategy: "within",
              scopes: [],
              target: { strategy: "label", value: "Note" },
            },
          },
          ...w.steps.slice(2),
        ],
      }),
    ).toThrow();
    expect(() =>
      parseWorkflow({
        ...w,
        steps: [
          {
            ...w.steps[1],
            locator: {
              strategy: "within",
              scopes: [
                ...w.steps[1].locator.scopes,
                { strategy: "role", role: "group", name: "Extra" },
              ],
              target: { strategy: "label", value: "Note" },
            },
          },
          ...w.steps.slice(2),
        ],
      }),
    ).toThrow();
    // Sensitive locator inside within on fill
    expect(() =>
      parseWorkflow({
        ...w,
        steps: [
          {
            ...w.steps[1],
            locator: {
              strategy: "within",
              scopes: [{ strategy: "role", role: "region", name: "Auth" }],
              target: { strategy: "label", value: "Password" },
            },
          },
          ...w.steps.slice(2),
        ],
      }),
    ).toThrow();
    // Forward reference in condition
    expect(() =>
      parseWorkflow({
        ...w,
        steps: [
          {
            ...w.steps[0],
            when: {
              source: { source: "output", field: "raw_badge" },
              operator: "isNotEmpty",
            },
          },
          ...w.steps.slice(1),
        ],
      }),
    ).toThrow();
    // Type-mismatched condition operator / value & secretLike condition value
    expect(() =>
      parseWorkflow({
        ...w,
        steps: [
          {
            ...w.steps[0],
            when: {
              source: { source: "input", field: "ticket_id" },
              operator: "isTrue",
            },
          },
          ...w.steps.slice(1),
        ],
      }),
    ).toThrow();
    expect(() =>
      parseWorkflow({
        ...w,
        steps: [
          {
            ...w.steps[0],
            when: {
              source: { source: "input", field: "include_note" },
              operator: "equals",
              value: "yes",
            },
          },
          ...w.steps.slice(1),
        ],
      }),
    ).toThrow();
    expect(() =>
      parseWorkflow({
        ...w,
        steps: [
          {
            ...w.steps[0],
            when: {
              source: { source: "input", field: "ticket_id" },
              operator: "equals",
              value: "ghp_abcdefghijklmnopqrstuvwxyz123456",
            },
          },
          ...w.steps.slice(1),
        ],
      }),
    ).toThrow();
    // String-only transform on non-string source
    expect(() =>
      parseWorkflow({
        ...w,
        outputSchema: {
          ...w.outputSchema,
          properties: {
            ...w.outputSchema.properties,
            bad_trim: { type: "string" },
          },
          required: [...w.outputSchema.required, "bad_trim"],
        },
        steps: [
          ...w.steps,
          {
            id: "s14",
            kind: "transform",
            source: { source: "input", field: "include_note" },
            operation: "trim",
            field: "bad_trim",
            timeoutMs: 1000,
          },
        ],
      }),
    ).toThrow();
    // Mismatched assert predicate/expected & secretLike expected
    expect(() =>
      parseWorkflow({
        ...w,
        steps: [
          {
            id: "s_assert",
            kind: "assert",
            locator: { strategy: "testId", value: "row-badge" },
            predicate: "visible",
            expected: "true",
            timeoutMs: 1000,
          },
          ...w.steps.slice(1),
        ],
      }),
    ).toThrow();
    expect(() =>
      parseWorkflow({
        ...w,
        steps: [
          {
            id: "s_assert",
            kind: "assert",
            locator: { strategy: "testId", value: "row-badge" },
            predicate: "textEquals",
            expected: "Bearer secret_token_value",
            timeoutMs: 1000,
          },
          ...w.steps.slice(1),
        ],
      }),
    ).toThrow();
    // Impossible property constraints
    expect(() =>
      parseWorkflow({
        ...w,
        inputSchema: {
          type: "object",
          properties: {
            ticket_id: { type: "string", minLength: 10, maxLength: 2 },
          },
          required: ["ticket_id"],
          additionalProperties: false,
        },
      }),
    ).toThrow();
    expect(() =>
      parseWorkflow({
        ...w,
        inputSchema: {
          type: "object",
          properties: {
            ticket_id: { type: "integer", minimum: 10, maximum: 5 },
          },
          required: ["ticket_id"],
          additionalProperties: false,
        },
      }),
    ).toThrow();
    expect(() =>
      parseWorkflow({
        ...w,
        inputSchema: {
          type: "object",
          properties: { ticket_id: { type: "integer", enum: ["1"] } },
          required: ["ticket_id"],
          additionalProperties: false,
        },
      }),
    ).toThrow();
  });
});
describe("privacy before persistence", () => {
  it("rejects imported token literals and literals targeting credential locators", async () => {
    const w = await fixtureWorkflow();
    const base = { id: "ssecret", kind: "fill", timeoutMs: 1000 };
    for (const step of [
      {
        ...base,
        locator: { strategy: "label", value: "Password" },
        value: "private-content",
      },
      {
        ...base,
        locator: { strategy: "label", value: "Ticket ID" },
        value: "ghp_abcdefghijklmnopqrstuvwxyz123456",
      },
    ])
      expect(() =>
        parseWorkflow({ ...w, steps: [step, ...w.steps] }),
      ).toThrow();
  });
  it.each([
    "password",
    "otp",
    "one-time-code",
    "api_token",
    "credit-card",
    "cvc",
    "session",
    "authorization",
  ])("does not capture %s", (identity) =>
    expect(sanitizeValue("private-content", identity, "text", true)).toBeNull(),
  );
  it("unknown fields default to private and secrets are filtered in approved fields", () => {
    expect(sanitizeValue("personal data", "custom", "text", false)).toBeNull();
    expect(
      sanitizeValue(
        "sk-abcdefghijklmnopqrstuvwxyz123456",
        "summary",
        "text",
        true,
      ),
    ).toBeNull();
    expect(sanitizeValue("TICKET-1001", "ticket_id", "text", true)).toBe(
      "TICKET-1001",
    );
    expect(secretLike("Bearer abcdefghi")).toBe(true);
  });
  it("rejects forged capture refs, tokens, and execution-only operations", () => {
    const base = {
      id: "s1",
      timeoutMs: 1000,
      locator: { strategy: "label", value: "Ticket ID" },
    };
    expect(
      safeCapturedStep({ ...base, kind: "fill", value: { secretRef: "x/y" } }),
    ).toBeNull();
    expect(
      safeCapturedStep({
        ...base,
        kind: "fill",
        value: "ghp_abcdefghijklmnopqrstuvwxyz123456",
      }),
    ).toBeNull();
    expect(
      safeCapturedStep({
        ...base,
        kind: "extract",
        field: "secret",
        mode: "textContent",
        allowMissing: true,
      }),
    ).toBeNull();
  });
});
