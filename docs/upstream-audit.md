# Upstream audit

Baseline workspace: Microsoft NNI commit `767ed7f22e1e588ce76cbbecb6c6a4a76a309805`, despite the Workflow-to-MCP repository name. The unrelated NNI implementation, documentation, examples and automation were subsequently removed at the user's request. The original baseline remains in Git history, and its MIT attribution is retained in LICENSE.

Audited [Checkly Headless Recorder](https://github.com/checkly/headless-recorder) pinned to `4fb93c125f40bceb2dd9aac403e200a3ade5a8d9`, cloned into a disposable directory and checked out detached. MIT license, Copyright (c) 2021 Checkly Inc., retained verbatim in `docs/legal/headless-recorder-MIT.txt`. License SHA-256: `b81761f16b08c6ee48af79318a5ad986314f27100515e64ba8b0dc997e4537a8`; manifest SHA-256: `65ca3a2571c78cae18dcd9f477dfd859ed55c009ea1e3d5e30d556e6e4813e6f`.

| Upstream file/responsibility | Finding | Rewrite |
|---|---|---|
| src/manifest.json | MV2, cookies/broad hosts, unsafe-eval | MV3, activeTab and self-only CSP |
| src/modules/recorder/index.js | forwards e.target.value | committed actions, explicit fields, pre-message redaction |
| src/services/selector.js | ID/finder CSS | semantic exact locators and uniqueness |
| src/background/index.js | mutable _recording globals | durable MV3 session checkpoints |
| src/modules/code-generator/base-generator.js | generated source strings | closed typed IR interpreter |
| browser/controller/overlay/test directories | legacy injection and integration concepts | new isolated extension surfaces and direct browser tests |
| package.json | Vue CLI4, Vue3.0.6, TS3.9, node-sass5, Playwright1.10, Puppeteer9 | no legacy dependency reused |

No executable upstream source was copied. UX concepts and responsibility boundaries were studied. Upstream tests were **not run**: the rewrite ships none of the obsolete tree, and legacy native/browser installs would not test the new product. This is an explicit upstream-baseline limitation, not an upstream test pass. The new implementation tests actual capture/import/replay/protocol paths. See ADR 0001.
