# ADR 0002: runtime and scoped permissions

Accepted, 2026-10-29. Use Node 24.21.0 LTS built-in SQLite rather than a native addon. Query and pin current pnpm12.16.1, Playwright1.64.1 and official split SDK v2.4.0. TypeScript7.0.2 conflicts with typescript-eslint8.72.1 (<6.1), so pin compatible TypeScript6.0.3 instead of overriding peer constraints.

One-tab/one-origin capture uses Chrome's toolbar-granted activeTab permission. Remove optional blanket host patterns; opening popup.html directly does not grant access. Tests trigger the actual action via Chromium Extensions CDP in a disposable profile before exercising shipped UI/capture. Test-only extension debugging is not a production runtime switch.

Runtime origin grants are independent. An authenticated per-run proxy validates and pins public IPv4 destinations. Explicit exact HTTP loopback fixtures are the only private-network exception. IPv6/frames/WebSockets/popups/primary browser profiles are unsupported. ADR 0003 adds dedicated authentication profiles without importing a primary profile. Recorded URLs omit credentials/query/fragment; regex contracts and CSS programs are excluded. These constraints are documented rather than silently worked around.
