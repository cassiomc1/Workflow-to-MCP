# ADR 0003: dedicated authentication profiles

Accepted for implementation, 2026-10-30; full release validation remains pending.

Use a separate visible browser for manual login/MFA, explicit exact origins and an operator-selected private authenticated marker. Capture cookies, localStorage, IndexedDB and current top-level sessionStorage, then prove restoration in a second fresh browser before publishing local metadata. A login held only in page memory must fail saving. Never read a primary Chrome profile or record login credentials in workflow IR.

Persist state with AES-256-GCM, random IVs and profile/generation associated data in an owner-only directory with a separate owner-only random key. Refuse platforms lacking the implemented POSIX checks instead of silently weakening storage protection. SQLite stores nonsecret metadata and hash-to-generation bindings. General secret references remain unsupported.

The local administrator binds an exact trusted revision; MCP callers cannot select identities. Profile leases serialize use. Renewal/rebind/unbind/revocation invalidate verification, publication and approvals. Verification and approvals include policy/authentication digests. Runtime checks TTL/generation/lease, scopes state, verifies login before actions and saves refreshed state only while authority remains current. A revoked/expired session never falls back to anonymous execution.

This is a local-user trust boundary, not protection against equivalent OS authority. Site-specific token lifetime, SSO/MFA compatibility and an account-specific guard remain operator responsibilities. Local revoke does not revoke tokens at the website. See authentication.md and release-checklist.md for supported behavior and pending validation.
