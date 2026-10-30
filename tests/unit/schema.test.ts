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
  it.each(["2.0.0", "0.1.0", "1.1.0"])(
    "fails closed on unsupported format %s",
    async (schemaVersion) => {
      const w = await fixtureWorkflow();
      expect(() => parseWorkflow({ ...w, schemaVersion })).toThrow(
        "WORKFLOW_SCHEMA_UNSUPPORTED",
      );
    },
  );
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
