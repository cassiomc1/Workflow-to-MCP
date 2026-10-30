# MCP integration

Official split `@modelcontextprotocol/server`/`client` packages are pinned to **2.4.0**. Their installed README identifies v2 as stable and implementing MCP **2026-07-28**. `serveStdio` is the official factory entry point for modern discovery and supported legacy opening. No custom protocol parser or HTTP/SSE daemon is used.

Run `node /absolute/path/dist/cli.js serve --stdio --home /absolute/state`. stdout is protocol only; diagnostics use stderr. SDK cancellation and stdin disconnect close browser execution. Published input/output schemas derive from validated contracts; inputs are rechecked in the runner. Successful structuredContent matches the output schema, while run ID and untrusted-data flags appear in metadata/text. Errors use isError and sanitized codes/messages without raw DOM/exception text.

Only trusted, verified, published immutable revisions are listed. Startup pins identity/schema/hash; invocation rechecks authorization. Disabling/revoking blocks calls immediately. Additions/updates require restart. Approval/admin actions are CLI-only and not tool arguments.

`pnpm test:mcp` launches the actual executable as a child process and negotiates with the official client, lists schemas, runs two real Chromium calls, rejects invalid inputs and tests disabled/unverified access. `pnpm test:e2e` starts from UI capture/export. `pnpm package:smoke` repeats CLI/discovery/calls from a fresh tarball installation.

README gives the common mcpServers configuration with absolute paths. Host-specific setup paths vary. SDK-client success is not an interactive MCP Inspector or third-party host review; those remain separate release checks. No universal host-compatibility claim is made.
