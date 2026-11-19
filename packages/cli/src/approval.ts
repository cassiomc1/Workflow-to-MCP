import type { AuthProfile } from "../../auth/src/schema.js";
import { conditionMatches } from "../../compiler/src/index.js";
import {
  canonicalize,
  type Condition,
  type Step,
  type Workflow,
} from "../../workflow-schema/src/index.js";

export function terminalJson(value: unknown): string {
  return (JSON.stringify(value) ?? "undefined").replace(
    /[\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/gu,
    (character) => `\\u{${character.codePointAt(0)!.toString(16)}}`,
  );
}

export function terminalDisplay(value: string): string {
  return value.replace(
    /[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/gu,
    (character) => `\\u{${character.codePointAt(0)!.toString(16)}}`,
  );
}

export function conditionSummary(condition: Condition): string {
  const source = `${condition.source.source}.${condition.source.field}`;
  if (condition.operator === "equals" || condition.operator === "notEquals")
    return `${source} ${condition.operator} ${terminalJson(condition.value)}`;
  return `${source} ${condition.operator}`;
}

function previewParamValue(
  param: string,
  values: Record<string, unknown>,
  stepWillRun: boolean,
): string {
  const raw = values[param];
  if (raw === undefined || raw === null)
    return stepWillRun
      ? "<missing/null; execution will fail>"
      : "<omitted; step skipped>";
  return String(raw);
}

export function approvalSteps(workflow: Workflow, input: unknown): string[] {
  const values = (
    input && typeof input === "object" && !Array.isArray(input) ? input : {}
  ) as Record<string, unknown>;
  return workflow.steps.map((step: Step, index) => {
    const hasInputCondition =
      "when" in step && step.when && step.when.source.source === "input";
    const willRun = hasInputCondition
      ? conditionMatches(step.when!, values, {})
      : true;
    let action: string;
    if (step.kind === "navigate") action = `Navigate to ${step.url}`;
    else if (step.kind === "waitForURL")
      action = `Wait for URL ${step.urlPattern}`;
    else if (step.kind === "transform")
      action = `Derive ${step.field} with ${step.operation} from ${step.source.source}.${step.source.field}`;
    else if (step.kind === "extract")
      action = `Read ${step.mode} from ${canonicalize(step.locator)} into ${step.field}`;
    else if (step.kind === "waitForState")
      action = `Wait for ${step.state} on ${canonicalize(step.locator)}`;
    else if (step.kind === "waitForVisible")
      action = `Wait for visible ${canonicalize(step.locator)}`;
    else if (step.kind === "assert")
      action = `Assert ${step.predicate} on ${canonicalize(step.locator)} equals ${terminalJson(step.expected)}`;
    else if (step.kind === "click")
      action = `Click ${canonicalize(step.locator)}`;
    else if (step.kind === "fill") {
      const value =
        typeof step.value === "string"
          ? step.value
          : "param" in step.value
            ? previewParamValue(step.value.param, values, willRun)
            : "secret reference (not configured)";
      action = `Fill ${canonicalize(step.locator)} with ${terminalJson(value)}`;
    } else if (step.kind === "select") {
      const value =
        typeof step.option === "string"
          ? step.option
          : "param" in step.option
            ? previewParamValue(step.option.param, values, willRun)
            : "secret reference (not configured)";
      action = `Select ${terminalJson(value)} in ${canonicalize(step.locator)}`;
    } else if (step.kind === "check")
      action = `${step.checked ? "Check" : "Uncheck"} ${canonicalize(step.locator)}`;
    else action = `Press ${step.key} on ${canonicalize(step.locator)}`;
    if ("when" in step && step.when) {
      action += ` only when ${conditionSummary(step.when)}`;
      if (hasInputCondition)
        action += ` (${willRun ? "will run" : "will skip for these inputs"})`;
    }
    return `  ${index + 1}. ${terminalDisplay(action)}`;
  });
}

export function formatApprovalPrompt(options: {
  workflow: Workflow;
  hash: string;
  profile: AuthProfile | null;
  input: unknown;
}): string {
  const { workflow, hash, profile, input } = options;
  const steps = approvalSteps(workflow, input);
  return (
    [
      `LOCAL ${workflow.policy.risk === "write" ? "WRITE" : "WORKFLOW"} APPROVAL · ONE INVOCATION`,
      "Review every step and value. If the workflow writes, the site may not offer a way to undo it.",
      `Workflow: ${terminalDisplay(workflow.slug)} @ ${terminalDisplay(workflow.version)}`,
      `Risk: ${workflow.policy.risk.toUpperCase()}`,
      `SHA-256: ${hash}`,
      `Entry point: ${terminalDisplay(workflow.entrypoint)}`,
      `Allowed origins: ${workflow.policy.allowedOrigins.map(terminalDisplay).join(", ")}`,
      `Authentication: ${profile ? `${terminalDisplay(profile.config.id)} / ${profile.generation}` : "anonymous"}`,
      `Exact inputs: ${terminalJson(input)}`,
      `Planned steps (${steps.length}):`,
      ...steps,
      "Approval expires in 60 seconds and is bound to this workflow hash, exact inputs, local user, policy, and authentication profile.",
      "It is single-use. MCP callers cannot approve it. No automatic retry is performed after uncertain writes.",
      "",
    ].join("\n") + "\n"
  );
}
