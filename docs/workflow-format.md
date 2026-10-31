# Workflow format 1.0.0 and 1.1.0

Authority: `packages/workflow-schema/src/index.ts`; generated schema after build: `dist/workflow.schema.json`. Executable fixtures: `examples/demo-crm-lookup/workflow.json` and `examples/demo-crm-create-ticket/workflow.json`.

Both wire versions remain supported. Version 1.0.0 retains the original step and locator shapes. New recordings export as 1.1.0. Unknown properties, actions, locators and versions fail closed; no silent rewrite or implicit migration is performed.

Inputs support string/integer/number/boolean and string enums. Outputs also allow nullable strings. Extra keys, missing required fields, non-finite numbers and controls fail. Strings are at most 4096 characters. Arrays, nested contract objects and arbitrary regex contracts are unavailable. Values use typed parameter references, never locator/URL/script interpolation. Secret references validate but execution explicitly fails until a secret provider exists.

## Locators and actions

Locators use exact role/name, label, test ID, placeholder or escaped ID. Version 1.1.0 can scope a target to one to four semantic containers, such as a named row or region. Each present container and target must be unique. Normal actions require one match; hidden/detached waits and `allowMissing` extraction can accept zero. There is no first-match fallback, index selector, CSS program or frame access.

For example, a named row scopes an exact button target:

```json
{
  "strategy": "within",
  "scopes": [{ "strategy": "role", "role": "row", "name": "TICKET-1001" }],
  "target": { "strategy": "role", "role": "button", "name": "Close" }
}
```

Actions are a closed set: navigate, click, fill, select, check, press, wait, assert, extract and transform. Version 1.1.0 adds waits for visible/hidden/attached/detached states, plus per-step conditions sourced from a declared input or an earlier output. Conditions compare typed values or check boolean/string emptiness. A false condition skips that one step; there are no loops, arbitrary expressions or script/shell actions.

Transforms are fixed operations: trim, lowercase, uppercase, digitsOnly (ASCII digits), parseInteger, parseNumber, parseBoolean and stringify. They read a declared input or earlier output and write a declared output with a compatible scalar type. String parsing rejects null/malformed values, non-finite numbers and unsafe integers. No regular-expression, page, network or filesystem transform is available.

A condition uses `source: { "source": "input", "field": "confirm" }` (or an earlier output) with an operator such as `isTrue`, `isEmpty`, `equals` or `notEquals`. A transform step can derive `count` from an earlier `count_text` output with `"operation": "parseInteger"`. The schema rejects undeclared, forward, or type-incompatible references.

URL waits use exact allowed URLs, not globs or regex. Keys: Enter, Tab, Escape, ArrowDown/Up and Space. Assertions check visibility or exact text. Extraction returns only text/visibility/unique-target count, not HTML or arbitrary attributes.

Steps have unique IDs and 100–30000 ms timeouts. Maximum 100 steps and 120 seconds per workflow, with lower declared limits supported. URLs exclude credentials/query/fragment and require HTTP(S). Allowed origins intersect with separately configured installation grants. Remote sites require public IPv4 HTTPS; explicit fixtures allow only exact IPv4 loopback HTTP origins/ports.

With allowMissing, missing text returns null, visibility false and count zero. Multiple matches always fail. Add a readiness condition before optional outputs so delayed results do not resemble “not found.” All required outputs need one declared extraction or transform and must validate.

Canonical JSON sorts object keys and preserves array order; SHA-256 is an integrity hash, not a signature. Revision edits are rejected: increment the workflow version and reimport/review/verify. Policy changes invalidate all prior verification/publication. Stored content hashes are checked on every load.
