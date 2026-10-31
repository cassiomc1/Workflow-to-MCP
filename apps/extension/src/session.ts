import { z } from "zod";
import {
  legacyLocatorSchema,
  legacyStepSchema,
  originSchema,
} from "../../../packages/workflow-schema/src/index.js";
export const sessionSchema = z.strictObject({
  id: z.string().uuid(),
  tabId: z.number().int(),
  origin: originSchema,
  state: z.enum(["RECORDING", "PAUSED", "REVIEW", "INTERRUPTED"]),
  createdAt: z.iso.datetime(),
  steps: z.array(legacyStepSchema).max(100),
  eventIds: z.array(z.string().uuid()).max(200),
  sequences: z.record(z.string(), z.number().int().min(0)),
  safeFields: z.array(legacyLocatorSchema).max(30),
  selections: z.array(legacyLocatorSchema).max(30),
  mode: z.enum(["none", "field", "output"]),
  warnings: z.array(z.string().max(200)).max(30),
});
export type Session = z.infer<typeof sessionSchema>;
export const captureSchema = z.strictObject({
  type: z.literal("capture"),
  sessionId: z.string().uuid(),
  eventId: z.string().uuid(),
  sequence: z.number().int().positive(),
  timestamp: z.number().int(),
  step: legacyStepSchema,
});
export function validSender(
  session: Session,
  sender: chrome.runtime.MessageSender,
): boolean {
  try {
    return (
      sender.id === chrome.runtime.id &&
      sender.tab?.id === session.tabId &&
      sender.frameId === 0 &&
      new URL(sender.url ?? "").origin === session.origin &&
      Boolean(sender.documentId)
    );
  } catch {
    return false;
  }
}
