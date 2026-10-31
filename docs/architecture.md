# Architecture

Chrome MV3 capture → review/export → strict IR → local CLI/SQLite → compiler/isolated Playwright → typed stdio MCP. All interfaces share the same validated workflow and interpreter; generated JavaScript is never an input.

`workflow-schema` defines strict bounded Zod contracts/action/locator unions and exports JSON Schema 2020-12. `recorder-core` sanitizes before messaging. The worker validates extension/tab/frame/document/session/origin, serializes updates and persists acknowledged sequence/deduplication checkpoints. Worker globals are not durable state.

`registry` uses SQLite immutable content rows instead of external mutable JSON paths, with WAL, foreign keys, migration version, unique revisions, transactional publication, single-use approvals and safe audit records. Import grants nothing. Local origin authorization and hash-based operator review are separate. Attestations bind the content hash, suite, runner/exact Node runtime/browser build and local policy hash/version and authentication digest.

The runner re-reads contents and policy per invocation, validates inputs before allocation, consumes approval, opens sandboxed Chromium and runs the closed interpreter. Version 1.1 conditions skip individual steps, typed transforms use a fixed operation enum, and scoped locator paths check uniqueness at every level. There are no loops or arbitrary code actions. Only bounded declared outputs are returned and schema-validated; missing text is null and missing visibility false. All browser paths clean up.

A per-run authenticated loopback proxy validates IPv4 DNS answers and connects to the validated numeric IPv4 address, preventing a second DNS lookup. HTTP redirects are authorized before forwarding. HTTPS CONNECT destinations and all browser requests are independently checked. Service workers, frames, downloads and WebSockets are blocked. Read workflows permit GET/HEAD only, but an operator still reviews application intent because GET may mutate data.

Authentication profiles keep encrypted browser state separate from SQLite metadata. Login is human-driven in a dedicated context, then checked after restoration. Bindings select a generation for an exact workflow hash; profile leases serialize login/execution. TTL/revocation guards and binding changes fail closed and invalidate derived approvals/verification/publication. The runner scopes restored state, checks a private marker, captures rotated state and redacts known credentials before returning results.

MCP v2 `serveStdio` registers exact published revisions and authentication digests on startup. The runtime rechecks policy on calls. No administrative MCP tools, remote listener or hot reload exist. CLI and MCP return the same application semantics; output is marked untrusted data.
