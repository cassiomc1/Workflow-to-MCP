import { z } from "zod";
import {
  canonicalize,
  locatorSchema,
  originSchema,
} from "../../../packages/workflow-schema/src/index.js";
import { safeCapturedStep } from "../../../packages/recorder-core/src/index.js";
import {
  sessionSchema,
  captureSchema,
  validSender,
  type Session,
} from "./session.js";
const adminSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("status") }),
  z.strictObject({
    type: z.literal("start"),
    tabId: z.number().int(),
    origin: originSchema,
  }),
  z.strictObject({
    type: z.enum([
      "pause",
      "resume",
      "stop",
      "erase",
      "choose-field",
      "choose-output",
    ]),
  }),
]);
async function read(): Promise<Session | null> {
  const stored = (await chrome.storage.local.get("session")).session;
  if (!stored) return null;
  const s = sessionSchema.safeParse(stored);
  if (!s.success) {
    await chrome.storage.local.remove("session");
    return null;
  }
  if (Date.now() - Date.parse(s.data.createdAt) > 86400000) {
    await chrome.storage.local.remove("session");
    return null;
  }
  return s.data;
}
async function save(s: Session) {
  await chrome.storage.local.set({ session: sessionSchema.parse(s) });
  await chrome.action.setBadgeText({
    text: s.state === "RECORDING" ? "REC" : s.state === "PAUSED" ? "II" : "",
  });
  await chrome.action.setBadgeBackgroundColor({ color: "#b3261e" });
}
async function inject(tabId: number) {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    files: ["content.js"],
  });
  const sync = await chrome.tabs.sendMessage(
    tabId,
    { type: "sync" },
    { frameId: 0 },
  );
  if (!sync?.ok) throw new Error("CONTENT_SCRIPT_SYNC_FAILED");
}
function trustedUI(sender: chrome.runtime.MessageSender): boolean {
  return (
    sender.id === chrome.runtime.id &&
    !sender.tab?.url?.startsWith("http") &&
    ["popup.html", "review.html"].some(
      (p) => sender.url === chrome.runtime.getURL(p),
    )
  );
}
async function handle(raw: unknown, sender: chrome.runtime.MessageSender) {
  if (JSON.stringify(raw).length > 16000) throw new Error("MESSAGE_TOO_LARGE");
  let session = await read();
  if (trustedUI(sender)) {
    const m = adminSchema.parse(raw);
    if (m.type === "status") return session;
    if (m.type === "erase") {
      await chrome.storage.local.remove("session");
      await chrome.action.setBadgeText({ text: "" });
      return null;
    }
    if (m.type === "start") {
      const tab = await chrome.tabs.get(m.tabId);
      if (new URL(tab.url ?? "").origin !== m.origin)
        throw new Error("RECORDING_NOT_AUTHORIZED");
      if (session?.state === "RECORDING")
        throw new Error("STOP_EXISTING_RECORDING");
      const u = new URL(tab.url!);
      if (u.search || u.hash || u.username || u.password)
        throw new Error("USE_A_URL_WITHOUT_QUERY_OR_FRAGMENT");
      session = {
        id: crypto.randomUUID(),
        tabId: m.tabId,
        origin: m.origin,
        state: "RECORDING",
        createdAt: new Date().toISOString(),
        steps: [{ id: "s1", kind: "navigate", url: u.href, timeoutMs: 15000 }],
        eventIds: [],
        sequences: {},
        safeFields: [],
        selections: [],
        mode: "none",
        warnings: [],
      };
      await save(session);
      await inject(m.tabId).catch(async () => {
        session!.state = "INTERRUPTED";
        await save(session!);
        throw new Error("RECORDING_NOT_AUTHORIZED");
      });
      return session;
    }
    if (!session) throw new Error("NO_RECORDING");
    if (m.type === "pause") session.state = "PAUSED";
    if (m.type === "resume") {
      if (!["PAUSED", "INTERRUPTED"].includes(session.state))
        throw new Error("INVALID_STATE");
      const tab = await chrome.tabs.get(session.tabId);
      if (new URL(tab.url ?? "").origin !== session.origin)
        throw new Error("ORIGIN_NOT_ALLOWED");
      session.state = "RECORDING";
    }
    if (m.type === "stop") {
      session.state = "REVIEW";
      session.mode = "none";
    }
    if (m.type === "choose-field" || m.type === "choose-output") {
      if (session.state !== "RECORDING")
        throw new Error("START_OR_RESUME_RECORDING");
      session.mode = m.type === "choose-field" ? "field" : "output";
    }
    await save(session);
    if (session.state === "RECORDING") await inject(session.tabId);
    return session;
  }
  if (!session || !validSender(session, sender))
    throw new Error("RECORDING_NOT_AUTHORIZED");
  if (session.state !== "RECORDING") return { ignored: true };
  const kind = (raw as { type?: unknown })?.type;
  if (kind === "hello") {
    z.strictObject({ type: z.literal("hello") }).parse(raw);
    return {
      sessionId: session.id,
      sequence: session.sequences[sender.documentId!] ?? 0,
    };
  }
  if (kind === "warning") {
    const m = z
      .strictObject({
        type: z.literal("warning"),
        code: z.enum([
          "SENSITIVE_VALUE_REDACTED",
          "FIELD_NOT_AUTHORIZED",
          "UNSUPPORTED_FRAME_ORIGIN",
          "UNSUPPORTED_CONTROL",
          "UNSUPPORTED_POPUP",
        ]),
      })
      .parse(raw);
    if (!session.warnings.includes(m.code)) session.warnings.push(m.code);
    await save(session);
    return { ok: true };
  }
  if (kind === "selection") {
    const m = z
      .strictObject({ type: z.literal("selection"), locator: locatorSchema })
      .parse(raw);
    if (session.mode === "none") throw new Error("SELECTION_NOT_REQUESTED");
    const list =
      session.mode === "field" ? session.safeFields : session.selections;
    if (!list.some((l) => canonicalize(l) === canonicalize(m.locator)))
      list.push(m.locator);
    session.mode = "none";
    await save(session);
    return { ok: true };
  }
  const m = captureSchema.parse(raw);
  if (m.sessionId !== session.id || Math.abs(Date.now() - m.timestamp) > 30000)
    throw new Error("RECORDING_NOT_AUTHORIZED");
  if (session.eventIds.includes(m.eventId))
    return { ok: true, duplicate: true };
  const previous = session.sequences[sender.documentId!] ?? 0;
  if (m.sequence !== previous + 1) {
    session.state = "INTERRUPTED";
    await save(session);
    throw new Error("RECORDING_INTERRUPTED");
  }
  const step = safeCapturedStep(m.step);
  if (!step) throw new Error("UNSAFE_CAPTURE");
  if (
    (step.kind === "fill" || step.kind === "select" || step.kind === "check") &&
    !session.safeFields.some(
      (l) => canonicalize(l) === canonicalize(step.locator),
    )
  )
    throw new Error("FIELD_NOT_AUTHORIZED");
  if (step.kind === "navigate" && new URL(step.url).origin !== session.origin)
    throw new Error("ORIGIN_NOT_ALLOWED");
  if (session.steps.length >= 100) {
    session.state = "INTERRUPTED";
    await save(session);
    throw new Error("STEP_LIMIT");
  }
  session.sequences[sender.documentId!] = m.sequence;
  session.eventIds.push(m.eventId);
  step.id = `s${session.steps.length + 1}`;
  session.steps.push(step);
  await save(session);
  return { ok: true };
}
// Serialization protects read/modify/write checkpoints. Durable state is always in storage.
let queue = Promise.resolve();
chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  queue = queue.then(async () => {
    try {
      respond({ ok: true, data: await handle(message, sender) });
    } catch (e) {
      respond({
        ok: false,
        error:
          e instanceof Error && /^[A-Z_]+$/.test(e.message)
            ? e.message
            : "INVALID_MESSAGE",
      });
    }
  });
  return true;
});
async function navigation(
  details: chrome.webNavigation.WebNavigationBaseCallbackDetails,
) {
  const s = await read();
  if (
    !s ||
    details.tabId !== s.tabId ||
    details.frameId !== 0 ||
    s.state !== "RECORDING"
  )
    return;
  const u = new URL(details.url);
  if (u.origin !== s.origin || u.search || u.hash) {
    s.state = "INTERRUPTED";
    s.warnings.push("ORIGIN_OR_URL_CHANGED");
    await save(s);
    return;
  }
  if (s.steps.length >= 100) {
    s.state = "INTERRUPTED";
    s.warnings.push("STEP_LIMIT");
    await save(s);
    return;
  }
  const last = s.steps.at(-1);
  if (!(last?.kind === "navigate" && last.url === u.href))
    s.steps.push({
      id: `s${s.steps.length + 1}`,
      kind: "navigate",
      url: u.href,
      timeoutMs: 15000,
    });
  await save(s);
  await inject(s.tabId).catch(async () => {
    s.state = "INTERRUPTED";
    await save(s);
  });
}
chrome.webNavigation.onCommitted.addListener((d) => {
  queue = queue.then(() => navigation(d)).catch(() => {});
});
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => {
  queue = queue.then(() => navigation(d)).catch(() => {});
});
chrome.permissions.onRemoved.addListener(() => {
  queue = queue.then(async () => {
    const s = await read();
    if (
      s &&
      !(await chrome.permissions.contains({ origins: [`${s.origin}/*`] }))
    ) {
      s.state = "INTERRUPTED";
      await save(s);
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  queue = queue
    .then(async () => {
      const s = await read();
      if (s && s.tabId === tabId && ["RECORDING", "PAUSED"].includes(s.state)) {
        s.state = "INTERRUPTED";
        s.warnings.push("TAB_CLOSED");
        await save(s);
      }
    })
    .catch(() => {});
});
