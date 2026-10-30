# Dependency inventory

Resolved from the public npm registry 2026-10-29, pinned in package.json/pnpm-lock.yaml. Frozen-lockfile installation passed. NNI and Headless Recorder legacy dependencies are outside the product workspace.

| Component | Version | License |
|---|---|---|
| Node LTS target | 24.21.0 | Node distribution notices |
| pnpm | 12.16.1 | MIT |
| @modelcontextprotocol/server/client | 2.4.0 | Apache-2.0 |
| @modelcontextprotocol/core | transitive lockfile pin | Apache-2.0 |
| playwright / playwright-core | 1.64.1 | Apache-2.0 |
| Chromium (Playwright revision 1248) | 156.0.8078.4 | browser distribution notices |
| Zod | 4.6.7 | MIT |
| TypeScript | 6.0.3 | Apache-2.0 |
| typescript-eslint | 8.72.1 | MIT |
| ESLint | 10.13.0 | MIT |
| Vitest | 5.0.5 | MIT |
| esbuild | 0.28.2 | MIT |
| Prettier | 3.9.10 | MIT |

Both production and full pnpm audit scans returned zero vulnerabilities during implementation. This dated scan is not a future guarantee; rerun before releases. `pnpm audit:licenses` resolves production graphs, enforces compatible licenses and includes full notices in `docs/legal/dependency-licenses.json`. Browser notices remain those supplied with Chromium. The clean installed package smoke generates a CycloneDX SBOM; local releases include checksums. SDK v2's installed README confirms MCP 2026-07-28 and the official serving API.
