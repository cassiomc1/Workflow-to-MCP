# Workflow format 1.0.0

Authority: `packages/workflow-schema/src/index.ts`; machine schema after build: `dist/workflow.schema.json`. Executable fixtures: `examples/demo-crm-lookup/workflow.json` and `examples/demo-crm-create-ticket/workflow.json`.

The format includes identity/revision, provenance, entrypoint, bounded contracts, discriminated steps and declared policy. Unknown properties/actions/locators/versions are rejected. Only 1.0.0 is supported; the identity migration and unsupported-version cases are tested. New transitions require explicit migrations.

Inputs support string/integer/number/boolean and string enums. Outputs also allow nullable strings. Extra keys, missing required fields, non-finite numbers and controls fail. Strings are at most 4096 characters. Arrays, nested objects and arbitrary regex contracts are intentionally unavailable. Values use typed parameter references, never locator/URL/script interpolation. Secret references validate but execution explicitly fails until a secret provider exists.

Locators: exact role/name, label, test ID, placeholder and escaped ID. No CSS programs or frames. Actions: navigate/click/fill/select/check/press/waitForVisible/waitForURL/assert/extract. URL waits use exact allowed URLs, not globs or regex. Keys: Enter, Tab, Escape, ArrowDown/Up and Space. Assertions check visibility or exact text. Extraction returns only text/visibility/unique-target count, not HTML or arbitrary attributes.

Steps have unique IDs and 100–30000 ms timeouts. Maximum 100 steps and 120 seconds per workflow, with lower declared limits supported. URLs exclude credentials/query/fragment and require HTTP(S). Allowed origins intersect with separately configured installation grants. Remote sites require public IPv4 HTTPS; explicit fixtures allow only exact IPv4 loopback HTTP origins/ports.

With allowMissing, missing text returns null, visibility false and count zero. Multiple matches always fail. Add a readiness condition before optional outputs so delayed results do not resemble “not found.” All required outputs need one declared extraction and must validate.

Canonical JSON sorts object keys and preserves array order; SHA-256 is an integrity hash, not a signature. Revision edits are rejected: increment the workflow version and reimport/review/verify. Policy changes invalidate all prior verification/publication. Stored content hashes are checked on every load.
