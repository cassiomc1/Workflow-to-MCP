import type { Page, Locator } from "playwright";
import type { LocatorSpec, Step } from "../../workflow-schema/src/index.js";
import { fail, WorkflowError } from "../../shared/src/index.js";
import { secretLike } from "../../recorder-core/src/index.js";
export function resolveLocator(page: Page, spec: LocatorSpec): Locator {
  switch (spec.strategy) {
    case "role":
      return page.getByRole(spec.role, { name: spec.name, exact: true });
    case "label":
      return page.getByLabel(spec.value, { exact: true });
    case "testId":
      return page.getByTestId(spec.value);
    case "placeholder":
      return page.getByPlaceholder(spec.value, { exact: true });
    case "id":
      return page.locator(`[id=${JSON.stringify(spec.value)}]`);
  }
}
async function unique(
  page: Page,
  spec: LocatorSpec,
  timeout: number,
  allowMissing = false,
) {
  const l = resolveLocator(page, spec);
  if ((await l.count()) > 1) fail("LOCATOR_AMBIGUOUS");
  if (!allowMissing)
    await l.waitFor({ state: "attached", timeout }).catch(async () => {
      if ((await l.count()) > 1) fail("LOCATOR_AMBIGUOUS");
      fail("LOCATOR_NOT_FOUND");
    });
  const count = await l.count();
  if (count > 1) fail("LOCATOR_AMBIGUOUS");
  if (!count && !allowMissing) fail("LOCATOR_NOT_FOUND");
  return { l, count };
}
type Inputs = Record<string, string | number | boolean | null>;
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
    const allowMissing = step.kind === "extract" && step.allowMissing;
    const { l, count } = await unique(
      page,
      step.locator,
      step.timeoutMs,
      allowMissing,
    );
    const options = { timeout: step.timeoutMs };
    switch (step.kind) {
      case "click":
        await l.click(options);
        break;
      case "fill":
        await l.fill(resolveValue(step.value, inputs), options);
        break;
      case "select":
        await l.selectOption(resolveValue(step.option, inputs), options);
        break;
      case "check":
        await l.setChecked(step.checked, options);
        break;
      case "press":
        await l.press(step.key, options);
        break;
      case "waitForVisible":
        await l.waitFor({ state: "visible", ...options });
        break;
      case "assert": {
        const actual =
          step.predicate === "visible"
            ? await l.isVisible()
            : (await l.textContent(options))?.trim();
        if (actual !== step.expected) fail("ASSERTION_FAILED");
        break;
      }
      case "extract": {
        let value: string | number | boolean | null;
        if (step.mode === "isVisible")
          value = count > 0 && (await l.isVisible());
        else if (step.mode === "count") value = count;
        else
          value = count
            ? ((await l.textContent(options))?.trim() ?? null)
            : null;
        if (typeof value === "string") {
          if (value.length > 4096)
            fail("OUTPUT_SCHEMA_INVALID", "Output exceeds bounded length.");
          if (secretLike(value)) value = "[REDACTED]";
          // Outputs are text data; prevent HTML markup being presented as active content.
          value = value.replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;"));
        }
        output[step.field] = value;
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
