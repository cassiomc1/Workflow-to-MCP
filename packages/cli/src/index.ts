#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { chromium } from "playwright";
import { Registry } from "../../registry/src/index.js";
import {
  originSchema,
  validateContract,
} from "../../workflow-schema/src/index.js";
import { runWorkflow, localActor } from "../../runner/src/index.js";
import { verifyWorkflow } from "../../testing/src/verify.js";
import { serve } from "../../mcp-server/src/index.js";
import { fail, safeError, VERSION } from "../../shared/src/index.js";
import { beginLogin, revokeProfile } from "../../auth/src/session.js";
import { authConfigSchema } from "../../auth/src/schema.js";
const help = `Workflow to MCP ${VERSION}
  doctor
  policy allow --origin https://approved.example [--fixture for exact http://127.0.0.1:PORT]
  policy revoke --origin URL
  workflow import FILE
  workflow list | inspect SLUG [--version VERSION]
  workflow trust SLUG --hash REVIEWED_SHA256 [--version VERSION]
  workflow verify SLUG --suite FILE [--version VERSION]
  workflow publish SLUG --version VERSION
  workflow disable | delete SLUG
  workflow run SLUG --input FILE [--version VERSION] [--idempotency-key KEY]
  auth login PROFILE --url LOGIN_URL --check-url PRIVATE_URL --check-test-id ID [--ttl-hours 8]
    [--auth-origin ORIGIN ...]
    (or --check-label LABEL / --check-role ROLE --check-name NAME)
  auth list | inspect PROFILE | revoke PROFILE
  auth bind SLUG --profile PROFILE [--version VERSION]
  auth unbind SLUG [--version VERSION]
  approval grant SLUG --input FILE [--version VERSION]  (interactive local terminal)
  run inspect RUN_ID
  privacy erase-audit
  serve --stdio
All commands accept --home DIRECTORY and --json. Imports never grant origin or workflow trust.
`;
async function jsonFile(path: string | undefined) {
  if (!path) fail("PARAMETER_INVALID", "A JSON file is required.");
  const info = await stat(path);
  if (info.size > 256000 || !info.isFile())
    fail("PARAMETER_INVALID", "Invalid JSON file size/type.");
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return fail("PARAMETER_INVALID", "Invalid JSON.");
  }
}
async function main() {
  const { values, positionals: p } = parseArgs({
    allowPositionals: true,
    options: {
      home: { type: "string" },
      json: { type: "boolean" },
      origin: { type: "string" },
      fixture: { type: "boolean" },
      version: { type: "string" },
      hash: { type: "string" },
      input: { type: "string" },
      suite: { type: "string" },
      "idempotency-key": { type: "string" },
      stdio: { type: "boolean" },
      help: { type: "boolean" },
      profile: { type: "string" },
      url: { type: "string" },
      "check-url": { type: "string" },
      "check-test-id": { type: "string" },
      "check-label": { type: "string" },
      "check-role": { type: "string" },
      "check-name": { type: "string" },
      "ttl-hours": { type: "string" },
      "auth-origin": { type: "string", multiple: true },
      "auth-post-url": { type: "string", multiple: true },
    },
  });
  if (!p.length || values.help) {
    process.stdout.write(help);
    return;
  }
  if(values.profile && !(p[0] === 'auth' && p[1] === 'bind'))fail('PARAMETER_INVALID','Use auth bind to choose a profile; per-run profile overrides are not supported.');
  const registry = new Registry(
    values.home ??
      process.env.WORKFLOW_MCP_HOME ??
      join(homedir(), ".workflow-to-mcp"),
  );
  let serving = false;
  const output = (value: unknown) =>
    process.stdout.write(
      JSON.stringify(value, null, values.json ? undefined : 2) + "\n",
    );
  const get = () => {
    if (!p[2]) fail("PARAMETER_INVALID", "Workflow slug required.");
    return registry.get(p[2], values.version);
  };
  const approve = async (input: unknown) => {
    const s = get();
    const profile = registry.authBinding(s.hash),
      authentication = registry.authDigest(s.hash);
    validateContract(s.workflow.inputSchema, input);
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      fail(
        "PERMISSION_DENIED",
        "Approval requires a trusted interactive local terminal.",
      );
    const terminal = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    process.stderr.write(
      `Approve a single write\nWorkflow: ${s.workflow.slug} @ ${s.workflow.version}\nSHA-256: ${s.hash}\nOrigins: ${s.workflow.policy.allowedOrigins.join(", ")}\nAuthentication: ${profile ? profile.config.id + " / " + profile.generation : "anonymous"}\nInputs: ${JSON.stringify(input)}\nExpires in 60 seconds. No automatic retry.\n`,
    );
    try {
      const answer = await terminal.question(
        "Type the workflow slug to approve: ",
      );
      if (answer !== s.workflow.slug) fail("APPROVAL_REQUIRED");
      if (registry.authDigest(s.hash) !== authentication)
        fail(
          "AUTH_PROFILE_REVOKED",
          "Authentication changed while approval was pending. Review the new profile before approving again.",
        );
      return registry.approve(s, input, localActor());
    } finally {
      terminal.close();
    }
  };
  try {
    switch (p[0]) {
      case "doctor": {
        let browser = false;
        try {
          await stat(chromium.executablePath());
          browser = true;
        } catch {
          /* unavailable */
        }
        let extension = false;
        try {
          await stat(
            resolve(
              dirname(fileURLToPath(import.meta.url)),
              "extension/manifest.json",
            ),
          );
          extension = true;
        } catch {
          /* not built */
        }
        const integrity = registry.db.prepare("PRAGMA integrity_check").get();
        const ok =
          browser &&
          extension &&
          Number(process.versions.node.split(".")[0]) >= 24;
        output({
          ok,
          version: VERSION,
          node: process.versions.node,
          browserInstalled: browser,
          extensionBuilt: extension,
          database: integrity,
          grants: registry.policy().grants.length,
          authProfiles: registry.authProfiles().length,
          authSupported: process.platform !== "win32",
        });
        if (!ok) process.exitCode = 1;
        return;
      }
      case "policy": {
        const origin = originSchema.parse(values.origin),
          policy = registry.policy();
        policy.grants = policy.grants.filter((g) => g.origin !== origin);
        if (p[1] === "allow") {
          if (
            values.fixture &&
            (new URL(origin).hostname !== "127.0.0.1" ||
              !origin.startsWith("http:"))
          )
            fail("PRIVATE_NETWORK_BLOCKED");
          if (!values.fixture && !origin.startsWith("https:"))
            fail("ORIGIN_NOT_ALLOWED", "Remote origins require HTTPS.");
          policy.grants.push({ origin, fixture: values.fixture ?? false });
        } else if (p[1] !== "revoke") fail("PARAMETER_INVALID");
        registry.setPolicy(policy);
        output({
          policy,
          notice: "Policy changes invalidate verification and publication.",
        });
        return;
      }
      case "workflow": {
        switch (p[1]) {
          case "import": {
            const s = registry.import(await jsonFile(p[2]));
            output({
              ...s,
              notice:
                "Not trusted or authorized. Review the full workflow before trusting its hash.",
            });
            return;
          }
          case "list":
            output(registry.list());
            return;
          case "inspect": {
            const stored = get();
            output({
              ...stored,
              authentication: registry.describeAuthBinding(stored.hash),
            });
            return;
          }
          case "trust": {
            const s = get();
            if (!values.hash)
              fail(
                "PARAMETER_INVALID",
                "Use --hash with the exact hash after reviewing inspect output.",
              );
            registry.trust(s.workflow.slug, values.hash, s.workflow.version);
            output({ trusted: true, hash: s.hash });
            return;
          }
          case "verify": {
            const s = get();
            output(
              await verifyWorkflow(
                registry,
                s,
                await jsonFile(values.suite),
                s.workflow.policy.risk === "write" ||
                  s.workflow.policy.requiresApproval
                  ? approve
                  : undefined,
              ),
            );
            return;
          }
          case "publish": {
            const s = get();
            if (!values.version)
              fail(
                "PARAMETER_INVALID",
                "Publication requires an explicit --version.",
              );
            registry.publish(s.workflow.slug, s.workflow.version);
            output({
              published: true,
              tool: `wf_${s.workflow.slug}`,
              version: s.workflow.version,
              notice: "Restart the MCP server to refresh its tool list.",
            });
            return;
          }
          case "disable": {
            const s = get();
            registry.disable(s.workflow.slug);
            output({ disabled: true });
            return;
          }
          case "delete": {
            const s = get();
            registry.eraseWorkflow(s.workflow.slug);
            output({ deleted: true });
            return;
          }
          case "run": {
            const s = get();
            output(
              await runWorkflow(registry, s, await jsonFile(values.input), {
                idempotencyKey: values["idempotency-key"],
              }),
            );
            return;
          }
          default:
            fail("PARAMETER_INVALID", "Unknown workflow command.");
        }
        break;
      }
      case "auth": {
        if (p[1] === "list") {
          output(
            registry.authProfiles().map((profile) => ({
              ...profile,
              status:
                profile.status === "READY" && profile.expiresAt <= Date.now()
                  ? "EXPIRED"
                  : profile.status,
            })),
          );
          return;
        }
        if (p[1] === "bind") {
          if (!values.profile) fail("PARAMETER_INVALID", "Specify --profile.");
          const stored = get();
          registry.bindAuth(stored, values.profile);
          output({
            bound: true,
            profile: values.profile,
            hash: stored.hash,
            notice:
              "Verify and publish this revision again; restart MCP after authentication changes.",
          });
          return;
        }
        if (p[1] === "unbind") {
          const stored = get();
          registry.unbindAuth(stored);
          output({
            bound: false,
            hash: stored.hash,
            notice: "Verify and publish again before anonymous execution.",
          });
          return;
        }
        if (!p[2])
          fail("PARAMETER_INVALID", "Authentication profile name required.");
        if (p[1] === "inspect") {
          output(registry.authProfile(p[2]));
          return;
        }
        if (p[1] === "revoke") {
          await revokeProfile(registry, p[2]);
          output({
            revoked: true,
            profile: p[2],
            notice:
              "Local encrypted state removed; this does not log out other browsers or revoke website tokens remotely.",
          });
          return;
        }
        if (p[1] !== "login")
          fail("PARAMETER_INVALID", "Unknown authentication command.");
        if (!process.stdin.isTTY || !process.stdout.isTTY)
          fail(
            "PERMISSION_DENIED",
            "Login requires an interactive local terminal and a visible dedicated browser.",
          );
        if (values["auth-post-url"]?.length)
          fail(
            "AUTH_POST_UNSUPPORTED",
            "Read workflows and login restoration checks permit GET/HEAD only. Authentication POST exceptions are unavailable.",
          );
        const prior = registry.authProfile(p[2], true);
        const changed = [
          "url",
          "check-url",
          "check-test-id",
          "check-label",
          "check-role",
          "check-name",
          "ttl-hours",
          "auth-origin",
          "auth-post-url",
        ].some((key) => values[key as keyof typeof values] !== undefined);
        let parsed: ReturnType<typeof authConfigSchema.safeParse>;
        if (prior && !changed) parsed = authConfigSchema.safeParse(prior.config);
        else {
          if (
            ["check-test-id", "check-label", "check-role"].filter((key) =>
              Boolean(values[key as keyof typeof values]),
            ).length !== 1 ||
            (values["check-name"] && !values["check-role"])
          )
            fail(
              "PARAMETER_INVALID",
              "Choose one authenticated marker: --check-test-id, --check-label, or --check-role with --check-name.",
            );
          let origin: string;
          try {
            origin = new URL(values.url ?? "").origin;
          } catch {
            fail("AUTH_PROFILE_INVALID", "Specify a clean HTTP(S) login URL.");
          }
          const locator = values["check-test-id"]
            ? { strategy: "testId", value: values["check-test-id"] }
            : values["check-label"]
              ? { strategy: "label", value: values["check-label"] }
              : {
                  strategy: "role",
                  role: values["check-role"],
                  name: values["check-name"],
                };
          parsed = authConfigSchema.safeParse({
            id: p[2],
            loginUrl: values.url,
            allowedOrigins: [
              ...new Set([origin, ...(values["auth-origin"] ?? [])]),
            ],
            check: { url: values["check-url"], locator },
            ttlHours: Number(values["ttl-hours"] ?? 8),
            authPostUrls: values["auth-post-url"] ?? [],
          });
          if (!parsed.success)
            fail(
              "AUTH_PROFILE_INVALID",
              "Check the profile name, approved origins, login/check URLs, marker and TTL (up to 168 hours).",
            );
        }
        if (!parsed.success)
          fail("AUTH_PROFILE_INVALID", "Invalid saved authentication profile.");
        const cancel = new AbortController(),
          onCancel = () => cancel.abort(),
          terminal = createInterface({
            input: process.stdin,
            output: process.stderr,
          });
        terminal.once("SIGINT", onCancel);
        process.once("SIGINT", onCancel);
        process.once("SIGTERM", onCancel);
        let login: Awaited<ReturnType<typeof beginLogin>> | undefined;
        try {
          process.stderr.write(
            `Profile: ${parsed.data.id}\nLogin: ${parsed.data.loginUrl}\nAllowed origins: ${parsed.data.allowedOrigins.join(", ")}\nA separate browser will open. Complete login/MFA there. No credentials are read from your primary Chrome profile.\n`,
          );
          login = await beginLogin(registry, parsed.data, {
            signal: cancel.signal,
          });
          login.page.once("close", onCancel);
          await terminal.question(
            "After login, press Enter to verify and save the encrypted session (Ctrl+C cancels): ",
            { signal: cancel.signal },
          );
          const profile = await login.save();
          output({
            saved: true,
            ...profile,
            notice:
              "Bind this profile to a reviewed workflow, verify and publish it. Renewing login invalidates existing bindings until reverified.",
          });
        } catch (e) {
          if (cancel.signal.aborted)
            fail(
              "AUTH_LOGIN_CANCELLED",
              "Login cancelled. No new session was authorized.",
            );
          throw e;
        } finally {
          process.removeListener("SIGINT", onCancel);
          process.removeListener("SIGTERM", onCancel);
          terminal.close();
          await login?.close();
        }
        return;
      }
      case "approval":
        if (p[1] !== "grant") fail("PARAMETER_INVALID");
        output({
          approved: true,
          nonce: await approve(await jsonFile(values.input)),
          expiresInSeconds: 60,
        });
        return;
      case "run":
        if (p[1] !== "inspect" || !p[2]) fail("PARAMETER_INVALID");
        output(registry.inspectRun(p[2]));
        return;
      case "privacy":
        if (p[1] !== "erase-audit") fail("PARAMETER_INVALID");
        registry.eraseAudit();
        output({ erased: true });
        return;
      case "serve":
        if (!values.stdio)
          fail("PARAMETER_INVALID", "Only --stdio transport is supported.");
        serve(registry);
        serving = true;
        return;
      default:
        fail("PARAMETER_INVALID", "Unknown command. Use --help.");
    }
  } finally {
    if (!serving) registry.close();
  }
}
void main().catch((e) => {
  process.stderr.write(JSON.stringify({ error: safeError(e) }) + "\n");
  process.exitCode = 1;
});
