import {
  canonicalize,
  type Step,
} from "../../../packages/workflow-schema/src/index.js";
import {
  locatorFor,
  sanitizeValue,
  sensitiveName,
} from "../../../packages/recorder-core/src/index.js";
import { type Session } from "./session.js";
const marker = "__workflowRecorderInstalled";
const globalState = globalThis as typeof globalThis & {
  __workflowRecorderInstalled?: boolean;
};
if (!globalState[marker]) {
  globalState[marker] = true;
  let s: Session | null = null,
    sequence = 0,
    chain = Promise.resolve();
  const warn = (code: string) => {
    void chrome.runtime.sendMessage({ type: "warning", code }).catch(() => {});
  };
  let lastCommitted = new WeakMap<Element, string>();
  async function refresh() {
    const previousSession = s?.id;
    s =
      ((await chrome.storage.local.get("session")).session as Session) ?? null;
    if (previousSession !== s?.id) lastCommitted = new WeakMap();
  }
  void refresh();
  chrome.storage.onChanged.addListener(() => {
    void refresh();
  });
  async function send(step: Step, expectedSession: string) {
    const hello = await chrome.runtime.sendMessage({ type: "hello" });
    if (
      !hello.ok ||
      !s ||
      hello.data.sessionId !== s.id ||
      expectedSession !== s.id
    )
      return;
    sequence = hello.data.sequence;
    const message = {
      type: "capture",
      sessionId: s.id,
      eventId: crypto.randomUUID(),
      sequence: ++sequence,
      timestamp: Date.now(),
      step,
    };
    const reply = await chrome.runtime
      .sendMessage(message)
      .catch(() => chrome.runtime.sendMessage(message));
    if (!reply.ok) warn("UNSUPPORTED_CONTROL");
  }
  const record = (step: Step) => {
    const sessionId = s?.id;
    if (!sessionId) return;
    chain = chain.then(() => send(step, sessionId)).catch(() => {});
  };
  const active = (e: Event): e is Event =>
    e.isTrusted && s?.state === "RECORDING" && location.origin === s.origin;
  document.addEventListener(
    "click",
    (e) => {
      if (!active(e) || !(e.target instanceof Element)) return;
      let element =
        e.target.closest(
          "button,a,input,select,textarea,[data-testid],[role]",
        ) ?? e.target;
      if (s?.mode === "output" && e.shiftKey)
        element =
          element.parentElement?.closest("[data-testid],[id]") ?? element;
      if (s?.mode !== "none") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (
          s?.mode === "field" &&
          (!(
            element instanceof HTMLInputElement ||
            element instanceof HTMLSelectElement ||
            element instanceof HTMLTextAreaElement
          ) ||
            sensitiveName.test(
              `${element.getAttribute("type")} ${element.getAttribute("name")} ${element.getAttribute("id")} ${element.getAttribute("autocomplete")}`,
            ))
        ) {
          warn("SENSITIVE_VALUE_REDACTED");
          return;
        }
        const locator = locatorFor(element);
        if (!locator) {
          warn("UNSUPPORTED_CONTROL");
          return;
        }
        void chrome.runtime.sendMessage({ type: "selection", locator });
        return;
      }
      if (element instanceof HTMLIFrameElement) {
        warn("UNSUPPORTED_FRAME_ORIGIN");
        return;
      }
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement ||
        element.closest("label")
      )
        return;
      if (element.getAttribute("target") === "_blank") {
        warn("UNSUPPORTED_POPUP");
        return;
      }
      if (!element.matches('button,a,[role="button"]')) return;
      const locator = locatorFor(element);
      if (locator)
        record({ id: "stemp", kind: "click", locator, timeoutMs: 10000 });
      else warn("UNSUPPORTED_CONTROL");
    },
    true,
  );
  function commitField(
    element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  ) {
    const locator = locatorFor(element);
    if (!locator) {
      warn("SENSITIVE_VALUE_REDACTED");
      return;
    }
    const authorized =
      s?.safeFields.some((l) => canonicalize(l) === canonicalize(locator)) ??
      false;
    const value = sanitizeValue(
      element.value,
      `${element.name} ${element.id} ${element.autocomplete} ${element.getAttribute("aria-label")}`,
      element.type,
      authorized,
    );
    if (value === null) {
      warn(authorized ? "SENSITIVE_VALUE_REDACTED" : "FIELD_NOT_AUTHORIZED");
      return;
    }
    const fingerprint =
      element instanceof HTMLInputElement &&
      ["checkbox", "radio"].includes(element.type)
        ? String(element.checked)
        : value;
    if (lastCommitted.get(element) === fingerprint) return;
    lastCommitted.set(element, fingerprint);
    const base = { id: "stemp", locator, timeoutMs: 10000 };
    if (
      element instanceof HTMLInputElement &&
      ["checkbox", "radio"].includes(element.type)
    )
      record({ ...base, kind: "check", checked: element.checked });
    else if (element instanceof HTMLSelectElement)
      record({ ...base, kind: "select", option: value });
    else record({ ...base, kind: "fill", value });
  }
  document.addEventListener(
    "change",
    (e) => {
      if (
        active(e) &&
        (e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLSelectElement ||
          e.target instanceof HTMLTextAreaElement)
      )
        commitField(e.target);
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (
        !active(e) ||
        !(e.target instanceof Element) ||
        !["Enter", "Escape"].includes(e.key)
      )
        return;
      if (
        e.key === "Enter" &&
        (e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLTextAreaElement)
      )
        commitField(e.target);
      const locator = locatorFor(e.target);
      if (
        locator &&
        s?.safeFields.some((l) => canonicalize(l) === canonicalize(locator))
      )
        record({
          id: "stemp",
          kind: "press",
          locator,
          key: e.key as "Enter" | "Escape",
          timeoutMs: 10000,
        });
    },
    true,
  );
  if (document.querySelector("iframe")) warn("UNSUPPORTED_FRAME_ORIGIN");
}
