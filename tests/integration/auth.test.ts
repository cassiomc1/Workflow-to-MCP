import { it, expect, describe } from "vitest";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { authenticatedSetup, loginFixture } from "../auth-helpers.js";
import { runWorkflow, localActor } from "../../packages/runner/src/index.js";
import { verifyWorkflow } from "../../packages/testing/src/verify.js";
import { AuthStore } from "../../packages/auth/src/store.js";
import { revokeProfile } from "../../packages/auth/src/session.js";
describe.skipIf(process.platform === "win32")(
  "dedicated authentication",
  () => {
    it("manual browser login captures HttpOnly/LS/sessionStorage/IndexedDB; replay and real MCP use an encrypted local binding", async () => {
      const s = await authenticatedSetup();
      let client: Client | undefined;
      try {
        const profile = await loginFixture(s),
          store = new AuthStore(s.directory),
          state = await store.read(profile.config.id, profile.generation);
        expect(
          state.storage.cookies.some(
            (c) => c.name === "wf_demo_sid" && c.httpOnly,
          ),
        ).toBe(true);
        expect(
          state.storage.origins.some(
            (o) => o.localStorage.length && o.indexedDB?.length,
          ),
        ).toBe(true);
        expect(
          state.session.some((o) =>
            o.values.some(([key]) => key === "demo_session_token"),
          ),
        ).toBe(true);
        s.registry.bindAuth(s.stored, profile.config.id);
        const suite = JSON.parse(
          await readFile("examples/demo-crm-lookup/cases.json", "utf8"),
        );
        expect((await verifyWorkflow(s.registry, s.stored, suite)).passed).toBe(
          3,
        );
        s.registry.publish(s.stored.workflow.slug, s.stored.workflow.version);
        client = new Client({ name: "authenticated-client", version: "1.0.0" });
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [
              resolve("dist/cli.js"),
              "serve",
              "--stdio",
              "--home",
              s.directory,
            ],
            stderr: "pipe",
          }),
        );
        const result = await client.callTool({
          name: "wf_lookup_support_ticket",
          arguments: { ticket_id: "TICKET-1002" },
        });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual(suite.cases[1].expected);
        const database = await readFile(join(s.directory, "registry.sqlite"));
        const ciphertext = await readFile(
          join(
            store.directory,
            `${profile.config.id}.${profile.generation}.enc`,
          ),
        );
        for (const secret of s.demo.authentication.secrets()) {
          expect(database.includes(Buffer.from(secret))).toBe(false);
          expect(ciphertext.includes(Buffer.from(secret))).toBe(false);
          expect(JSON.stringify(s.registry.list())).not.toContain(secret);
        }
        expect(JSON.stringify(s.stored.workflow)).not.toContain("demo_session");
        s.demo.authentication.expireAll();
        const expired = await client.callTool({
          name: "wf_lookup_support_ticket",
          arguments: { ticket_id: "TICKET-1001" },
        });
        expect(expired.isError).toBe(true);
        expect(JSON.stringify(expired)).toContain("AUTHENTICATION_REQUIRED");
      } finally {
        await client?.close();
        await s.close();
      }
    });
    it("TTL expiry, local revocation and cross-origin binding fail before browser allocation", async () => {
      const s = await authenticatedSetup();
      const states: string[] = [];
      try {
        const profile = await loginFixture(s);
        s.registry.bindAuth(s.stored, profile.config.id);
        s.registry.db
          .prepare("UPDATE auth_profiles SET expires_at=? WHERE id=?")
          .run(Date.now() - 1, profile.config.id);
        await expect(
          runWorkflow(
            s.registry,
            s.stored,
            { ticket_id: "TICKET-1001" },
            { verification: true, lifecycle: (v) => states.push(v) },
          ),
        ).rejects.toMatchObject({ code: "AUTH_SESSION_EXPIRED" });
        s.registry.db
          .prepare("UPDATE auth_profiles SET expires_at=? WHERE id=?")
          .run(Date.now() + 60000, profile.config.id);
        const other = s.registry.import({
          ...s.stored.workflow,
          version: "1.1.1",
          entrypoint: "https://other.example/",
          steps: [
            {
              id: "s1",
              kind: "navigate",
              url: "https://other.example/",
              timeoutMs: 1000,
            },
          ],
          inputSchema: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
          policy: {
            ...s.stored.workflow.policy,
            allowedOrigins: ["https://other.example"],
          },
        });
        s.registry.trust(
          other.workflow.slug,
          other.hash,
          other.workflow.version,
        );
        expect(() => s.registry.bindAuth(other, profile.config.id)).toThrow();
        await revokeProfile(s.registry, profile.config.id);
        await expect(
          runWorkflow(
            s.registry,
            s.stored,
            { ticket_id: "TICKET-1001" },
            { verification: true, lifecycle: (v) => states.push(v) },
          ),
        ).rejects.toMatchObject({ code: "AUTH_PROFILE_REVOKED" });
        await expect(
          new AuthStore(s.directory).read(
            profile.config.id,
            profile.generation,
          ),
        ).rejects.toMatchObject({ code: "AUTH_STATE_UNAVAILABLE" });
        expect(states).toEqual([]);
      } finally {
        await s.close();
      }
    });
    it("a live profile lease prevents concurrent use and a replacement invalidates verification and approval", async () => {
      const s = await authenticatedSetup(true),
        input = { summary: "Synthetic authenticated write" };
      try {
        const profile = await loginFixture(s);
        s.registry.bindAuth(s.stored, profile.config.id);
        const lease = s.registry.acquireAuthLease(profile.config.id);
        await expect(
          runWorkflow(s.registry, s.stored, input, { verification: true }),
        ).rejects.toMatchObject({ code: "AUTH_PROFILE_BUSY" });
        s.registry.releaseAuthLease(profile.config.id, lease);
        const suite = {
          version: 1,
          cases: [{ input, expected: { created_id: "AUTH-CREATED-1" } }],
        };
        await verifyWorkflow(s.registry, s.stored, suite, async (v) =>
          s.registry.approve(s.stored, v, localActor()),
        );
        s.registry.publish(s.stored.workflow.slug, s.stored.workflow.version);
        const approval = s.registry.approve(s.stored, input, localActor());
        const renewed = await loginFixture(s);
        expect(renewed.generation).not.toBe(profile.generation);
        expect(
          s.registry.get(s.stored.workflow.slug, s.stored.workflow.version)
            .verified,
        ).toBe(false);
        expect(s.registry.published()).toEqual([]);
        expect(() =>
          s.registry.consumeApproval(s.stored, input, localActor(), approval),
        ).toThrow();
        expect(s.demo.authentication.writes).toBe(1);
      } finally {
        await s.close();
      }
    });
  },
);
