import {
  canonicalize,
  parseWorkflow,
  name,
  type BaseLocatorSpec,
  type Condition,
  type LocatorSpec,
  type LocatorRole,
  type Step,
  type Workflow,
  type Contract,
} from "../../../packages/workflow-schema/src/index.js";
import type { Session } from "./session.js";

type Parameter = {
  name: string;
  type: "string" | "integer" | "number" | "boolean";
};
type ScopeDraft = { role: string; name: string };
type ConditionDraft = { field: string; operator: string; value: string };
type TransformOperation =
  | "trim"
  | "lowercase"
  | "uppercase"
  | "digitsOnly"
  | "parseInteger"
  | "parseNumber"
  | "parseBoolean"
  | "stringify";
type TransformDraft = {
  id: string;
  sourceKind: "input" | "output";
  sourceField: string;
  operation: TransformOperation;
  field: string;
};
type OutputDraft = {
  step: Extract<Step, { kind: "extract" }>;
  row: HTMLDivElement;
  field: HTMLInputElement;
  mode: HTMLSelectElement;
  missing: HTMLInputElement;
  scopeRole: HTMLSelectElement;
  scopeName: HTMLInputElement;
};

let session: Session | null = null;
const steps: Step[] = [];
const parameters = new Map<string, Parameter>();
const scopes = new Map<string, ScopeDraft>();
const conditions = new Map<string, ConditionDraft>();
const transforms: TransformDraft[] = [];
const outputs: OutputDraft[] = [];
const outputActions = new Map<string, OutputDraft>();
const containerRoles = [
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
] as const;
let transformSequence = 0;
let reviewStepSequence = 0;
const $ = (id: string) => document.getElementById(id)!;
const input = (id: string) =>
  (document.getElementById(id) as HTMLInputElement).value.trim();

function button(label: string, fn: () => void) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.className = "secondary small";
  b.onclick = fn;
  return b;
}
function labeled(label: string, control: HTMLElement) {
  const wrapper = document.createElement("label");
  wrapper.append(label, control);
  return wrapper;
}
function createScopeControls(
  initial: ScopeDraft | undefined,
  onChange: (scope: ScopeDraft) => void,
) {
  const wrapper = document.createElement("div");
  wrapper.className = "scope-controls";
  const role = document.createElement("select"),
    nameField = document.createElement("input");
  role.setAttribute("aria-label", "Scope container role");
  role.add(new Option("No scope", ""));
  for (const item of containerRoles) role.add(new Option(item, item));
  role.value = initial?.role ?? "";
  nameField.placeholder = "Container accessible name";
  nameField.maxLength = 256;
  nameField.setAttribute("aria-label", "Scope container accessible name");
  nameField.value = initial?.name ?? "";
  const update = () =>
    onChange({ role: role.value, name: nameField.value.trim() });
  role.onchange = update;
  nameField.onchange = update;
  wrapper.append(labeled("Scope to a semantic container", role), nameField);
  return { wrapper, role, nameField };
}
function effectiveLocator(
  locator: LocatorSpec,
  scope: ScopeDraft | undefined,
): LocatorSpec {
  if (!scope?.name) return locator;
  if (!scope.role) throw new Error("Choose a container role for the scope.");
  const container: BaseLocatorSpec = {
    strategy: "role",
    role: scope.role as LocatorRole,
    name: scope.name,
  };
  if (locator.strategy === "within") {
    if (locator.scopes.length >= 4)
      throw new Error("A locator can have at most four scope levels.");
    return {
      strategy: "within",
      scopes: [container, ...locator.scopes],
      target: locator.target,
    };
  }
  return { strategy: "within", scopes: [container], target: locator };
}
function contract(): Contract {
  const schema: Contract = {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  };
  for (const p of parameters.values()) {
    if (!name.safeParse(p.name).success) continue;
    schema.properties[p.name] = {
      type: p.type,
      ...(p.type === "string" ? { minLength: 0, maxLength: 256 } : {}),
    };
    if (!schema.required.includes(p.name)) schema.required.push(p.name);
  }
  return schema;
}
function schemaPreview() {
  $("schema").textContent = JSON.stringify(contract(), null, 2);
}
function conditionEditor(step: Step, row: HTMLLIElement) {
  if (
    step.kind === "navigate" ||
    step.kind === "extract" ||
    step.kind === "transform"
  )
    return;
  const params = [
    ...new Map(
      [...parameters.values()]
        .filter((p) => name.safeParse(p.name).success)
        .map((p) => [p.name, p] as const),
    ).values(),
  ];
  const current = conditions.get(step.id),
    field = document.createElement("select");
  field.setAttribute("aria-label", `Condition input for ${step.id}`);
  field.add(new Option("Always run", ""));
  for (const p of params) field.add(new Option(`Only if ${p.name}`, p.name));
  field.value = current?.field ?? "";
  const editor = document.createElement("div");
  editor.className = "condition-controls";
  editor.append(labeled("Run condition", field));
  const refresh = () => {
    const selected = params.find((p) => p.name === field.value);
    if (!selected) {
      conditions.delete(step.id);
      render();
      return;
    }
    const operators =
      selected.type === "boolean"
        ? ["isTrue", "isFalse", "equals", "notEquals"]
        : selected.type === "string"
          ? ["equals", "notEquals", "isEmpty", "isNotEmpty"]
          : ["equals", "notEquals"];
    const previous = conditions.get(step.id),
      operator = document.createElement("select");
    operator.setAttribute("aria-label", `Condition operator for ${step.id}`);
    for (const item of operators) operator.add(new Option(item, item));
    operator.value = operators.includes(previous?.operator ?? "")
      ? previous!.operator
      : operators[0]!;
    let value: HTMLInputElement | HTMLSelectElement;
    if (
      selected.type === "boolean" &&
      ["equals", "notEquals"].includes(operator.value)
    ) {
      const select = document.createElement("select");
      select.add(new Option("true", "true"));
      select.add(new Option("false", "false"));
      select.value =
        selected.type === "boolean" && previous?.value !== "false"
          ? "true"
          : (previous?.value ?? "true");
      value = select;
    } else {
      const field = document.createElement("input");
      field.type = selected.type === "string" ? "text" : "number";
      if (selected.type === "string") field.maxLength = 4096;
      field.value = previous?.value ?? "";
      value = field;
    }
    value.setAttribute("aria-label", `Condition value for ${step.id}`);
    const save = () => {
      const needsValue = ["equals", "notEquals"].includes(operator.value);
      conditions.set(step.id, {
        field: selected.name,
        operator: operator.value,
        value: needsValue
          ? selected.type === "boolean" && !value.value
            ? "true"
            : value.value
          : "",
      });
    };
    operator.onchange = () => {
      const needsValue = ["equals", "notEquals"].includes(operator.value);
      conditions.set(step.id, {
        field: selected.name,
        operator: operator.value,
        value: needsValue
          ? selected.type === "boolean"
            ? previous?.value === "false"
              ? "false"
              : "true"
            : (previous?.value ?? "")
          : "",
      });
      render();
    };
    value.oninput = save;
    value.onchange = save;
    conditions.set(step.id, {
      field: selected.name,
      operator: operator.value,
      value: ["equals", "notEquals"].includes(operator.value)
        ? selected.type === "boolean" && !value.value
          ? "true"
          : (previous?.value ?? value.value)
        : "",
    });
    editor.append(
      labeled("Operator", operator),
      ...(["equals", "notEquals"].includes(operator.value)
        ? [labeled("Expected value", value)]
        : []),
    );
  };
  field.onchange = refresh;
  if (current?.field && params.some((p) => p.name === current.field)) refresh();
  else if (current) conditions.delete(step.id);
  row.append(editor);
}
function render() {
  $("timeline").replaceChildren();
  steps.forEach((s, i) => {
    const row = document.createElement("li"),
      label = document.createElement("strong");
    label.textContent = `${s.kind} · ${"locator" in s ? canonicalize(s.locator) : "url" in s ? s.url : ""}`;
    row.append(label);
    if ("locator" in s) {
      const scope = createScopeControls(scopes.get(s.id), (value) => {
        if (!value.name) scopes.delete(s.id);
        else scopes.set(s.id, value);
      });
      row.append(scope.wrapper);
    }
    if (
      (s.kind === "fill" && typeof s.value === "string") ||
      (s.kind === "select" && typeof s.option === "string")
    ) {
      const preview = document.createElement("code");
      preview.textContent = `Sample: ${s.kind === "fill" ? s.value : s.option}`;
      row.append(preview);
      const field = document.createElement("input");
      field.placeholder = "Parameter name (e.g. ticket_id)";
      field.maxLength = 48;
      field.setAttribute("aria-label", `Parameter for ${s.id}`);
      field.value = parameters.get(s.id)?.name ?? "";
      const type = document.createElement("select");
      type.setAttribute("aria-label", `Parameter type for ${s.id}`);
      for (const t of ["string", "integer", "number", "boolean"])
        type.add(new Option(t, t));
      type.value = parameters.get(s.id)?.type ?? "string";
      const update = () => {
        if (field.value.trim())
          parameters.set(s.id, {
            name: field.value.trim(),
            type: type.value as Parameter["type"],
          });
        else parameters.delete(s.id);
        schemaPreview();
      };
      field.oninput = update;
      field.onchange = () => {
        update();
        render();
      };
      type.onchange = () => {
        update();
        render();
      };
      row.append(field, type);
      row.append(
        button("Redact / remove value", () => {
          steps.splice(i, 1);
          parameters.delete(s.id);
          scopes.delete(s.id);
          conditions.delete(s.id);
          outputActions.delete(s.id);
          render();
        }),
      );
    }
    conditionEditor(s, row);
    row.append(
      button("↑", () => {
        if (i > 0) {
          [steps[i - 1], steps[i]] = [steps[i]!, steps[i - 1]!];
          render();
        }
      }),
      button("↓", () => {
        if (i < steps.length - 1) {
          [steps[i + 1], steps[i]] = [steps[i]!, steps[i + 1]!];
          render();
        }
      }),
      button("Remove", () => {
        steps.splice(i, 1);
        parameters.delete(s.id);
        scopes.delete(s.id);
        conditions.delete(s.id);
        outputActions.delete(s.id);
        render();
      }),
    );
    $("timeline").append(row);
  });
  renderTransforms();
  schemaPreview();
}

function outputSourceNames(beforeTransform = transforms.length) {
  const names = outputs
    .map((output) => output.field.value.trim())
    .filter((field) => name.safeParse(field).success);
  for (const item of transforms.slice(0, beforeTransform))
    if (name.safeParse(item.field).success) names.push(item.field);
  return [...new Set(names)];
}
function inputSourceNames() {
  return [
    ...new Set(
      [...parameters.values()]
        .map((p) => p.name)
        .filter((field) => name.safeParse(field).success),
    ),
  ];
}
function renderTransforms() {
  const root = $("transforms");
  if (!root) return;
  root.replaceChildren();
  transforms.forEach((draft, index) => {
    const row = document.createElement("div");
    row.className = "transform-row";
    const sourceKind = document.createElement("select");
    sourceKind.setAttribute("aria-label", `Transform source kind ${index + 1}`);
    sourceKind.add(new Option("Input", "input"));
    sourceKind.add(new Option("Earlier output", "output"));
    sourceKind.value = draft.sourceKind;
    const source = document.createElement("select");
    source.setAttribute("aria-label", `Transform source field ${index + 1}`);
    const sourceNames =
      draft.sourceKind === "input"
        ? inputSourceNames()
        : outputSourceNames(index);
    source.add(new Option("Choose a source", ""));
    for (const field of sourceNames) source.add(new Option(field, field));
    source.value = draft.sourceField;
    const operation = document.createElement("select");
    operation.setAttribute("aria-label", `Transform operation ${index + 1}`);
    const operations: [TransformOperation, string][] = [
      ["trim", "Trim surrounding spaces · string"],
      ["lowercase", "Lowercase · string"],
      ["uppercase", "Uppercase · string"],
      ["digitsOnly", "Keep digits · string"],
      ["parseInteger", "Parse integer · integer"],
      ["parseNumber", "Parse number · number"],
      ["parseBoolean", "Parse true/false · boolean"],
      ["stringify", "Convert scalar to text · string"],
    ];
    for (const [value, label] of operations)
      operation.add(new Option(label, value));
    operation.value = draft.operation;
    const field = document.createElement("input");
    field.placeholder = "Derived output name";
    field.maxLength = 48;
    field.setAttribute("aria-label", `Derived output name ${index + 1}`);
    field.value = draft.field;
    sourceKind.onchange = () => {
      draft.sourceKind = sourceKind.value as "input" | "output";
      draft.sourceField = "";
      renderTransforms();
    };
    source.onchange = () => {
      draft.sourceField = source.value;
    };
    operation.onchange = () => {
      draft.operation = operation.value as TransformOperation;
    };
    field.oninput = () => {
      draft.field = field.value.trim();
    };
    field.onchange = () => {
      draft.field = field.value.trim();
      renderTransforms();
    };
    row.append(
      labeled("Source kind", sourceKind),
      labeled("Source field", source),
      labeled("Typed operation", operation),
      labeled("Result field", field),
      button("Remove", () => {
        transforms.splice(index, 1);
        renderTransforms();
      }),
    );
    root.append(row);
  });
}

function addOutput(locator: Session["selections"][number], i: number) {
  const row = document.createElement("div");
  row.className = "output-row";
  const field = document.createElement("input");
  field.placeholder = "Output field name";
  field.maxLength = 48;
  field.setAttribute("aria-label", `Output name ${i + 1}`);
  const mode = document.createElement("select");
  mode.setAttribute("aria-label", `Output mode ${i + 1}`);
  for (const [value, label] of [
    ["textContent", "Text (string or null)"],
    ["isVisible", "Visible (boolean)"],
    ["count", "Count (integer)"],
  ])
    mode.add(new Option(label, value));
  const missing = document.createElement("input");
  missing.type = "checkbox";
  missing.checked = true;
  const missingLabel = document.createElement("label");
  missingLabel.className = "check";
  missingLabel.append(missing, "Allow missing");
  const desc = document.createElement("code");
  desc.textContent = canonicalize(locator);
  const scopeControls = createScopeControls(undefined, () => {});
  const waitState = document.createElement("select");
  waitState.setAttribute("aria-label", `Wait state for output ${i + 1}`);
  for (const state of ["visible", "hidden", "attached", "detached"])
    waitState.add(new Option(`Wait until ${state}`, state));
  const currentOutput = {
    step: {
      id: `sout${i}`,
      kind: "extract" as const,
      locator,
      field: `output_${i}`,
      mode: "textContent" as const,
      allowMissing: true,
      timeoutMs: 10000,
    },
    row,
    field,
    mode,
    missing,
    scopeRole: scopeControls.role,
    scopeName: scopeControls.nameField,
  };
  const addWait = () => {
    const id = `sreview_${reviewStepSequence++}`;
    steps.push({
      id,
      kind: "waitForState",
      locator: effectiveLocator(locator, {
        role: currentOutput.scopeRole.value,
        name: currentOutput.scopeName.value.trim(),
      }),
      state: waitState.value as "visible" | "hidden" | "attached" | "detached",
      timeoutMs: 10000,
    });
    outputActions.set(id, currentOutput);
    render();
  };
  const addVisibleAssertion = () => {
    const id = `sreview_${reviewStepSequence++}`;
    steps.push({
      id,
      kind: "assert",
      locator: effectiveLocator(locator, {
        role: currentOutput.scopeRole.value,
        name: currentOutput.scopeName.value.trim(),
      }),
      predicate: "visible",
      expected: true,
      timeoutMs: 10000,
    });
    outputActions.set(id, currentOutput);
    render();
  };
  scopeControls.role.onchange = () => renderTransforms();
  scopeControls.nameField.onchange = () => renderTransforms();
  field.oninput = () => renderTransforms();
  row.append(
    desc,
    field,
    mode,
    missingLabel,
    scopeControls.wrapper,
    waitState,
    button("Add wait", addWait),
    button("Assert visible first", addVisibleAssertion),
  );
  $("outputs").append(row);
  outputs.push(currentOutput);
  renderTransforms();
}

function conditionFor(draft: ConditionDraft): Condition {
  const parameter = [...parameters.values()].find(
    (p) => p.name === draft.field,
  );
  if (!parameter) throw new Error(`Unknown condition input: ${draft.field}`);
  const operator = draft.operator as Condition["operator"];
  if (operator === "equals" || operator === "notEquals") {
    let value: string | number | boolean = draft.value;
    if (parameter.type === "integer" || parameter.type === "number") {
      if (!draft.value.trim())
        throw new Error(`Condition value for ${parameter.name} is required.`);
      value = Number(draft.value);
      if (
        !Number.isFinite(value) ||
        (parameter.type === "integer" && !Number.isSafeInteger(value))
      )
        throw new Error(
          `Condition value for ${parameter.name} must be numeric.`,
        );
    } else if (parameter.type === "boolean") value = draft.value === "true";
    return {
      source: { source: "input", field: parameter.name },
      operator,
      value,
    };
  }
  return {
    source: { source: "input", field: parameter.name },
    operator: operator as Exclude<
      Condition["operator"],
      "equals" | "notEquals"
    >,
  };
}

function compile(): Workflow {
  if (!session) throw new Error("No recording.");
  const inputSchema = contract(),
    outputSchema: Contract = {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    };
  const extractions: Step[] = [];
  for (const o of outputs) {
    const field = o.field.value.trim();
    if (!field) continue;
    if (!name.safeParse(field).success)
      throw new Error(
        "Output names must use lowercase ASCII letters and underscores.",
      );
    if (Object.hasOwn(outputSchema.properties, field))
      throw new Error("Duplicate output name.");
    const mode = o.mode.value as "textContent" | "isVisible" | "count",
      locator = effectiveLocator(o.step.locator, {
        role: o.scopeRole.value,
        name: o.scopeName.value.trim(),
      });
    outputSchema.properties[field] = {
      type:
        mode === "textContent"
          ? o.missing.checked
            ? ["string", "null"]
            : "string"
          : mode === "isVisible"
            ? "boolean"
            : "integer",
    };
    outputSchema.required.push(field);
    extractions.push({
      ...o.step,
      locator,
      field,
      mode,
      allowMissing: o.missing.checked,
    });
  }

  const paramNames = [...parameters.values()].map((p) => p.name);
  if (
    paramNames.some((n) => !name.safeParse(n).success) ||
    new Set(paramNames).size !== paramNames.length
  )
    throw new Error("Use unique ASCII parameter names.");

  const transformSteps: Step[] = transforms.map((draft, index) => {
    const field = draft.field.trim();
    if (!name.safeParse(field).success)
      throw new Error(
        "Derived output names must use lowercase ASCII letters and underscores.",
      );
    if (Object.hasOwn(outputSchema.properties, field))
      throw new Error("Output and derived output names must be unique.");
    if (!draft.sourceField)
      throw new Error(`Choose a source for derived output ${field}.`);
    const outputType: "string" | "integer" | "number" | "boolean" = [
      "trim",
      "lowercase",
      "uppercase",
      "digitsOnly",
      "stringify",
    ].includes(draft.operation)
      ? "string"
      : draft.operation === "parseInteger"
        ? "integer"
        : draft.operation === "parseNumber"
          ? "number"
          : "boolean";
    outputSchema.properties[field] = { type: outputType };
    outputSchema.required.push(field);
    return {
      id: `stransform${index}`,
      kind: "transform" as const,
      source: { source: draft.sourceKind, field: draft.sourceField },
      operation: draft.operation,
      field,
      timeoutMs: 1000,
    };
  });

  const normalized: unknown[] = [
    ...steps.map((s) => {
      const raw: Record<string, unknown> = { ...s },
        parameter = parameters.get(s.id),
        outputAction = outputActions.get(s.id),
        scope = outputAction
          ? {
              role: outputAction.scopeRole.value,
              name: outputAction.scopeName.value.trim(),
            }
          : scopes.get(s.id),
        condition = conditions.get(s.id);
      if ("locator" in s)
        raw.locator = effectiveLocator(
          outputAction?.step.locator ?? s.locator,
          scope,
        );
      if (parameter && s.kind === "fill") raw.value = { param: parameter.name };
      if (parameter && s.kind === "select")
        raw.option = { param: parameter.name };
      if (condition) raw.when = conditionFor(condition);
      return raw;
    }),
    ...extractions,
    ...transformSteps,
  ].map((s, i) => ({ ...(s as Record<string, unknown>), id: `s${i + 1}` }));

  const slug = input("slug"),
    risk = input("risk") as "write" | "read";
  return parseWorkflow({
    schemaVersion: "1.1.0",
    id: `wf_${slug}`,
    slug,
    version: input("version"),
    title: input("title"),
    description: input("description"),
    provenance: {
      source: "user-recorded",
      recorderVersion: "0.1.0",
      createdAt: session.createdAt,
    },
    entrypoint: session.steps.find((s) => s.kind === "navigate")?.url,
    inputSchema,
    outputSchema,
    steps: normalized,
    policy: {
      risk,
      allowedOrigins: [session.origin],
      requiresApproval: risk !== "read",
      maxRuntimeMs: 60000,
      maxSteps: 100,
    },
  });
}

$("add-transform").onclick = () => {
  transforms.push({
    id: `transform_${transformSequence++}`,
    sourceKind: "input",
    sourceField: "",
    operation: "trim",
    field: "",
  });
  renderTransforms();
};
$("export").onclick = () => {
  try {
    if (!(document.getElementById("reviewed") as HTMLInputElement).checked)
      throw new Error("Review and confirm before exporting.");
    const workflow = compile(),
      body = canonicalize(workflow);
    void crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(body))
      .then((bytes) => {
        const hash = [...new Uint8Array(bytes)]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        const a = $("download") as HTMLAnchorElement;
        if (a.href.startsWith("blob:")) URL.revokeObjectURL(a.href);
        a.href = URL.createObjectURL(
          new Blob([body + "\n"], { type: "application/json" }),
        );
        a.download = `${workflow.slug}.workflow.json`;
        a.hidden = false;
        a.textContent = `Download ${workflow.slug} · SHA-256 ${hash}`;
        a.click();
        $("error").textContent = "";
      });
  } catch (e) {
    $("error").textContent =
      e instanceof Error ? e.message : "Invalid workflow";
  }
};
void chrome.runtime.sendMessage({ type: "status" }).then((r) => {
  session = r.data as Session | null;
  if (!session || session.state !== "REVIEW") {
    $("notice").textContent =
      "Stop the recording before editing and exporting.";
    ($("export") as HTMLButtonElement).disabled = true;
    return;
  }
  $("notice").textContent =
    `${session.origin} · ${session.steps.length} steps. ${session.warnings.join(" · ")}`;
  steps.push(...session.steps);
  render();
  session.selections.forEach(addOutput);
});
