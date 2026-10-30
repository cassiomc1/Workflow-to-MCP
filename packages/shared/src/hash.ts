import { createHash } from "node:crypto";
import { canonicalize } from "../../workflow-schema/src/index.js";
export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}
