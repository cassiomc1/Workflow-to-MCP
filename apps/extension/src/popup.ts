import type { Session } from "./session.js";
const $ = (id: string) => document.getElementById(id)!;
async function request(message: unknown) {
  const r = await chrome.runtime.sendMessage(message);
  if (!r.ok) throw new Error(r.error);
  const s = r.data as Session | null;
  $("status").textContent = s
    ? `${s.state} · ${s.steps.length} steps · ${s.safeFields.length} permitted inputs`
    : "Ready to record";
  $("origin").textContent = s?.origin ?? "No origin permitted";
  $("message").textContent = s?.warnings.join(" · ") ?? "";
  return s;
}
function action(id: string, fn: () => Promise<unknown>) {
  $(id).addEventListener("click", () => {
    void fn().catch((e) => {
      $("message").textContent =
        e instanceof Error ? e.message : "Operation failed";
    });
  });
}
action("record", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !/^https?:/.test(tab.url))
    throw new Error("Open the extension from the toolbar on an HTTP(S) tab.");
  const origin = new URL(tab.url).origin;
  await request({ type: "start", tabId: tab.id, origin });
});
for (const id of ["pause", "resume", "erase"])
  action(id, () => request({ type: id }));
action("stop", async () => {
  await request({ type: "stop" });
  await chrome.tabs.create({ url: chrome.runtime.getURL("review.html") });
});
action("field", () => request({ type: "choose-field" }));
action("output", () => request({ type: "choose-output" }));
action("review", () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("review.html") }),
);
void request({ type: "status" });

chrome.storage.onChanged.addListener(() => {
  void request({ type: "status" }).catch(() => {});
});
