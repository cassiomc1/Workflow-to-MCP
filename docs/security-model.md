# Security model

The local OS user is administrator and trust root. Website content, recordings, descriptions, results and MCP callers are untrusted. This is not an isolation boundary against another process with equivalent OS filesystem/terminal access, a compromised browser binary or an administrator directly editing SQLite.

| Boundary | Controls |
|---|---|
| DOM → capture | trusted events, explicit field selection, password/OTP/payment/token filters before messages, minimal locators, no page-message bridge |
| Content → worker | extension ID, approved tab, top frame, document/session/origin, strict bounded schema, timestamp, sequential deduplicated durable events |
| UI → controls | privileged messages only from extension popup/review, text rendering rather than innerHTML |
| Import → registry | strict known IR, no code execution, immutable canonical hash, separate installation origins and operator hash review |
| Publication → execution | attested content/suite/runner/browser/policy, transactional publication, runtime revalidation |
| Inputs → browser | strict bounded values before allocation, no parameter interpolation into locator/URL/script/path, unique targets |
| Browser → network | authenticated per-run proxy, validate all DNS answers, pin actual connection IP, exact HTTPS origin/port, explicit loopback fixtures, blocked frames/SW/WebSockets/downloads |
| Write → app | interactive trusted local approval, exact hash/input/policy/authentication-generation/actor binding, TTL, single use, unknown/destructive risk blocked, no retries |
| App → results | bounded declared fields, schema validation, token-like redaction, HTML-angle escaping, untrusted-data label |
| Runtime → disk | safe metadata logs, restrictive POSIX modes, no arguments/outputs/raw exception dumps in audit, ephemeral browser context |

Read intent cannot be proved from button labels. GET can mutate state and client-side JS can initiate business actions. The operator must review the application/workflow and explicitly trust the hash. Blocking non-GET/HEAD methods in read flows is defense in depth, not universal semantic side-effect detection.

The proxy controls HTTP(S) destinations; it is not a general OS egress firewall. Use an independent OS/container network boundary for hostile workloads. Browser sandbox remains enabled. IPv6, WebRTC app workflows, remote MCP and general credential providers are unsupported. Dedicated authentication profiles require POSIX owner-only permissions; no primary Chrome profile is loaded. Dependencies/browser builds require updates and re-verification.

Secret detection is conservative pattern matching plus explicit review, not universal PII identification. Record synthetic data and do not import secrets as literals. Secret references fail closed without a provider. Product failure diagnostics do not take screenshots; test screenshots contain synthetic data only.

Tests cover schema injection, URL policy, approvals/replay/unknown outcomes, actual capture/export/replay/MCP and cleanup. An unexecuted platform/host check or missing independent review must remain visible in release evidence.

Authentication profiles use a dedicated human-driven login, an operator-selected unique private marker and proof of restored state in a second browser. Select a marker specific to the intended account when identity affects authorization. Profile state is encrypted with random AES-256-GCM IVs and profile/generation associated data, while SQLite stores only metadata. The key is a separate owner-only file, not an OS keychain: the local OS user remains trusted. Binding, renewal, revocation and expiry invalidate use; there is no anonymous fallback. Exclusive leases serialize profile use, and active authenticated runs recheck generation/status/expiry. See [authentication](authentication.md) for configuration and site-compatibility limits.

Read-mode authentication POST exceptions are unavailable because every HTTPS redirect hop must be constrained before a mutating submission. Login restoration checks and read-workflow checks therefore use GET/HEAD only. A write workflow's private check runs under its single-use write approval. The 10 MiB accepted-state limit is checked after browser export; it is a persistence limit, not an OS memory guarantee. The effect of oversized IndexedDB export on the controller remains a validation lead; hostile workloads require independent OS resource isolation.
