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
export const contractSchema = z
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
export type Contract = z.infer<typeof contractSchema>;
export const locatorSchema = z.discriminatedUnion("strategy", [
  z.strictObject({
    strategy: z.literal("role"),
    role: z.enum([
      "button",
      "link",
      "textbox",
      "checkbox",
      "radio",
      "combobox",
      "heading",
    ]),
    name: text,
  }),
  z.strictObject({
    strategy: z.enum(["label", "testId", "placeholder", "id"]),
    value: text,
  }),
]);
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
export const stepSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...base, kind: z.literal("navigate"), url }),
  z.strictObject({ ...base, kind: z.literal("click"), locator: locatorSchema }),
  z.strictObject({
    ...base,
    kind: z.literal("fill"),
    locator: locatorSchema,
    value,
  }),
  z.strictObject({
    ...base,
    kind: z.literal("select"),
    locator: locatorSchema,
    option: value,
  }),
  z.strictObject({
    ...base,
    kind: z.literal("check"),
    locator: locatorSchema,
    checked: z.boolean(),
  }),
  z.strictObject({
    ...base,
    kind: z.literal("press"),
    locator: locatorSchema,
    key: z.enum(["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "Space"]),
  }),
  z.strictObject({
    ...base,
    kind: z.literal("waitForVisible"),
    locator: locatorSchema,
  }),
  z.strictObject({ ...base, kind: z.literal("waitForURL"), urlPattern: url }),
  z.strictObject({
    ...base,
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
]);
export type Step = z.infer<typeof stepSchema>;
export const workflowSchema = z
  .strictObject({
    schemaVersion: z.literal("1.0.0"),
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
    steps: z.array(stepSchema).min(1).max(100),
    policy: z.strictObject({
      risk: z.enum(["read", "write", "destructive", "unknown"]),
      allowedOrigins: z.array(originSchema).min(1).max(8),
      requiresApproval: z.boolean(),
      maxRuntimeMs: z.number().int().min(1000).max(120000),
      maxSteps: z.number().int().min(1).max(100),
    }),
  })
  .superRefine((w, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (
      w.steps.length > w.policy.maxSteps ||
      new Set(w.steps.map((s) => s.id)).size !== w.steps.length
    )
      issue("Invalid step count or IDs.");
    if (w.policy.risk !== "read" && !w.policy.requiresApproval)
      issue("Non-read workflows require approval.");
    if (!w.policy.allowedOrigins.includes(new URL(w.entrypoint).origin))
      issue("Entrypoint origin missing.");
    const outputs = new Set<string>();
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
        s.kind === "fill"
          ? s.value
          : s.kind === "select"
            ? s.option
            : undefined;
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
        issue(
          "Sensitive literal values are forbidden; use a secret reference.",
        );
      if (s.kind === "extract") {
        if (
          !Object.hasOwn(w.outputSchema.properties, s.field) ||
          outputs.has(s.field)
        )
          issue("Invalid output extraction.");
        outputs.add(s.field);
      }
    }
    if (w.outputSchema.required.some((k) => !outputs.has(k)))
      issue("Required output has no extraction.");
  });
export type Workflow = z.infer<typeof workflowSchema>;
export function parseWorkflow(input: unknown): Workflow {
  if (
    input &&
    typeof input === "object" &&
    "schemaVersion" in input &&
    input.schemaVersion !== "1.0.0"
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
// Version 1 is the only supported wire format. Unknown versions never receive implicit conversion.
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
