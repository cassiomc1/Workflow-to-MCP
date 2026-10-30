import { describe, it, expect } from "vitest";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  stat,
  chmod,
  symlink,
  unlink,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AuthStore } from "../../packages/auth/src/store.js";
import {
  scopedState,
  credentialRedactor,
} from "../../packages/auth/src/session.js";
import type { AuthState } from "../../packages/auth/src/schema.js";
import type { Page } from "playwright";
import { executeStep } from "../../packages/compiler/src/index.js";
const state: AuthState = {
  storage: {
    cookies: [
      {
        name: "sid",
        value: "v9x_short!",
        domain: ".example.com",
        path: "/",
        expires: 2000000000,
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
      },
    ],
    origins: [
      {
        origin: "https://app.example.com",
        localStorage: [
          { name: "access_token", value: "synthetic-access-value" },
        ],
      },
    ],
  },
  session: [
    {
      origin: "https://app.example.com",
      values: [["session_token", "synthetic-session-value"]],
    },
  ],
};
describe.skipIf(process.platform === "win32")(
  "encrypted authentication store",
  () => {
    it("encrypts authenticated state with a fresh IV, owner-only files and contextual integrity", async () => {
      const dir = await mkdtemp(join(tmpdir(), "auth-vault-")),
        store = new AuthStore(dir),
        generation = randomUUID();
      try {
        await store.write("account", generation, state);
        expect(await store.read("account", generation)).toEqual(state);
        const path = join(store.directory, `account.${generation}.enc`),
          encrypted = await readFile(path, "utf8");
        expect(encrypted).not.toContain("v9x_short!");
        expect(encrypted).not.toContain("app.example.com");
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect((await stat(store.directory)).mode & 0o777).toBe(0o700);
        expect((await stat(join(store.directory, ".key"))).mode & 0o777).toBe(
          0o600,
        );
        await store.write("account", generation, state);
        expect(await readFile(path, "utf8")).not.toBe(encrypted);
        await writeFile(
          join(store.directory, `other.${generation}.enc`),
          encrypted,
          { mode: 0o600 },
        );
        await expect(store.read("other", generation)).rejects.toMatchObject({
          code: "AUTH_STATE_UNAVAILABLE",
        });
        const body = JSON.parse(encrypted);
        body.tag = "00".repeat(16);
        await writeFile(path, JSON.stringify(body));
        await expect(store.read("account", generation)).rejects.toMatchObject({
          code: "AUTH_STATE_UNAVAILABLE",
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
    it("rejects symlinked keys and over-permissive files without following or repairing them", async () => {
      const dir = await mkdtemp(join(tmpdir(), "auth-permissions-")),
        store = new AuthStore(dir),
        generation = randomUUID();
      try {
        await store.write("account", generation, state);
        const path = join(store.directory, `account.${generation}.enc`);
        await chmod(path, 0o644);
        await expect(store.read("account", generation)).rejects.toMatchObject({
          code: "AUTH_STORAGE_UNSAFE",
        });
        await chmod(path, 0o600);
        await unlink(join(store.directory, ".key"));
        const outside = join(dir, "other-key");
        await writeFile(outside, Buffer.alloc(32), { mode: 0o600 });
        await symlink(outside, join(store.directory, ".key"));
        await expect(store.read("account", generation)).rejects.toMatchObject({
          code: "AUTH_STORAGE_UNSAFE",
        });
        expect(await readFile(outside)).toEqual(Buffer.alloc(32));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
    it("initializes one complete encryption key under concurrent saves and erases profile ciphertext", async () => {
      const dir = await mkdtemp(join(tmpdir(), "auth-concurrent-")),
        store = new AuthStore(dir),
        a = randomUUID(),
        b = randomUUID();
      try {
        await Promise.all([
          store.write("one", a, state),
          store.write("two", b, state),
        ]);
        expect(await store.read("one", a)).toEqual(state);
        expect(await store.read("two", b)).toEqual(state);
        await store.eraseProfile("one");
        expect(
          (await readdir(store.directory)).some((f) => f.startsWith("one.")),
        ).toBe(false);
        expect(await store.read("two", b)).toEqual(state);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  },
);
it("narrows domain cookies, local/session storage to the exact approved scope and redacts known credentials", () => {
  const scoped = scopedState(state, ["https://app.example.com"]);
  expect(scoped.storage.cookies[0]?.domain).toBe("app.example.com");
  expect(
    scopedState(state, ["https://unrelated.test"]).storage.cookies,
  ).toEqual([]);
  expect(
    scopedState(state, ["https://unrelated.test"]).storage.origins,
  ).toEqual([]);
  expect(credentialRedactor(state)("secret=v9x_short!")).toBe(
    "secret=[REDACTED]",
  );
  expect(credentialRedactor(state)("synthetic-session-value")).toBe(
    "[REDACTED]",
  );
});
it("keeps host-only cookies on their original host while narrowing domain cookies", () => {
  const origins = [
    "https://example.com",
    "https://app.example.com",
    "https://unrelated.test",
  ];
  const hostOnly: AuthState = {
    ...state,
    storage: {
      ...state.storage,
      cookies: state.storage.cookies.map((cookie) => ({
        ...cookie,
        domain: "example.com",
      })),
    },
  };
  expect(
    scopedState(hostOnly, origins).storage.cookies.map((cookie) => cookie.domain),
  ).toEqual(["example.com"]);
  expect(
    scopedState(hostOnly, ["https://app.example.com"]).storage.cookies,
  ).toEqual([]);
  expect(
    scopedState(state, origins).storage.cookies.map((cookie) => cookie.domain),
  ).toEqual(["example.com", "app.example.com"]);
});
it("keeps extracted credential text raw until known-value redaction", async () => {
  const secret = "demo<sid>42";
  const auth: AuthState = {
    storage: {
      cookies: [],
      origins: [
        {
          origin: "https://app.example.com",
          localStorage: [{ name: "access_token", value: secret }],
        },
      ],
    },
    session: [],
  };
  const locator = {
    count: async () => 1,
    waitFor: async () => {},
    textContent: async () => secret,
  };
  const page = { getByTestId: () => locator } as unknown as Page;
  const output: Record<string, string | number | boolean | null> = {};
  await executeStep(
    page,
    {
      id: "s1",
      kind: "extract",
      locator: { strategy: "testId", value: "known-credential" },
      field: "result",
      mode: "textContent",
      allowMissing: false,
      timeoutMs: 1000,
    },
    {},
    output,
  );
  expect(output.result).toBe(secret);
  expect(credentialRedactor(auth)(String(output.result))).toBe("[REDACTED]");
});
it.runIf(process.platform === "win32")(
  "fails explicitly when owner-only authentication storage is unsupported",
  async () => {
    await expect(new AuthStore(tmpdir()).initialize()).rejects.toMatchObject({
      code: "AUTH_STORAGE_UNSUPPORTED",
    });
  },
);
