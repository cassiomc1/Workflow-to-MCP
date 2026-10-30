# Contributing

The product is in apps/packages/tests/scripts. Keep generated builds, release archives, dependency trees and local workflow state out of Git; regenerate them with the documented commands when needed.

Use pinned Node/pnpm and the frozen lockfile. Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm audit:licenses`, `pnpm audit` and `pnpm package:smoke`. Tests need local loopback sockets and sandboxed Chromium. Run `pnpm benchmark` after replay changes.

IR changes need a format version, migration and compatibility fixtures. Do not add arbitrary evaluation, generated source execution, remote scripts, implicit host grants, first-match locators, argument-based approvals, silent write retries or primary-profile reuse. Review the threat model and ADRs before changing trust boundaries. Evidence must distinguish measured results from unexecuted release gates.
