# Authenticated websites

Authentication profiles are available in version 0.2.0 on macOS/Linux with POSIX owner-only permissions. Anonymous workflows remain usable on Windows, but authentication profiles explicitly fail with `AUTH_STORAGE_UNSUPPORTED` there. A separate visible Chromium window collects the login; the recorder never reads your primary Chrome profile or captures passwords. Complete login and MFA yourself, then save from the local terminal.

## Try the synthetic authenticated CRM

Build the current sources and start `pnpm demo:serve` in another terminal. Use the same `--home DIRECTORY` for every command if you select a nondefault registry.

```sh
node dist/cli.js policy allow --origin http://127.0.0.1:4173 --fixture
node dist/cli.js auth login demo_account \
  --url http://127.0.0.1:4173/auth/login \
  --check-url http://127.0.0.1:4173/auth/check \
  --check-test-id auth-ready
```

In the new window, sign in using the **synthetic** user `demo`, password `demo-password` and code `123456`. After the private account marker appears, press Enter in the terminal. Saving checks the private page, captures permitted cookies, localStorage, IndexedDB and the current top-level page's sessionStorage, then proves the snapshot works in a second fresh browser. A failed check leaves an existing saved profile intact. Closing the window, Ctrl+C or the 30-minute login deadline cancels the operation.

Import and inspect the authenticated example, then review every origin, step, contract and risk before trusting its exact displayed hash:

```sh
node dist/cli.js workflow import examples/demo-crm-authenticated-lookup/workflow.json
node dist/cli.js workflow inspect lookup_support_ticket --version 1.1.0
node dist/cli.js workflow trust lookup_support_ticket --version 1.1.0 --hash REVIEWED_SHA256
node dist/cli.js auth bind lookup_support_ticket --version 1.1.0 --profile demo_account
node dist/cli.js workflow verify lookup_support_ticket --version 1.1.0 --suite examples/demo-crm-lookup/cases.json
node dist/cli.js workflow publish lookup_support_ticket --version 1.1.0
node dist/cli.js workflow run lookup_support_ticket --version 1.1.0 --input examples/demo-crm-lookup/input.json
node dist/cli.js serve --stdio
```

The existing MCP configuration works unchanged. The published tool is `wf_lookup_support_ticket`; MCP cannot select profiles, log in or bypass local write approvals. If you already run the server, restart it after publishing an authentication change.

## Configure your own site

Authorize each exact HTTPS origin before login. The command below assumes the application's private check page is on `app.example.com` and the identity provider is on `login.example.net`:

```sh
node dist/cli.js policy allow --origin https://login.example.net
node dist/cli.js policy allow --origin https://app.example.com
node dist/cli.js auth login my_account \
  --url https://login.example.net/sign-in \
  --check-url https://app.example.com/account \
  --check-role heading --check-name "My private account"
```

The login command accepts a clean login URL and a private check URL, without embedded credentials, query or fragment. Choose exactly one unique marker: `--check-test-id VALUE`, `--check-label VALUE`, or `--check-role ROLE --check-name "Exact accessible name"` (`ROLE` supports button, link, textbox, checkbox, radio, combobox or heading). If the check is on a third origin, add it with `policy allow --origin URL` and `--auth-origin URL`; repeat both for each additional identity-provider origin. The guard must be visible only for the intended authenticated account. Choose an account-specific marker when different accounts have different authority; the tool cannot infer which account you meant from a generic dashboard.

Use repeated `--auth-origin https://identity.example.com` for additional login origins, after granting each with installation policy. The workflow's origins must fit the profile; its private check origin must also be a workflow origin. Only needed workflow-origin state is restored for a run. Frames, popups, WebSockets, downloads and service workers remain blocked, so some SSO/MFA flows are incompatible. There is no automatic handling of CAPTCHA or site security challenges.

Read workflows and login restoration checks permit GET/HEAD only. Automatic POST refresh exceptions are unavailable; `--auth-post-url` is rejected explicitly. A site that requires POST during the login restoration check cannot save a reusable profile in this version. Business POSTs require a reviewed write workflow and local approval. That approval also covers page requests during its private account check; startup failures are conservatively uncertain. Manual login itself permits the human login form submission.

## Renew, inspect and revoke

```sh
node dist/cli.js auth list
node dist/cli.js auth inspect demo_account
node dist/cli.js auth login demo_account
node dist/cli.js auth revoke demo_account
node dist/cli.js auth unbind lookup_support_ticket --version 1.1.0
```

`auth login NAME` without configuration flags reuses the saved configuration and asks you to log in again. To change configuration, provide the complete login/check/marker configuration. Default expiry is eight hours; `--ttl-hours` accepts one minute through 168 hours. The website may expire or revoke the session sooner. `AUTHENTICATION_REQUIRED` means a fresh manual login is needed; the runner never falls back to an anonymous account.

Binding, unbinding, renewal and revocation invalidate affected verification, publication and approvals. Verify/publish again and restart MCP after any identity change. A profile has one live login/run lease; concurrent use returns `AUTH_PROFILE_BUSY`. A write failure after browser page execution begins, including during navigation or the private check, conservatively reports `OUTCOME_UNKNOWN`: inspect the website before another invocation.

State is encrypted with AES-256-GCM under `<home>/auth/`; a separate owner-only `.key` file is required to decrypt it. This protects stored files from unintended readers under the documented local-user boundary; another process with the same OS authority can read the key. Do not share, commit or log that directory. SQLite and inspection commands contain only nonsecret configuration/metadata. Revocation blocks local use and deletes saved encrypted state; it does not log out other browsers or revoke website tokens remotely. Use the website's own session controls for remote logout. Application/MCP-client output retention remains the caller's responsibility.
