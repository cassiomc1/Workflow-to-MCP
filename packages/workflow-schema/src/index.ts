import { z } from "zod";
import { sensitiveName, secretLike } from "../../shared/src/privacy.js";
import { fail } from "../../shared/src/index.js";

export const name = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,47}$/)
  .refine((v) => !["constructor", "prototype", "__proto__"].includes(v));
const text = z
  .string()
  .min(1)
  .max(256)
  .refine((v) => !/[\u0000-\u0008\u000b-\u001f]/.test(v));
const url = z
  .string()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return (
        ["http:", "https:"].includes(u.protocol) &&
        !u.username &&
        !u.password &&
        !u.hash &&
        !u.search
      );
    } catch {
      return false;
    }
  }, "Only HTTP(S) URLs without credentials, query strings, or fragments.");
export const originSchema = url.refine((v) => new URL(v).origin === v);
const property = z.strictObject({
  type: z.union([
    z.enum(["string", "integer", "number", "boolean"]),
    z.tuple([z.literal("string"), z.literal("null")]),
  ]),
  description: text.optional(),
  minLength: z.number().int().min(0).max(4096).optional(),
  maxLength: z.number().int().min(1).max(4096).optional(),
  minimum: z.number().finite().optional(),
  maximum: z.number().finite().optional(),
  enum: z.array(z.string().max(256)).min(1).max(40).optional(),
});
const contractSchemaInternal = z
  .strictObject({
    type: z.literal("object"),
    properties: z.record(name, property),
    required: z.array(name).max(30),
    additionalProperties: z.literal(false),
  })
  .superRefine((s, ctx) => {
    if (
      Object.keys(s.properties).length > 30 ||
      new Set(s.required).size !== s.required.length ||
      s.required.some((k) => !Object.hasOwn(s.properties, k))
    )
      ctx.addIssue({ code: "custom", message: "Invalid contract properties." });
  });
export const contractSchema = contractSchemaInternal;
export type Contract = z.infer<typeof contractSchema>;

const legacyRole = z.enum([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "heading",
]);
const role = z.enum([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "heading",
  "region",
  "row",
  "list",
  "listitem",
  "group",
  "cell",
  "form",
  "main",
  "table",
  "navigation",
]);
export type LocatorRole = z.infer<typeof role>;
const legacyLocatorVariants = [
  z.strictObject({
    strategy: z.literal("role"),
    role: legacyRole,
    name: text,
  }),
  z.strictObject({
    strategy: z.enum(["label", "testId", "placeholder", "id"]),
    value: text,
  }),
] as const;
export const legacyLocatorSchema = z.discriminatedUnion(
  "strategy",
  legacyLocatorVariants,
);
const baseLocatorVariants = [
  z.strictObject({
    strategy: z.literal("role"),
    role,
    name: text,
  }),
  z.strictObject({
    strategy: z.enum(["label", "testId", "placeholder", "id"]),
    value: text,
  }),
] as const;
export const baseLocatorSchema = z.discriminatedUnion(
  "strategy",
  baseLocatorVariants,
);
const scopedLocatorVariant = z.strictObject({
  strategy: z.literal("within"),
  scopes: z.array(baseLocatorSchema).min(1).max(4),
  target: baseLocatorSchema,
});
export const locatorSchema = z.discriminatedUnion("strategy", [
  ...baseLocatorVariants,
  scopedLocatorVariant,
]);
export type BaseLocatorSpec = z.infer<typeof baseLocatorSchema>;
export type LocatorSpec = z.infer<typeof locatorSchema>;

const value = z.union([
  z.string().max(4096),
  z.strictObject({ param: name }),
  z.strictObject({
    secretRef: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,30}\/[a-z][a-z0-9_-]{0,30}$/),
  }),
]);
const base = {
  id: z.string().regex(/^s[a-zA-Z0-9_-]{1,63}$/),
  timeoutMs: z.number().int().min(100).max(30000),
};
const legacyBase = {
  ...base,
};
export const legacyStepSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...legacyBase, kind: z.literal("navigate"), url }),
  z.strictObject({
    ...legacyBase,
    kind: z.literal("click"),
    locator: legacyLocatorSchema,
  }),
  z.strictObject({
    ...legacyBase,
    kind: z.literal("fill"),
    locator: legacyLocatorSchema,
    value,
  }),
  z.strictObject({
    ...legacyBase,
    kind: z.literal("select"),
    locator: legacyLocatorSchema,
    option: value,
  }),
  z.strictObject({
    ...legacyBase,
    kind: z.literal("check"),
    locator: legacyLocatorSchema,
    checked: z.boolean(),
  }),
  z.strictObject({
    ...legacyBase,
    kind: z.literal("press"),
    locator: legacyLocatorSchema,
    key: z.enum(["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "Space"]),
  }),
  z.strictObject({
    ...legacyBase,
    kind: z.literal("waitForVisible"),
    locator: legacyLocatorSchema,
  }),
  z.strictObject({
    ...legacyBase,
    kind: z.literal("waitForURL"),
    urlPattern: url,
  }),
  z.strictObject({
    ...legacyBase,
    kind: z.literal("assert"),
    locator: legacyLocatorSchema,
    predicate: z.enum(["visible", "textEquals"]),
    expected: z.union([z.string().max(4096), z.boolean()]),
  }),
  z.strictObject({
    ...legacyBase,
    kind: z.literal("extract"),
    locator: legacyLocatorSchema,
    field: name,
    mode: z.enum(["textContent", "isVisible", "count"]),
    allowMissing: z.boolean(),
  }),
]);
export type LegacyStep = z.infer<typeof legacyStepSchema>;

const referenceSchema = z.discriminatedUnion("source", [
  z.strictObject({ source: z.literal("input"), field: name }),
  z.strictObject({ source: z.literal("output"), field: name }),
]);
const scalar = z.union([
  z.string().max(4096),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const conditionSchema = z.discriminatedUnion("operator", [
  z.strictObject({
    source: referenceSchema,
    operator: z.enum(["equals", "notEquals"]),
    value: scalar,
  }),
  z.strictObject({
    source: referenceSchema,
    operator: z.enum(["isTrue", "isFalse", "isEmpty", "isNotEmpty"]),
  }),
]);
export type Condition = z.infer<typeof conditionSchema>;
const conditional = { ...base, when: conditionSchema.optional() };
const newStepSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...conditional, kind: z.literal("navigate"), url }),
  z.strictObject({
    ...conditional,
    kind: z.literal("click"),
    locator: locatorSchema,
  }),
  z.strictObject({
    ...conditional,
    kind: z.literal("fill"),
    locator: locatorSchema,
    value,
  }),
  z.strictObject({
    ...conditional,
    kind: z.literal("select"),
    locator: locatorSchema,
    option: value,
  }),
  z.strictObject({
    ...conditional,
    kind: z.literal("check"),
    locator: locatorSchema,
    checked: z.boolean(),
  }),
  z.strictObject({
    ...conditional,
    kind: z.literal("press"),
    locator: locatorSchema,
    key: z.enum(["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "Space"]),
  }),
  z.strictObject({
    ...conditional,
    kind: z.literal("waitForVisible"),
    locator: locatorSchema,
  }),
  z.strictObject({
    ...conditional,
    kind: z.literal("waitForState"),
    locator: locatorSchema,
    state: z.enum(["visible", "hidden", "attached", "detached"]),
  }),
  z.strictObject({
    ...conditional,
    kind: z.literal("waitForURL"),
    urlPattern: url,
  }),
  z.strictObject({
    ...conditional,
    kind: z.literal("assert"),
    locator: locatorSchema,
    predicate: z.enum(["visible", "textEquals"]),
    expected: z.union([z.string().max(4096), z.boolean()]),
  }),
  z.strictObject({
    ...base,
    kind: z.literal("extract"),
    locator: locatorSchema,
    field: name,
    mode: z.enum(["textContent", "isVisible", "count"]),
    allowMissing: z.boolean(),
  }),
  z.strictObject({
    ...base,
    kind: z.literal("transform"),
    source: referenceSchema,
    operation: z.enum([
      "trim",
      "lowercase",
      "uppercase",
      "digitsOnly",
      "parseInteger",
      "parseNumber",
      "parseBoolean",
      "stringify",
    ]),
    field: name,
  }),
]);
export type AdvancedStep = z.infer<typeof newStepSchema>;
export type Step = LegacyStep | AdvancedStep;
export const stepSchema = z.union([legacyStepSchema, newStepSchema]);

const workflowFields = {
  id: z.string().regex(/^wf_[a-z0-9_]{1,64}$/),
  slug: name,
  version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
  title: text,
  description: z.string().min(1).max(500),
  provenance: z.strictObject({
    source: z.enum(["user-recorded", "fixture"]),
    recorderVersion: z.literal("0.1.0"),
    createdAt: z.iso.datetime(),
  }),
  entrypoint: url,
  inputSchema: contractSchema,
  outputSchema: contractSchema,
  policy: z.strictObject({
    risk: z.enum(["read", "write", "destructive", "unknown"]),
    allowedOrigins: z.array(originSchema).min(1).max(8),
    requiresApproval: z.boolean(),
    maxRuntimeMs: z.number().int().min(1000).max(120000),
    maxSteps: z.number().int().min(1).max(100),
  }),
};
type ValueType = "string" | "nullableString" | "integer" | "number" | "boolean";
type WorkflowShape = {
  entrypoint: string;
  inputSchema: Contract;
  outputSchema: Contract;
  steps: Step[];
  policy: {
    risk: "read" | "write" | "destructive" | "unknown";
    allowedOrigins: string[];
    requiresApproval: boolean;
    maxRuntimeMs: number;
    maxSteps: number;
  };
};

function contractType(
  contract: Contract,
  field: string,
): ValueType | undefined {
  const type = contract.properties[field]?.type;
  if (!type) return undefined;
  if (Array.isArray(type)) return "nullableString";
  return type;
}
function sourceType(
  source: { source: "input" | "output"; field: string },
  inputs: Contract,
  outputs: Map<string, ValueType>,
): ValueType | undefined {
  return source.source === "input"
    ? contractType(inputs, source.field)
    : outputs.get(source.field);
}
function transformType(operation: string): ValueType {
  if (
    ["trim", "lowercase", "uppercase", "digitsOnly", "stringify"].includes(
      operation,
    )
  )
    return "string";
  if (operation === "parseInteger") return "integer";
  if (operation === "parseNumber") return "number";
  return "boolean";
}
function outputAccepts(actual: ValueType, declared: ValueType): boolean {
  return (
    actual === declared ||
    (actual === "integer" && declared === "number") ||
    (actual === "string" && declared === "nullableString")
  );
}
function isTypedValue(value: unknown, type: ValueType): boolean {
  if (type === "nullableString")
    return value === null || typeof value === "string";
  if (type === "integer")
    return typeof value === "number" && Number.isSafeInteger(value);
  if (type === "number")
    return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function refineWorkflow(w: WorkflowShape, ctx: z.RefinementCtx) {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  if (
    w.steps.length > w.policy.maxSteps ||
    new Set(w.steps.map((s) => s.id)).size !== w.steps.length
  )
    issue("Invalid step count or IDs.");
  if (w.policy.risk !== "read" && !w.policy.requiresApproval)
    issue("Non-read workflows require approval.");
  if (!w.policy.allowedOrigins.includes(new URL(w.entrypoint).origin))
    issue("Entrypoint origin missing.");

  const outputs = new Map<string, ValueType>();
  for (const s of w.steps) {
    const u =
      s.kind === "navigate"
        ? s.url
        : s.kind === "waitForURL"
          ? s.urlPattern
          : undefined;
    if (u && !w.policy.allowedOrigins.includes(new URL(u).origin))
      issue("Step origin not allowed.");
    const v =
      s.kind === "fill" ? s.value : s.kind === "select" ? s.option : undefined;
    if (
      v &&
      typeof v === "object" &&
      "param" in v &&
      !Object.hasOwn(w.inputSchema.properties, v.param)
    )
      issue("Undeclared parameter.");
    if (
      typeof v === "string" &&
      (secretLike(v) ||
        ("locator" in s && sensitiveName.test(JSON.stringify(s.locator))))
    )
      issue("Sensitive literal values are forbidden; use a secret reference.");
    if (
      (s.kind === "fill" || s.kind === "select") &&
      sensitiveName.test(JSON.stringify(s.locator))
    )
      issue("Sensitive locator names are forbidden.");

    if ("when" in s && s.when) {
      const type = sourceType(s.when.source, w.inputSchema, outputs);
      if (!type)
        issue("Condition source must be declared and available earlier.");
      else if (
        s.when.operator === "equals" ||
        s.when.operator === "notEquals"
      ) {
        if (!isTypedValue(s.when.value, type))
          issue("Condition value must match its source type.");
        if (typeof s.when.value === "string" && secretLike(s.when.value))
          issue("Sensitive condition values are forbidden.");
      } else if (
        (["isTrue", "isFalse"].includes(s.when.operator) &&
          type !== "boolean") ||
        (["isEmpty", "isNotEmpty"].includes(s.when.operator) &&
          type !== "string" &&
          type !== "nullableString")
      )
        issue("Condition operator does not match its source type.");
    }

    if (s.kind === "extract") {
      const fieldType: ValueType =
        s.mode === "textContent"
          ? s.allowMissing
            ? "nullableString"
            : "string"
          : s.mode === "isVisible"
            ? "boolean"
            : "integer";
      const declared = contractType(w.outputSchema, s.field);
      if (
        !declared ||
        outputs.has(s.field) ||
        !outputAccepts(fieldType, declared)
      )
        issue("Invalid or duplicate output extraction.");
      outputs.set(s.field, fieldType);
    }
    if (s.kind === "transform") {
      const source = sourceType(s.source, w.inputSchema, outputs),
        result = transformType(s.operation),
        declared = contractType(w.outputSchema, s.field);
      if (!source)
        issue("Transform source must be declared and available earlier.");
      if (
        [
          "trim",
          "lowercase",
          "uppercase",
          "digitsOnly",
          "parseInteger",
          "parseNumber",
          "parseBoolean",
        ].includes(s.operation) &&
        source !== "string" &&
        source !== "nullableString"
      )
        issue("This transform operation requires a string source.");
      if (!declared || outputs.has(s.field) || !outputAccepts(result, declared))
        issue("Invalid or duplicate transform output.");
      outputs.set(s.field, result);
    }
  }
  if (w.outputSchema.required.some((k) => !outputs.has(k)))
    issue("Required output has no extraction or transform.");
}

const workflowV1Schema = z
  .strictObject({
    schemaVersion: z.literal("1.0.0"),
    ...workflowFields,
    steps: z.array(legacyStepSchema).min(1).max(100),
  })
  .superRefine(refineWorkflow);
const workflowV11Schema = z
  .strictObject({
    schemaVersion: z.literal("1.1.0"),
    ...workflowFields,
    steps: z.array(newStepSchema).min(1).max(100),
  })
  .superRefine(refineWorkflow);
export const workflowSchema = z.union([workflowV1Schema, workflowV11Schema]);
export type Workflow = z.infer<typeof workflowSchema>;
export function parseWorkflow(input: unknown): Workflow {
  if (
    input &&
    typeof input === "object" &&
    "schemaVersion" in input &&
    !["1.0.0", "1.1.0"].includes(String(input.schemaVersion))
  )
    fail("WORKFLOW_SCHEMA_UNSUPPORTED");
  if (JSON.stringify(input)?.length > 256000)
    fail("WORKFLOW_INVALID", "Workflow exceeds size limit.");
  const result = workflowSchema.safeParse(input);
  if (!result.success)
    fail(
      "WORKFLOW_INVALID",
      "Workflow violates the versioned schema. Check dist/workflow.schema.json.",
    );
  return result.data;
}
// Both supported wire formats are parsed without an implicit content rewrite.
export const migrateWorkflow = parseWorkflow;
export const workflowJsonSchema = z.toJSONSchema(workflowSchema, {
  target: "draft-2020-12",
});
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
export function validateContract(
  schema: Contract,
  input: unknown,
  code = "PARAMETER_INVALID",
): Record<string, string | number | boolean | null> {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(code);
  const values = input as Record<string, unknown>;
  if (
    Object.keys(values).some((k) => !Object.hasOwn(schema.properties, k)) ||
    schema.required.some((k) => !Object.hasOwn(values, k))
  )
    fail(code);
  for (const [key, v] of Object.entries(values)) {
    const p = schema.properties[key]!;
    if (Array.isArray(p.type)) {
      if (v !== null && typeof v !== "string") fail(code);
    } else if (
      p.type === "integer"
        ? typeof v !== "number" || !Number.isSafeInteger(v)
        : typeof v !== p.type
    )
      fail(code);
    if (
      typeof v === "string" &&
      (v.length > (p.maxLength ?? 4096) ||
        v.length < (p.minLength ?? 0) ||
        (p.enum && !p.enum.includes(v)) ||
        /[\u0000-\u0008\u000b-\u001f]/.test(v))
    )
      fail(code);
    if (
      typeof v === "number" &&
      (!Number.isFinite(v) ||
        v < (p.minimum ?? -1e12) ||
        v > (p.maximum ?? 1e12))
    )
      fail(code);
  }
  return values as Record<string, string | number | boolean | null>;
}
