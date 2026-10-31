# User guide

The [README](../README.md) is the install/record/import/review/verify/publish/MCP quickstart. Use the synthetic CRM for the first workflow; no real accounts or credentials are required. For private websites, follow the [authentication profile guide](authentication.md); complete login/MFA separately and bind the profile before verification. Check current validation and release limitations in [implementation evidence](implementation-progress.md).

Start recording from the extension toolbar on the intended HTTP(S) tab. Explicitly permit each non-sensitive input before typing. Pause to perform actions you do not want captured; resume explicitly. A new origin or closed tab interrupts the session. The worker reconstructs persisted checkpoints after suspension.

Use output selection on stable result elements. Shift-click a child to choose its nearest stable parent container. In review, add a semantic scope such as a named row or region when a target appears more than once; each scope and target must still be unique. Choose a visible/hidden/attached/detached wait for the expected page state. Name only fields to return, and choose the correct text/visibility/count mode. Optional missing text is null and missing visibility false. Explicit readiness avoids confusing delayed rendering with a missing record.

Review can add conditions to individual actions based on typed inputs, and derive output fields from an input or earlier output with fixed operations such as trimming, case conversion, digits-only filtering, strict number/boolean parsing or scalar-to-text conversion. These actions do not execute user code. Conditions do not create groups or loops; a false condition skips only its step.

Convert sample values to parameters; review risk, origins and every action. Remove unwanted/sensitive values or steps; reorder only after reviewing the resulting semantics. Export confirms review and shows a canonical SHA-256. The CLI separately authorizes origins and trusts the full reviewed hash, verifies a test suite, then publishes a pinned version. Import/export are not execution permissions.

Write approvals must be issued from an interactive trusted terminal for the exact inputs within the expiry window. The prompt previews the entry point, allowed origins, authentication identity, inputs and planned actions with values. Approval is single-use and remains unavailable to MCP callers. Inspect uncertain outcomes before taking any further action. Deletion/uninstall and error recovery commands are in README and PRIVACY.md.
