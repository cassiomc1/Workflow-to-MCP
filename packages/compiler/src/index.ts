import type { Locator, Page } from "playwright";
import type {
  BaseLocatorSpec,
  Condition,
  LocatorSpec,
  Step,
} from "../../workflow-schema/src/index.js";
import { fail, WorkflowError } from "../../shared/src/index.js";
import { secretLike } from "../../recorder-core/src/index.js";

type LocatorRoot = Page | Locator;
type Inputs = Record<string, string | number | boolean | null>;
function resolveBaseLocator(root: LocatorRoot, spec: BaseLocatorSpec): Locator {
  switch (spec.strategy) {
    case "role":
      return root.getByRole(spec.role, { name: spec.name, exact: true });
    case "label":
      return root.getByLabel(spec.value, { exact: true });
    case "testId":
      return root.getByTestId(spec.value);
    case "placeholder":
      return root.getByPlaceholder(spec.value, { exact: true });
    case "id":
      return root.locator(`[id=${JSON.stringify(spec.value)}]`);
  }
}
export function resolveLocator(page: Page, spec: LocatorSpec): Locator {
  if (spec.strategy !== "within") return resolveBaseLocator(page, spec);
  let root: LocatorRoot = page;
  for (const scope of spec.scopes) root = resolveBaseLocator(root, scope);
  return resolveBaseLocator(root, spec.target);
}

export async function resolveUniqueLocator(
  page: Page,
  spec: LocatorSpec,
  timeout: number,
  allowMissing = false,
) {
  const started = Date.now();
  const remaining = () => Math.max(1, timeout - (Date.now() - started));
  let root: LocatorRoot = page;
  const scopes = spec.strategy === "within" ? spec.scopes : [];
  for (const scope of scopes) {
    const locator = resolveBaseLocator(root, scope);
    let count = await locator.count();
    if (count > 1) fail("LOCATOR_AMBIGUOUS");
    if (!count) {
      if (allowMissing) return { l: undefined, count: 0 };
      await locator
        .waitFor({ state: "attached", timeout: remaining() })
        .catch(async () => {
          if ((await locator.count()) > 1) fail("LOCATOR_AMBIGUOUS");
          fail("LOCATOR_NOT_FOUND");
        });
      count = await locator.count();
      if (count > 1) fail("LOCATOR_AMBIGUOUS");
      if (!count) fail("LOCATOR_NOT_FOUND");
    }
    root = locator;
  }

  const target =
    spec.strategy === "within"
      ? resolveBaseLocator(root, spec.target)
      : resolveBaseLocator(root, spec);
  let count = await target.count();
  if (count > 1) fail("LOCATOR_AMBIGUOUS");
  if (!count && !allowMissing) {
    await target
      .waitFor({ state: "attached", timeout: remaining() })
      .catch(async () => {
        if ((await target.count()) > 1) fail("LOCATOR_AMBIGUOUS");
        fail("LOCATOR_NOT_FOUND");
      });
    count = await target.count();
  }
  if (count > 1) fail("LOCATOR_AMBIGUOUS");
  if (!count && !allowMissing) fail("LOCATOR_NOT_FOUND");
  return { l: target, count };
}

function conditionMatches(
  condition: Condition,
  inputs: Inputs,
  output: Inputs,
): boolean {
  const values = condition.source.source === "input" ? inputs : output,
    actual = values[condition.source.field];
  switch (condition.operator) {
    case "equals":
      return actual === condition.value;
    case "notEquals":
      return actual !== condition.value;
    case "isTrue":
      return actual === true;
    case "isFalse":
      return actual === false;
    case "isEmpty":
      return actual === undefined || actual === null || actual === "";
    case "isNotEmpty":
      return typeof actual === "string" && actual.length > 0;
  }
}

function transform(
  operation: Extract<Step, { kind: "transform" }>["operation"],
  source: string | number | boolean | null | undefined,
): string | number | boolean {
  if (operation === "stringify") {
    if (source === undefined) fail("TRANSFORM_INPUT_INVALID");
    return String(source);
  }
  if (source === null || source === undefined || typeof source !== "string")
    fail("TRANSFORM_INPUT_INVALID");
  switch (operation) {
    case "trim":
      return source.trim();
    case "lowercase":
      return source.toLowerCase();
    case "uppercase":
      return source.toUpperCase();
    case "digitsOnly":
      return source.replace(/\D/g, "");
    case "parseInteger": {
      if (!/^[+-]?\d+$/.test(source)) fail("TRANSFORM_INPUT_INVALID");
      const value = Number(source);
      if (!Number.isSafeInteger(value)) fail("TRANSFORM_INPUT_INVALID");
      return value;
    }
    case "parseNumber": {
      if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(source))
        fail("TRANSFORM_INPUT_INVALID");
      const value = Number(source);
      if (!Number.isFinite(value)) fail("TRANSFORM_INPUT_INVALID");
      return value;
    }
    case "parseBoolean": {
      const value = source.trim().toLowerCase();
      if (value === "true") return true;
      if (value === "false") return false;
      fail("TRANSFORM_INPUT_INVALID");
    }
  }
}

function resolveValue(
  value: string | { param: string } | { secretRef: string },
  inputs: Inputs,
): string {
  if (typeof value === "string") return value;
  if ("secretRef" in value)
    fail(
      "SECRET_NOT_CONFIGURED",
      "Secret storage is not enabled in this release.",
    );
  const v = inputs[value.param];
  if (v === undefined || v === null) fail("PARAMETER_INVALID");
  return String(v);
}

export async function executeStep(
  page: Page,
  step: Step,
  inputs: Inputs,
  output: Inputs,
) {
  try {
    if (
      "when" in step &&
      step.when &&
      !conditionMatches(step.when, inputs, output)
    )
      return;
    if (step.kind === "transform") {
      const values = step.source.source === "input" ? inputs : output,
        result = transform(step.operation, values[step.source.field]);
      if (typeof result === "string" && result.length > 4096)
        fail("OUTPUT_SCHEMA_INVALID", "Output exceeds bounded length.");
      output[step.field] =
        typeof result === "string" && secretLike(result)
          ? "[REDACTED]"
          : result;
      return;
    }
    if (step.kind === "navigate") {
      const response = await page.goto(step.url, {
        timeout: step.timeoutMs,
        waitUntil: "domcontentloaded",
      });
      if (response && response.status() >= 400)
        fail(
          "NAVIGATION_FAILED",
          "The approved site returned an unsuccessful HTTP status.",
        );
      return;
    }
    if (step.kind === "waitForURL") {
      await page.waitForURL((url) => url.href === step.urlPattern, {
        timeout: step.timeoutMs,
      });
      return;
    }
    const allowMissing = step.kind === "extract" && step.allowMissing,
      waitingForAbsence =
        step.kind === "waitForState" &&
        (step.state === "hidden" || step.state === "detached"),
      { l, count: initialCount } = await resolveUniqueLocator(
        page,
        step.locator,
        step.timeoutMs,
        allowMissing || waitingForAbsence,
      ),
      options = { timeout: step.timeoutMs };
    if (step.kind === "waitForState") {
      if (!l) return;
      await l.waitFor({ state: step.state, ...options });
      if ((await l.count()) > 1) fail("LOCATOR_AMBIGUOUS");
      return;
    }
    if (!l && step.kind !== "extract") fail("LOCATOR_NOT_FOUND");
    const target = l!;
    let count = initialCount;
    if (
      target &&
      (step.kind === "assert" ||
        step.kind === "extract" ||
        step.kind === "waitForVisible")
    ) {
      count = await target.count();
      if (count > 1) fail("LOCATOR_AMBIGUOUS");
    }
    switch (step.kind) {
      case "click":
        await target.click(options);
        break;
      case "fill":
        await target.fill(resolveValue(step.value, inputs), options);
        break;
      case "select":
        await target.selectOption(resolveValue(step.option, inputs), options);
        break;
      case "check":
        await target.setChecked(step.checked, options);
        break;
      case "press":
        await target.press(step.key, options);
        break;
      case "waitForVisible":
        await target.waitFor({ state: "visible", ...options });
        break;
      case "assert": {
        const actual =
          step.predicate === "visible"
            ? await target.isVisible()
            : (await target.textContent(options))?.trim();
        if (actual !== step.expected) fail("ASSERTION_FAILED");
        break;
      }
      case "extract": {
        let value: string | number | boolean | null;
        if (step.mode === "isVisible")
          value = count > 0 && (await target.isVisible());
        else if (step.mode === "count") value = count;
        else
          value = count
            ? ((await target.textContent(options))?.trim() ?? null)
            : null;
        if (typeof value === "string") {
          if (value.length > 4096)
            fail("OUTPUT_SCHEMA_INVALID", "Output exceeds bounded length.");
          if (secretLike(value)) value = "[REDACTED]";
          // Keep text unchanged until the runner has removed known credentials.
        }
        output[step.field] = value;
        break;
      }
    }
  } catch (e) {
    if (e instanceof WorkflowError) {
      e.stepId = step.id;
      throw e;
    }
    throw new WorkflowError(
      "EXECUTION_TIMEOUT",
      "Step could not complete within its deadline.",
      step.id,
    );
  }
}
