# User guide

The [README](../README.md) is the install/record/import/review/verify/publish/MCP quickstart. Use the synthetic CRM for the first workflow; no real accounts or credentials are required. For private websites, follow the [authentication profile guide](authentication.md); complete login/MFA separately and bind the profile before verification. Check current validation and release limitations in [implementation evidence](implementation-progress.md).

Start recording from the extension toolbar on the intended HTTP(S) tab. Explicitly permit each non-sensitive input before typing. Pause to perform actions you do not want captured; resume explicitly. A new origin or closed tab interrupts the session. The worker reconstructs persisted checkpoints after suspension.

Use output selection on stable result elements. Shift-click a child to choose its nearest stable parent container. In review, use the results container for “Wait until visible,” leaving its output name blank. Name only fields to return, and choose the correct text/visibility/count mode. Optional missing text is null and missing visibility false. Explicit readiness avoids confusing delayed rendering with a missing record.

Convert sample values to parameters; review risk, origins and every action. Remove unwanted/sensitive values or steps; reorder only after reviewing the resulting semantics. Export confirms review and shows a canonical SHA-256. The CLI separately authorizes origins and trusts the full reviewed hash, verifies a test suite, then publishes a pinned version. Import/export are not execution permissions.

Write approvals must be issued from an interactive trusted terminal for the exact inputs within the expiry window. No approval flag exists in MCP. Inspect uncertain outcomes before taking any further action. Deletion/uninstall and error recovery commands are in README and PRIVACY.md.
