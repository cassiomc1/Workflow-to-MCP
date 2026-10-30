import { beginLogin } from "../packages/auth/src/session.js";
import { authConfigSchema } from "../packages/auth/src/schema.js";
import { fixtureWorkflow, setup } from "./helpers.js";
export async function authenticatedSetup(write = false) {
  const s = await setup(write),
    w = await fixtureWorkflow(s.demo.origin, write);
  w.version = "1.1.0";
  w.entrypoint = `${s.demo.origin}/auth/${write ? "create" : "tickets"}`;
  for (const step of w.steps) {
    if (step.kind === "navigate") step.url = w.entrypoint;
    if (write && step.kind === "click")
      step.locator = {
        strategy: "role",
        role: "button",
        name: "Create authenticated ticket",
      };
  }
  const imported = s.registry.import(w);
  s.registry.trust(w.slug, imported.hash, w.version);
  return { ...s, stored: s.registry.get(w.slug, w.version) };
}
export async function loginFixture(
  s: Awaited<ReturnType<typeof setup>>,
  id = "demo_session",
  extra: Record<string, unknown> = {},
) {
  const config = authConfigSchema.parse({
    id,
    allowedOrigins: [s.demo.origin],
    loginUrl: s.demo.origin + "/auth/login",
    check: {
      url: s.demo.origin + "/auth/check",
      locator: { strategy: "testId", value: "auth-ready" },
    },
    ...extra,
  });
  const login = await beginLogin(s.registry, config, { headless: true });
  try {
    await login.page.getByLabel("Demo user").fill("demo");
    await login.page.getByLabel("Demo password").fill("demo-password");
    await login.page.getByLabel("One-time code").fill("123456");
    await login.page
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    await login.page.getByTestId("auth-ready").waitFor();
    return await login.save();
  } finally {
    await login.close();
  }
}
