import http from "node:http";
import net from "node:net";
import { randomBytes } from "node:crypto";
import type { Workflow } from "../../workflow-schema/src/index.js";
import {
  authorizeUrl,
  permittedReadRequest,
  type InstallationPolicy,
} from "./index.js";
import { WorkflowError } from "../../shared/src/index.js";

// All browser HTTP(S) traffic goes through this per-run proxy. DNS is resolved and
// validated here; the actual upstream connection uses that IP, eliminating a second DNS lookup.
export async function createGuardProxy(
  workflow: Workflow,
  installation: InstallationPolicy,
  violation: (error: WorkflowError) => void,
) {
  const username = "workflow";
  const password = randomBytes(24).toString("hex");
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const sockets = new Set<net.Socket>();
  let stopped = false;
  let closing: Promise<void> | undefined;
  const server = http.createServer(async (req, res) => {
    if (req.headers["proxy-authorization"] !== auth) {
      res
        .writeHead(407, { "Proxy-Authenticate": 'Basic realm="workflow"' })
        .end();
      return;
    }
    try {
      const { url, address } = await authorizeUrl(
        req.url ?? "",
        workflow,
        installation,
      );
      // DNS can finish after cancellation has destroyed the client/listener.
      if (stopped || res.destroyed || req.socket.destroyed) return;
      if (url.protocol !== "http:")
        throw new WorkflowError("ORIGIN_NOT_ALLOWED");
      if (
        workflow.policy.risk === "read" &&
        !permittedReadRequest(req.method ?? "")
      )
        throw new WorkflowError(
          "PERMISSION_DENIED",
          "Read workflows cannot send mutating HTTP methods.",
        );
      const headers: http.OutgoingHttpHeaders = {
        ...req.headers,
        host: url.host,
      };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      const upstream = http.request(
        {
          host: address,
          port: url.port || 80,
          method: req.method,
          path: url.pathname + url.search,
          headers,
          timeout: 30000,
          agent: false,
        },
        (response) => {
          void (async () => {
            if (
              response.headers.location &&
              (response.statusCode ?? 0) >= 300 &&
              (response.statusCode ?? 0) < 400
            ) {
              try {
                await authorizeUrl(
                  new URL(response.headers.location, url).href,
                  workflow,
                  installation,
                );
              } catch {
                violation(
                  new WorkflowError(
                    "ORIGIN_NOT_ALLOWED",
                    "Redirect destination is not approved.",
                  ),
                );
                response.destroy();
                res.writeHead(403).end();
                return;
              }
            }
            res.writeHead(response.statusCode ?? 502, response.headers);
            response.pipe(res);
          })();
        },
      );
      upstream.on("socket", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      res.on("close", () => upstream.destroy());
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      upstream.on("timeout", () => upstream.destroy());
      req.pipe(upstream);
    } catch (e) {
      violation(
        e instanceof WorkflowError
          ? e
          : new WorkflowError("ORIGIN_NOT_ALLOWED"),
      );
      res.writeHead(403).end();
    }
  });
  server.on("connection", (socket) => {
    if (stopped) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("connect", async (req, socket, head) => {
    if (req.headers["proxy-authorization"] !== auth) {
      socket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="workflow"\r\n\r\n',
      );
      return;
    }
    try {
      const { url, address } = await authorizeUrl(
        `https://${req.url}/`,
        workflow,
        installation,
      );
      if (stopped || socket.destroyed) return;
      const upstream = net.connect({
        host: address,
        port: Number(url.port || 443),
        timeout: 30000,
      });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("connect", () => {
        if (stopped || socket.destroyed) {
          upstream.destroy();
          return;
        }
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.on("error", () => socket.destroy());
      upstream.on("timeout", () => upstream.destroy());
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
    } catch (e) {
      violation(
        e instanceof WorkflowError
          ? e
          : new WorkflowError("ORIGIN_NOT_ALLOWED"),
      );
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as net.AddressInfo;
  return {
    config: { server: `http://127.0.0.1:${address.port}`, username, password },
    close() {
      stopped = true;
      return (closing ??= new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }));
    },
  };
}
