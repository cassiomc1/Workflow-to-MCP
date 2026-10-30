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
| Write → app | interactive trusted local approval, exact hash/input/policy/actor binding, TTL, single use, unknown/destructive risk blocked, no retries |
| App → results | bounded declared fields, schema validation, token-like redaction, HTML-angle escaping, untrusted-data label |
| Runtime → disk | safe metadata logs, restrictive POSIX modes, no arguments/outputs/raw exception dumps in audit, ephemeral browser context |

Read intent cannot be proved from button labels. GET can mutate state and client-side JS can initiate business actions. The operator must review the application/workflow and explicitly trust the hash. Blocking non-GET/HEAD methods in read flows is defense in depth, not universal semantic side-effect detection.

The proxy controls HTTP(S) destinations; it is not a general OS egress firewall. Use an independent OS/container network boundary for hostile workloads. Browser sandbox remains enabled. IPv6, WebRTC app workflows, external auth profiles and remote MCP are unsupported. Dependencies/browser builds require updates and re-verification.

Secret detection is conservative pattern matching plus explicit review, not universal PII identification. Record synthetic data and do not import secrets as literals. Secret references fail closed without a provider. Product failure diagnostics do not take screenshots; test screenshots contain synthetic data only.

Tests cover schema injection, URL policy, approvals/replay/unknown outcomes, actual capture/export/replay/MCP and cleanup. An unexecuted platform/host check or missing independent review must remain visible in release evidence.
