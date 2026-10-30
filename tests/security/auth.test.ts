import { it, expect, describe } from "vitest";
import { authenticatedSetup, loginFixture } from "../auth-helpers.js";
import { runWorkflow } from "../../packages/runner/src/index.js";
import { beginLogin } from "../../packages/auth/src/session.js";
import { authConfigSchema } from "../../packages/auth/src/schema.js";
describe.skipIf(process.platform === "win32")(
  "authentication permissions",
  () => {
    it("blocks authentication-refresh and business POSTs in read workflows", async () => {
      const s = await authenticatedSetup();
      try {
        const w = {
          ...s.stored.workflow,
          version: "1.1.1",
          entrypoint: s.demo.origin + "/auth/refresh-on-view",
          inputSchema: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: { result: { type: "string" } },
            required: ["result"],
            additionalProperties: false,
          },
          steps: [
            {
              id: "s1",
              kind: "waitForVisible",
              locator: { strategy: "testId", value: "refresh-done" },
              timeoutMs: 1000,
            },
            {
              id: "s2",
              kind: "extract",
              locator: { strategy: "testId", value: "refresh-done" },
              field: "result",
              mode: "textContent",
              allowMissing: false,
              timeoutMs: 1000,
            },
          ],
        };
        const stored = s.registry.import(w);
        s.registry.trust(w.slug, stored.hash, w.version);
        const initial = await loginFixture(s);
        s.registry.bindAuth(stored, initial.config.id);
        await expect(
          runWorkflow(s.registry, stored, {}, { verification: true }),
        ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
        expect(s.demo.authentication.refreshes).toBe(0);
        expect(
          authConfigSchema.safeParse({
            ...initial.config,
            authPostUrls: [s.demo.origin + "/auth/refresh"],
          }).success,
        ).toBe(false);
        const unsafe = s.registry.import({
          ...w,
          version: "1.1.2",
          entrypoint: s.demo.origin + "/auth/create",
          outputSchema: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
          steps: [
            {
              id: "s1",
              kind: "click",
              locator: {
                strategy: "role",
                role: "button",
                name: "Create authenticated ticket",
              },
              timeoutMs: 1000,
            },
            {
              id: "s2",
              kind: "waitForVisible",
              locator: { strategy: "testId", value: "created-id" },
              timeoutMs: 500,
            },
          ],
        });
        s.registry.trust(w.slug, unsafe.hash, "1.1.2");
        s.registry.bindAuth(unsafe, initial.config.id);
        await expect(
          runWorkflow(s.registry, unsafe, {}, { verification: true }),
        ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
        expect(s.demo.authentication.writes).toBe(0);
      } finally {
        await s.close();
      }
    });
    it("unsuccessful login does not replace an existing authentication session", async () => {
      const s = await authenticatedSetup();
      try {
        const profile = await loginFixture(s),
          login = await beginLogin(s.registry, profile.config, {
            headless: true,
          });
        try {
          await expect(login.save()).rejects.toMatchObject({
            code: "AUTHENTICATION_REQUIRED",
          });
        } finally {
          await login.close();
        }
        expect(s.registry.authProfile(profile.config.id)?.generation).toBe(
          profile.generation,
        );
        s.registry.bindAuth(s.stored, profile.config.id);
        expect(
          (
            await runWorkflow(
              s.registry,
              s.stored,
              { ticket_id: "TICKET-1001" },
              { verification: true },
            )
          ).data.found,
        ).toBe(true);
      } finally {
        await s.close();
      }
    });
    it("revocation terminates an active authenticated browser and releases its lease", async () => {
      const s = await authenticatedSetup();
      try {
        const profile = await loginFixture(s);
        s.registry.bindAuth(s.stored, profile.config.id);
        const states: string[] = [];
        await expect(
          runWorkflow(
            s.registry,
            s.stored,
            { ticket_id: "TICKET-1001" },
            {
              verification: true,
              lifecycle: (state) => {
                states.push(state);
                if (state === "opened")
                  s.registry.revokeAuth(profile.config.id);
              },
            },
          ),
        ).rejects.toMatchObject({ code: "AUTH_PROFILE_REVOKED" });
        expect(states).toEqual(["opened", "closed"]);
        expect(
          s.registry.db
            .prepare("SELECT COUNT(*) AS count FROM auth_leases")
            .get()?.count,
        ).toBe(0);
      } finally {
        await s.close();
      }
    });
  },
);
