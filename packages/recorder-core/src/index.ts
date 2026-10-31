import {
  legacyLocatorSchema,
  legacyStepSchema,
  type BaseLocatorSpec,
  type LegacyStep,
} from "../../workflow-schema/src/index.js";
import { sensitiveName, secretLike } from "../../shared/src/privacy.js";
export { sensitiveName, secretLike } from "../../shared/src/privacy.js";
export function sanitizeValue(
  value: string,
  identity: string,
  type: string,
  explicitlySafe: boolean,
): string | null {
  if (
    !explicitlySafe ||
    ["password", "hidden", "file"].includes(type) ||
    sensitiveName.test(identity) ||
    secretLike(value) ||
    value.length > 4096
  )
    return null;
  return value;
}
export function locatorFor(element: Element): BaseLocatorSpec | null {
  const id = element.getAttribute("data-testid");
  const tag = element.tagName.toLowerCase();
  const role =
    element.getAttribute("role") ??
    (
      { button: "button", a: "link", select: "combobox" } as Record<
        string,
        string
      >
    )[tag];
  const accessibleName =
    element.getAttribute("aria-label") || element.textContent?.trim();
  if (
    role &&
    [
      "button",
      "link",
      "textbox",
      "checkbox",
      "radio",
      "combobox",
      "heading",
    ].includes(role) &&
    accessibleName &&
    accessibleName.length < 100 &&
    !secretLike(accessibleName) &&
    !sensitiveName.test(accessibleName)
  ) {
    const parsed = legacyLocatorSchema.safeParse({
      strategy: "role",
      role,
      name: accessibleName,
    });
    if (parsed.success) return parsed.data;
  }
  const field = element as HTMLInputElement;
  const label =
    field.labels?.length === 1
      ? field.labels[0]?.textContent?.trim()
      : undefined;
  if (
    label &&
    label.length < 100 &&
    !secretLike(label) &&
    !sensitiveName.test(label)
  )
    return { strategy: "label", value: label };
  if (id && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id) && !sensitiveName.test(id))
    return { strategy: "testId", value: id };
  if (
    element.id &&
    /^[a-zA-Z][a-zA-Z_-]{0,63}$/.test(element.id) &&
    !sensitiveName.test(element.id)
  )
    return { strategy: "id", value: element.id };
  return null;
}
export function safeCapturedStep(input: unknown): LegacyStep | null {
  const result = legacyStepSchema.safeParse(input);
  if (!result.success) return null;
  const s = result.data;
  // Capture messages cannot insert execution-only features or parameter/secret references.
  if (
    !["navigate", "click", "fill", "select", "check", "press"].includes(s.kind)
  )
    return null;
  const v =
    s.kind === "fill" ? s.value : s.kind === "select" ? s.option : undefined;
  if (v !== undefined && (typeof v !== "string" || secretLike(v))) return null;
  if (
    "locator" in s &&
    (secretLike(JSON.stringify(s.locator)) ||
      sensitiveName.test(JSON.stringify(s.locator)))
  )
    return null;
  return s;
}
