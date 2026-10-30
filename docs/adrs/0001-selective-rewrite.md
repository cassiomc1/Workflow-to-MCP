# ADR 0001: selective rewrite

Accepted, 2026-10-29. The initial checkout was NNI rather than Headless Recorder. NNI was initially preserved during implementation; a subsequent explicit user request authorized removal of all unrelated files locally and from GitHub. Forking Headless Recorder directly would retain MV2/raw capture/source generation and obsolete dependencies.

Implement strict TypeScript modules under apps/packages/tests, study pinned MIT upstream without copying executable source, and use framework-free extension UI. Root tooling builds only the product. Retain original legal notices and Git history, with the provenance mismatch documented in the upstream audit. The working tree contains only Workflow to MCP code, tests, documentation and tooling.

Canonical artifacts live in immutable SQLite content rows instead of mutable external JSON paths. All interfaces share one IR/interpreter. This deliberately narrows features while making trust boundaries explicit.
