import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import {
  originSchema,
  type Workflow,
} from "../../workflow-schema/src/index.js";
import { fail } from "../../shared/src/index.js";
export const grantSchema = z.strictObject({
  origin: originSchema,
  fixture: z.boolean(),
});
export const installationSchema = z.strictObject({
  version: z.literal(1),
  grants: z.array(grantSchema).max(50),
});
export type InstallationPolicy = z.infer<typeof installationSchema>;
// Public unicast only. IPv6 is deliberately unsupported until a comparable address classifier is tested.
export function privateAddress(address: string): boolean {
  if (isIP(address) !== 4) return true;
  const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || b === 2)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}
export async function authorizeUrl(
  raw: string,
  w: Workflow,
  installation: InstallationPolicy,
): Promise<{ url: URL; address: string }> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return fail("ORIGIN_NOT_ALLOWED");
  }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    fail("ORIGIN_NOT_ALLOWED");
  if (!w.policy.allowedOrigins.includes(u.origin)) fail("ORIGIN_NOT_ALLOWED");
  const grant = installation.grants.find((g) => g.origin === u.origin);
  if (!grant)
    fail("PERMISSION_DENIED", "Origin needs explicit local CLI authorization.");
  if (grant.fixture) {
    if (u.hostname !== "127.0.0.1" || u.protocol !== "http:")
      fail(
        "PRIVATE_NETWORK_BLOCKED",
        "Fixture grants are limited to exact HTTP IPv4 loopback origins.",
      );
    return { url: u, address: "127.0.0.1" };
  }
  if (u.protocol !== "https:")
    fail("ORIGIN_NOT_ALLOWED", "Remote sites require HTTPS.");
  const addresses = isIP(u.hostname)
    ? [{ address: u.hostname, family: isIP(u.hostname) }]
    : await lookup(u.hostname, { all: true, verbatim: true, family: 4 }).catch(
        () => fail("ORIGIN_NOT_ALLOWED", "Host resolution failed."),
      );
  if (!addresses.length || addresses.some((a) => privateAddress(a.address)))
    fail("PRIVATE_NETWORK_BLOCKED");
  return { url: u, address: addresses[0]!.address };
}
export function permittedReadRequest(method: string): boolean {
  return ["GET", "HEAD"].includes(method);
}
