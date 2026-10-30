# Release readiness

Local implementation evidence is in [implementation-progress.md](implementation-progress.md); architecture and supported scope are documented in [architecture.md](architecture.md) and [workflow-format.md](workflow-format.md).

Completed local checks include real MV3 capture/export, worker termination/recovery, typed replay, SQLite migration/integrity, immutable verification/publication, SDK v2 MCP calls, approval-gated writes, privacy/security regressions, frozen install, license/vulnerability audit, tarball installation and synthetic reliability measurements. Generated package/extension/schema/SBOM/checksums are under artifacts/ (untracked build output).

Before claiming a public release, complete the checks that this local implementation cannot certify:

- Execute the configured Linux, macOS and Windows CI matrix in the repository's CI environment. A configured job is not an executed pass.
- Have a separate reviewer reproduce the README from a clean machine/profile and review the trust boundaries, permissions and write approval behavior.
- Validate MCP Inspector and at least one interactive third-party host using its actual configuration. The automated official SDK client is validated separately.
- Review Chrome Web Store privacy/permission requirements before submitting; no store or npm publication has occurred.
- Keep unsupported authentication/secret providers, frames, popups, files, IPv6 and remote MCP out of release claims. Secret references fail closed; these are documented feature limits.

Unrelated NNI sources and tooling have been removed. Upstream legacy Headless Recorder tests were not run. No external credentials, private accounts or real production records were used.
