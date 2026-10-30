import { it, expect, vi } from "vitest";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { authorizeUrl } from "../../packages/policy/src/index.js";
import { createGuardProxy } from "../../packages/policy/src/proxy.js";
import { fixtureWorkflow } from "../helpers.js";

vi.mock("../../packages/policy/src/index.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../packages/policy/src/index.js")
  >()),
  authorizeUrl: vi.fn(),
}));

it.each(["http", "connect"] as const)(
  "does not allocate an upstream after %s authorization resumes past proxy shutdown",
  async (mode) => {
    const origin = "https://approved.example.test";
    let release!: (value: Awaited<ReturnType<typeof authorizeUrl>>) => void;
    let entered!: () => void;
    const pending = new Promise<Awaited<ReturnType<typeof authorizeUrl>>>(
      (resolve) => {
        release = resolve;
      },
    );
    const observed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.mocked(authorizeUrl).mockImplementation(() => {
      entered();
      return pending;
    });
    const workflow = await fixtureWorkflow(origin);
    const proxy = await createGuardProxy(
      workflow,
      { version: 1, grants: [{ origin, fixture: false }] },
      () => {},
    );
    const dial =
      mode === "connect"
        ? vi.spyOn(net, "connect")
        : vi.spyOn(http, "request");
    // A failing regression must never dial a real upstream, even briefly.
    dial.mockImplementation(() => {
      throw new Error("Unexpected upstream allocation after shutdown");
    });
    const client = new net.Socket();
    client.on("error", () => {});
    try {
      const connected = once(client, "connect");
      client.connect(Number(new URL(proxy.config.server).port), "127.0.0.1");
      await connected;
      const credentials = Buffer.from(
        `${proxy.config.username}:${proxy.config.password}`,
      ).toString("base64");
      const target =
        mode === "connect"
          ? "CONNECT approved.example.test:443 HTTP/1.1"
          : "GET http://approved.example.test/ HTTP/1.1";
      client.write(
        `${target}\r\nHost: approved.example.test\r\nProxy-Authorization: Basic ${credentials}\r\n\r\n`,
      );
      await observed;
      await proxy.close();
      release({
        url: new URL(
          mode === "connect" ? origin : "http://approved.example.test/",
        ),
        address: "127.0.0.1",
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(dial).not.toHaveBeenCalled();
    } finally {
      await proxy.close();
      release({ url: new URL(origin), address: "127.0.0.1" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      client.destroy();
      dial.mockRestore();
      vi.mocked(authorizeUrl).mockReset();
    }
  },
);
