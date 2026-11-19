import { describe, it, expect } from "vitest";
import {
  approvalSteps,
  formatApprovalPrompt,
  terminalDisplay,
} from "../../packages/cli/src/approval.js";
import { parseWorkflow } from "../../packages/workflow-schema/src/index.js";

describe("local approval preview", () => {
  const workflow = parseWorkflow({
    schemaVersion: "1.1.0",
    id: "wf_approval_preview_test",
    slug: "approval_preview",
    version: "1.1.0",
    title: "Scoped approval preview",
    description: "Preview 1.1.0 steps safely.",
    provenance: {
      source: "fixture",
      recorderVersion: "0.1.0",
      createdAt: "2026-10-30T12:00:00Z",
    },
    entrypoint: "http://127.0.0.1:4173/scoped",
    inputSchema: {
      type: "object",
      properties: {
        add_note: { type: "boolean" },
        note: { type: "string", maxLength: 100 },
      },
      required: ["add_note"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        badge: { type: "string" },
        clean_badge: { type: "string" },
      },
      required: ["badge", "clean_badge"],
      additionalProperties: false,
    },
    steps: [
      {
        id: "s1",
        kind: "fill",
        when: {
          source: { source: "input", field: "add_note" },
          operator: "isTrue",
        },
        locator: {
          strategy: "within",
          scopes: [
            { strategy: "role", role: "region", name: "Primary\u202equeue" },
          ],
          target: { strategy: "label", value: "Note" },
        },
        value: { param: "note" },
        timeoutMs: 1000,
      },
      {
        id: "s2",
        kind: "fill",
        locator: { strategy: "label", value: "Reference" },
        value: { secretRef: "demo/ref" },
        timeoutMs: 1000,
      },
      {
        id: "s3",
        kind: "waitForState",
        locator: { strategy: "testId", value: "loading-banner" },
        state: "detached",
        timeoutMs: 1000,
      },
      {
        id: "s4",
        kind: "extract",
        locator: { strategy: "testId", value: "row-badge" },
        field: "badge",
        mode: "textContent",
        allowMissing: false,
        timeoutMs: 1000,
      },
      {
        id: "s5",
        kind: "transform",
        source: { source: "output", field: "badge" },
        operation: "trim",
        field: "clean_badge",
        timeoutMs: 1000,
      },
    ],
    policy: {
      risk: "write",
      allowedOrigins: ["http://127.0.0.1:4173"],
      requiresApproval: true,
      maxRuntimeMs: 30000,
      maxSteps: 10,
    },
  });

  it("shows whether conditional steps will run or skip and handles omitted optional parameters", () => {
    const skipped = approvalSteps(workflow, { add_note: false });
    expect(skipped[0]).toContain("<omitted; step skipped>");
    expect(skipped[0]).toContain("will skip for these inputs");
    expect(skipped[1]).toContain("secret reference (not configured)");
    expect(skipped[2]).toContain("Wait for detached");
    expect(skipped[4]).toContain(
      "Derive clean_badge with trim from output.badge",
    );

    const running = approvalSteps(workflow, { add_note: true });
    expect(running[0]).toContain("<missing/null; execution will fail>");
    expect(running[0]).toContain("will run");
  });

  it("escapes control, BiDi, and line-separator characters in prompts and inputs", () => {
    const prompt = formatApprovalPrompt({
      workflow,
      hash: "a".repeat(64),
      profile: null,
      input: {
        add_note: true,
        note: "hello\u007f\u202ereversed\u2028newline",
      },
    });
    expect(prompt).not.toMatch(/[\u007f\u202e\u2028]/);
    expect(prompt).toContain("\\u{7f}");
    expect(prompt).toContain("\\u{202e}");
    expect(prompt).toContain("\\u{2028}");
    expect(prompt).toContain("Authentication: anonymous");
    expect(terminalDisplay("abc\u001b[2J")).toBe("abc\\u{1b}[2J");
  });
});
