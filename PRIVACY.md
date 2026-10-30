# Privacy

Workflow to MCP has no telemetry, analytics, cloud upload or LLM integration. The extension reads the tab selected through its toolbar action and records committed standard DOM actions and minimal semantic locators. It does not collect cookies, clipboard contents, network bodies, screenshots or a keyboard transcript.

Text inputs are excluded until the user selects them through “Choose an input to permit.” Password, credential, OTP, payment and token-like data is still rejected. Only approve fields containing non-sensitive synthetic data. Redaction is conservative pattern matching and explicit user review, not a universal PII detector. Literal approved samples remain in the draft and may remain in an explicitly reviewed export. Convert them to parameters or remove them before exporting.

There is one draft in `chrome.storage.local`, removable at any time. It expires on the next extension interaction after 24 hours; there is no background timer or claim of erasure while Chrome is closed. Exported downloads are user-managed files.

SQLite in `--home` (`~/.workflow-to-mcp` by default) stores immutable JSON workflows, local origin grants, verification attestations, single-use approval metadata and redacted run/audit records. POSIX directory/file modes are restrictive. Logs contain hashes, event names, status/error codes and metrics, not arguments or extracted page text. Results go only to the calling CLI/MCP client, whose own retention applies.

Browser contexts are ephemeral and closed on success/failure/cancellation/disconnect. No primary profiles, authentication profiles or credential provider is supported. Browser traffic goes to explicitly approved app origins; installation downloads contact package registries/CDNs. A workflow cannot grant a destination.

Use extension Delete recording, `workflow delete SLUG` and `privacy erase-audit`. SQLite secure deletion/checkpointing reduce recoverable deleted content, but do not guarantee OS-level forensic erasure or removal from independent backups/downloads. Stop the server before removing its whole data directory. See README for uninstall steps.
