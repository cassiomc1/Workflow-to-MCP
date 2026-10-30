import { z } from "zod";
import {
  name,
  originSchema,
  locatorSchema,
} from "../../workflow-schema/src/index.js";
export const authUrlSchema = z
  .string()
  .max(2048)
  .refine((raw) => {
    try {
      const u = new URL(raw);
      return (
        ["http:", "https:"].includes(u.protocol) &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash
      );
    } catch {
      return false;
    }
  });
export const authConfigSchema = z
  .strictObject({
    id: name,
    allowedOrigins: z
      .array(originSchema)
      .min(1)
      .max(8)
      .refine((v) => new Set(v).size === v.length),
    loginUrl: authUrlSchema,
    check: z.strictObject({ url: authUrlSchema, locator: locatorSchema }),
    // Reserved until every HTTPS redirect hop can be checked before submission.
    authPostUrls: z.array(authUrlSchema).max(0).default([]),
    ttlHours: z
      .number()
      .min(1 / 60)
      .max(168)
      .default(8),
  })
  .superRefine((p, ctx) => {
    if (
      ![p.loginUrl, p.check.url, ...p.authPostUrls].every((url) =>
        p.allowedOrigins.includes(new URL(url).origin),
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Authentication URLs need explicit approved origins.",
      });
  });
export type AuthConfig = z.infer<typeof authConfigSchema>;
export interface AuthProfile {
  config: AuthConfig;
  generation: string;
  expiresAt: number;
  createdAt: string;
  status: "READY" | "REVOKED";
}
export const browserStateSchema = z.strictObject({
  cookies: z
    .array(
      z.strictObject({
        name: z.string().max(256),
        value: z.string().max(16384),
        domain: z.string().max(256),
        path: z.string().max(2048),
        expires: z.number().finite(),
        httpOnly: z.boolean(),
        secure: z.boolean(),
        sameSite: z.enum(["Strict", "Lax", "None"]),
        partitionKey: z.string().optional(),
      }),
    )
    .max(500),
  origins: z
    .array(
      z.strictObject({
        origin: originSchema,
        localStorage: z
          .array(
            z.strictObject({
              name: z.string().max(1024),
              value: z.string().max(1048576),
            }),
          )
          .max(2000),
        indexedDB: z.array(z.unknown()).max(100).optional(),
      }),
    )
    .max(8),
});
export const sessionValuesSchema = z
  .array(
    z.strictObject({
      origin: originSchema,
      values: z
        .array(z.tuple([z.string().max(1024), z.string().max(1048576)]))
        .max(2000),
    }),
  )
  .max(8);
export const authStateSchema = z.strictObject({
  storage: browserStateSchema,
  session: sessionValuesSchema,
});
export type AuthState = z.infer<typeof authStateSchema>;
