# Workflow to MCP

Record a permitted browser task, review it, replace samples with typed inputs, verify it in isolated Chromium, and expose the exact verified revision as an MCP tool. Local SQLite, stdio transport, no telemetry or generated-code execution.

The product lives in `apps/`, `packages/`, `tests/` and `scripts/`. See [implementation evidence](docs/implementation-progress.md) for results and incomplete release gates. This is an MVP implementation, not a universally compatible or independently approved public release. Unrelated NNI sources and tooling have been removed; their original history and MIT attribution remain available.

## Install from source

Use Node **24.21.0** (pinned in `.node-version`) or the tested Node 26 runtime, with pnpm **12.16.1**:

```sh
npm install --global pnpm@12.16.1
pnpm install --frozen-lockfile
pnpm browser:install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
node dist/cli.js doctor
```

Tests need local loopback sockets and sandboxed Chromium. Linux also needs `pnpm exec playwright install --with-deps chromium` and working Chromium sandbox support. Do not disable the browser sandbox. macOS ARM64 is validated locally; Linux/Windows jobs are configured but platform support awaits executed CI results.

For an end-user installation from the locally generated package:

```sh
pnpm release:artifacts
npm install --global ./artifacts/workflow-to-mcp-0.1.0.tgz
workflow-to-mcp doctor
```

Install its exact browser too: `pnpm browser:install` from source, or `npm exec --package=playwright@1.64.1 -- playwright install chromium`. The package has not been published to npm. `pnpm package:smoke` tests an actual clean tarball installation, CLI import/trust/verify/publish and MCP calls outside the checkout.

## Record your own lookup

1. Run `pnpm demo:serve`; open `http://127.0.0.1:4173/tickets` in Chrome.
2. Open `chrome://extensions`, enable developer mode, and load `dist/extension` unpacked (or extract the release ZIP).
3. Open the extension **from its toolbar button on the demo tab** and press **Permit this origin & record**. This uses a temporary `activeTab` grant, not permanent access to all sites.
4. Press **Choose an input to permit**, dismiss the popup, then click **Ticket ID**. Enter synthetic `TICKET-1001` and click **Search**. Unknown text fields are private by default, and sensitive fields remain excluded even if selected.
5. Reopen the popup and use **Choose an output element** to select the “Ticket found” heading. Repeat separately for status and summary. Select one more output with **Shift-click on the summary** to choose its surrounding stable results container. The container will be used only as a readiness condition.
6. Press **Stop & review**. Set the captured input parameter to `ticket_id`. Name the first three outputs `found`, `status`, `summary`; select **Visible (boolean)** for `found`. Keep **Allow missing** enabled.
7. On the fourth output (the results container), press **Wait until visible** and leave its field name empty. This waits for completed results including “No matching ticket.” Select **Read** only after reviewing that the flow has no side effects.
8. Review every step, sample, origin and output, check the confirmation and export `.workflow.json`. Export does not execute or publish.

The UI supports pause/resume, safe timeline rendering, step removal/reordering, value removal/redaction, typed parameterization, explicit extraction and visible assertions. No keyboard transcript, cookies or passwords are collected. One tab and one origin are supported. Opening `popup.html` directly does not grant `activeTab`; use the toolbar.

## Import, review, verify, publish

Keep the demo server running. The bundled example reproduces runtime behavior independently of recording; replace its import path with your downloaded recording to use your own flow.

```sh
node dist/cli.js policy allow --origin http://127.0.0.1:4173 --fixture
node dist/cli.js workflow import examples/demo-crm-lookup/workflow.json
node dist/cli.js workflow inspect lookup_support_ticket
```

Review the full IR, literal samples, origins, risk and schemas, then copy its exact SHA-256 from `inspect`:

```sh
node dist/cli.js workflow trust lookup_support_ticket --hash REVIEWED_SHA256
node dist/cli.js workflow verify lookup_support_ticket --suite examples/demo-crm-lookup/cases.json
node dist/cli.js workflow publish lookup_support_ticket --version 1.0.0
node dist/cli.js workflow run lookup_support_ticket --input examples/demo-crm-lookup/input.json
node dist/cli.js serve --stdio
```

Your recording must use the suite's input/output names. The suite checks two ticket IDs and a missing ticket. `TICKET-1001` returns:

```json
{"found":true,"status":"open","summary":"A synthetic example ticket"}
```

Every command accepts `--home DIRECTORY` (or `WORKFLOW_MCP_HOME`) and `--json`. State defaults to `~/.workflow-to-mcp`. Import never executes or grants permission. Origin grants and workflow review are separate. Changing installation policy invalidates prior verification/publication. Edits require a new immutable workflow version and re-verification.

## Connect an MCP client

For a host using common `mcpServers` configuration, use absolute paths:

```json
{
  "mcpServers": {
    "workflow-to-mcp": {
      "command": "/ABSOLUTE/PATH/TO/node",
      "args": ["/ABSOLUTE/PATH/TO/Workflow-to-MCP/dist/cli.js", "serve", "--stdio"]
    }
  }
}
```

The tool is `wf_lookup_support_ticket`, with required `ticket_id: string` and no extra properties. Call `{"ticket_id":"TICKET-1002"}` to get `{"found":true,"status":"closed","summary":"A second synthetic ticket"}`. Outputs are untrusted application data. Tool-list additions/updates require a server restart; disabling or revoking policy blocks new calls immediately. `pnpm test:mcp` uses the actual official SDK v2 client, child-process stdio, real Chromium and invalid arguments. [MCP integration](docs/mcp-integration.md) records host-validation boundaries. There is no HTTP MCP listener.

## Writes and approvals

The synthetic write example is in `examples/demo-crm-create-ticket/`. Import and review its hash as above. Verification requests a local terminal approval per case; restart the disposable demo before verifying its suite (which expects `CREATED-1`). After verification/publication, approve one exact invocation in a trusted interactive local terminal:

```sh
node dist/cli.js approval grant create_support_ticket --input examples/demo-crm-create-ticket/input.json
```

Review the displayed workflow hash, origins and inputs; type the workflow slug. Invoke the matching MCP tool or `workflow run` within 60 seconds using the exact input. Approval is server-side, bound to the OS principal, policy, content hash and input digest, and consumed once. No `approved` argument exists. Missing/reused/expired approval fails before browser allocation. Unknown/destructive workflows are disabled.

Failure after a potentially mutating interaction yields `OUTCOME_UNKNOWN`. Inspect the application and `run inspect RUN_ID`; no automatic retry occurs. Browser automation is not a rollback-capable database transaction.

## Limits, errors and removal

- Actions: navigate, click, fill, select, check, allowlisted keys, visibility/exact-URL waits, visible/text assertions, explicit text/visibility/count extraction. Locators must match exactly one element. No scripts, shell steps, CSS programs or automatic repair.
- Frames, popups, uploads/downloads, WebSockets, authenticated profiles and secret storage are unsupported. `secretRef` validates as a future reference but execution explicitly returns `SECRET_NOT_CONFIGURED`. The runner never uses a primary Chrome profile.
- Recorded IR URLs exclude query, fragment and credentials to avoid URL-secret capture. Runtime app requests may have queries. Remote sites require approved HTTPS origins and public IPv4 answers. IPv6/private networks are blocked; `--fixture` grants only the exact HTTP IPv4 loopback origin/port.
- Missing browser: run the pinned installation command and use the same `PLAYWRIGHT_BROWSERS_PATH`, if set, during install, verification and MCP serving.
- `PERMISSION_DENIED`: authorize the origin and trust the reviewed hash separately. `WORKFLOW_NOT_VERIFIED`: reverify after a content/policy/runtime change. `LOCATOR_AMBIGUOUS`: select a unique semantic target; there is no first-match fallback.
- Use **Delete recording** to clear the draft. Drafts expire on the next extension interaction after 24 hours. `workflow delete SLUG` removes revisions/approvals/runs; `privacy erase-audit` deletes audit entries with SQLite secure deletion/checkpointing.
- Remove the extension in Chrome and run `npm uninstall --global workflow-to-mcp`. Stop the server before deleting the entire selected application data directory. User-managed downloads/backups remain separate.

Read [privacy](PRIVACY.md), [security](docs/security-model.md), [upstream audit](docs/upstream-audit.md), [workflow format](docs/workflow-format.md), [dependencies](docs/dependency-inventory.md) and [notices](docs/legal/third-party-notices.md).
