import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  lstat,
  open,
  rename,
  unlink,
  readdir,
  link,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { name } from "../../workflow-schema/src/index.js";
import { fail } from "../../shared/src/index.js";
import { authStateSchema, type AuthState } from "./schema.js";
const envelopeSchema = z.strictObject({
  version: z.literal(1),
  iv: z.string().regex(/^[0-9a-f]{24}$/),
  tag: z.string().regex(/^[0-9a-f]{32}$/),
  data: z.string().max(15000000),
});
export const MAX_AUTH_BYTES = 10 * 1024 * 1024;
// This is a local-user security boundary, not an OS keychain. The encryption key
// stays in its own owner-only file and never enters SQLite, workflow JSON or logs.
export class AuthStore {
  readonly directory: string;
  constructor(home: string) {
    this.directory = join(home, "auth");
  }
  private async securePath(path: string, directory = false) {
    const info = await lstat(path);
    if (
      info.isSymbolicLink() ||
      (directory ? !info.isDirectory() : !info.isFile()) ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      fail(
        "AUTH_STORAGE_UNSAFE",
        "Authentication storage requires an owner-only directory and files.",
      );
    return info;
  }
  async initialize() {
    if (process.platform === "win32")
      fail(
        "AUTH_STORAGE_UNSUPPORTED",
        "Authentication profiles currently require POSIX owner-only file permissions.",
      );
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.securePath(this.directory, true);
  }
  private file(id: string, generation: string) {
    if (!name.safeParse(id).success || !z.uuid().safeParse(generation).success)
      fail("AUTH_PROFILE_INVALID");
    return join(this.directory, `${id}.${generation}.enc`);
  }
  private async key(create: boolean): Promise<Buffer> {
    await this.initialize();
    const path = join(this.directory, ".key");
    try {
      const info = await this.securePath(path);
      if (info.size !== 32) fail("AUTH_STORAGE_UNSAFE");
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        return await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      if (!create)
        fail(
          "AUTH_STATE_UNAVAILABLE",
          "Authentication encryption key is missing. Log in again.",
        );
      const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`,
        key = randomBytes(32);
      let created = false;
      try {
        const handle = await open(
          temporary,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY |
            constants.O_NOFOLLOW,
          0o600,
        );
        created = true;
        try {
          await handle.writeFile(key);
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await link(temporary, path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      } finally {
        key.fill(0);
        if (created) await unlink(temporary);
      }
      return this.key(false);
    }
  }
  async write(id: string, generation: string, state: AuthState) {
    const parsed = authStateSchema.parse(state),
      data = Buffer.from(JSON.stringify(parsed));
    if (data.length > MAX_AUTH_BYTES) fail("AUTH_STATE_TOO_LARGE");
    const key = await this.key(true),
      iv = randomBytes(12),
      aad = Buffer.from(`workflow-auth-v1/${id}/${generation}`);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    key.fill(0);
    data.fill(0);
    const body = JSON.stringify({
      version: 1,
      iv: iv.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
      data: encrypted.toString("base64"),
    });
    const target = this.file(id, generation),
      temp = `${target}.${randomBytes(8).toString("hex")}.tmp`;
    const handle = await open(
      temp,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      try {
        await handle.writeFile(body);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, target);
    } catch (e) {
      await unlink(temp).catch(() => {});
      throw e;
    }
  }
  async read(id: string, generation: string): Promise<AuthState> {
    const key = await this.key(false);
    try {
      const path = this.file(id, generation),
        info = await this.securePath(path);
      if (info.size > MAX_AUTH_BYTES * 1.5) fail("AUTH_STATE_TOO_LARGE");
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let body: string;
      try {
        body = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
      const envelope = envelopeSchema.parse(JSON.parse(body));
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(envelope.iv, "hex"),
      );
      decipher.setAAD(Buffer.from(`workflow-auth-v1/${id}/${generation}`));
      decipher.setAuthTag(Buffer.from(envelope.tag, "hex"));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(envelope.data, "base64")),
        decipher.final(),
      ]);
      try {
        return authStateSchema.parse(JSON.parse(plain.toString("utf8")));
      } finally {
        plain.fill(0);
      }
    } catch (e) {
      if (
        e instanceof Error &&
        "code" in e &&
        String(e.code).startsWith("AUTH_")
      )
        throw e;
      fail(
        "AUTH_STATE_UNAVAILABLE",
        "Saved authentication state is missing or invalid. Log in again.",
      );
    } finally {
      key.fill(0);
    }
  }
  async remove(id: string, generation: string) {
    await this.initialize();
    await unlink(this.file(id, generation)).catch((e) => {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    });
  }
  async eraseProfile(id: string) {
    if (!name.safeParse(id).success) fail("AUTH_PROFILE_INVALID");
    await this.initialize();
    for (const file of await readdir(this.directory))
      if (
        file.startsWith(`${id}.`) &&
        (file.endsWith(".enc") || file.endsWith(".tmp"))
      )
        await unlink(join(this.directory, file));
  }
}
