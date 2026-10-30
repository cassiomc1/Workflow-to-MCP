import {
  canonicalize,
  parseWorkflow,
  name,
  type Step,
  type Workflow,
  type Contract,
} from "../../../packages/workflow-schema/src/index.js";
import type { Session } from "./session.js";
let session: Session | null = null;
const steps: Step[] = [];
const parameters = new Map<
  string,
  { name: string; type: "string" | "integer" | "number" | "boolean" }
>();
const outputs: {
  step: Extract<Step, { kind: "extract" }>;
  row: HTMLDivElement;
  field: HTMLInputElement;
  mode: HTMLSelectElement;
  missing: HTMLInputElement;
}[] = [];
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
      ...(p.type === "string" ? { minLength: 1, maxLength: 256 } : {}),
    };
    if (!schema.required.includes(p.name)) schema.required.push(p.name);
  }
  return schema;
}
function schemaPreview() {
  $("schema").textContent = JSON.stringify(contract(), null, 2);
}
function render() {
  $("timeline").replaceChildren();
  steps.forEach((s, i) => {
    const row = document.createElement("li"),
      label = document.createElement("strong");
    label.textContent = `${s.kind} · ${"locator" in s ? canonicalize(s.locator) : "url" in s ? s.url : ""}`;
    row.append(label);
    if (
      (s.kind === "fill" && typeof s.value === "string") ||
      (s.kind === "select" && typeof s.option === "string")
    ) {
      const preview = document.createElement("code");
      preview.textContent = `Sample: ${s.kind === "fill" ? s.value : s.option}`;
      row.append(preview);
      const field = document.createElement("input");
      field.placeholder = "Parameter name (e.g. ticket_id)";
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
            type: type.value as "string" | "integer" | "number" | "boolean",
          });
        else parameters.delete(s.id);
        schemaPreview();
      };
      field.oninput = update;
      type.onchange = update;
      row.append(field, type);
      row.append(
        button("Redact / remove value", () => {
          steps.splice(i, 1);
          parameters.delete(s.id);
          render();
        }),
      );
    }
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
        render();
      }),
    );
    $("timeline").append(row);
  });
  schemaPreview();
}
function addOutput(locator: Session["selections"][number], i: number) {
  const row = document.createElement("div");
  row.className = "output-row";
  const field = document.createElement("input");
  field.placeholder = "Output field name";
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
  row.append(
    desc,
    field,
    mode,
    missingLabel,
    button("Wait until visible", () => {
      steps.push({
        id: `swait${steps.length}`,
        kind: "waitForVisible",
        locator,
        timeoutMs: 10000,
      });
      render();
    }),
    button("Assert visible first", () => {
      steps.push({
        id: `sassert${steps.length}`,
        kind: "assert",
        locator,
        predicate: "visible",
        expected: true,
        timeoutMs: 10000,
      });
      render();
    }),
  );
  $("outputs").append(row);
  outputs.push({
    step: {
      id: `sout${i}`,
      kind: "extract",
      locator,
      field: `output_${i}`,
      mode: "textContent",
      allowMissing: true,
      timeoutMs: 10000,
    },
    row,
    field,
    mode,
    missing,
  });
}
function compile(): Workflow {
  if (!session) throw new Error("No recording.");
  const outputSchema: Contract = {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  };
  const extractions: Step[] = [];
  for (const o of outputs) {
    const field = o.field.value.trim();
    if (!field) continue;
    if (Object.hasOwn(outputSchema.properties, field))
      throw new Error("Duplicate output name.");
    const mode = o.mode.value as "textContent" | "isVisible" | "count";
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
      field,
      mode,
      allowMissing: o.missing.checked,
    });
  }
  const slug = input("slug"),
    risk = input("risk") as "read" | "write";
  const paramNames = [...parameters.values()].map((p) => p.name);
  if (
    paramNames.some((n) => !name.safeParse(n).success) ||
    new Set(paramNames).size !== paramNames.length
  )
    throw new Error("Use unique ASCII parameter names.");
  const normalized = [
    ...steps.map((s) => {
      const p = parameters.get(s.id);
      if (!p) return s;
      if (s.kind === "fill") return { ...s, value: { param: p.name } };
      if (s.kind === "select") return { ...s, option: { param: p.name } };
      return s;
    }),
    ...extractions,
  ].map((s, i) => ({ ...s, id: `s${i + 1}` }));
  return parseWorkflow({
    schemaVersion: "1.0.0",
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
    inputSchema: contract(),
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
