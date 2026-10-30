import { it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setup } from "../helpers.js";
import { verifyWorkflow } from "../../packages/testing/src/verify.js";
import { localActor } from "../../packages/runner/src/index.js";
it("an MCP write is refused without approval, runs once with exact approval, and refuses replay", async () => {
  const s = await setup(true),
    input = { summary: "Synthetic MCP ticket" };
  const client = new Client({ name: "write-policy-client", version: "1.0.0" });
  try {
    const suite = JSON.parse(
      await readFile("examples/demo-crm-create-ticket/cases.json", "utf8"),
    );
    await verifyWorkflow(s.registry, s.stored, suite, async (value) =>
      s.registry.approve(s.stored, value, localActor()),
    );
    s.registry.publish(s.stored.workflow.slug, "1.0.0");
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          resolve("dist/cli.js"),
          "serve",
          "--stdio",
          "--home",
          s.directory,
        ],
        env: { ...process.env } as Record<string, string>,
        stderr: "pipe",
      }),
    );
    const args = { name: "wf_create_support_ticket", arguments: input };
    const denied = await client.callTool(args);
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain("APPROVAL_REQUIRED");
    expect(s.demo.writes).toBe(1);
    s.registry.approve(s.stored, input, localActor());
    const accepted = await client.callTool(args);
    expect(accepted.isError).not.toBe(true);
    expect(accepted.structuredContent).toEqual({ created_id: "CREATED-2" });
    expect(s.demo.writes).toBe(2);
    const replay = await client.callTool(args);
    expect(replay.isError).toBe(true);
    expect(s.demo.writes).toBe(2);
  } finally {
    await client.close();
    await s.close();
  }
});
it("negotiates a real stdio client, advertises exact schemas, runs two calls, rejects invalid input and disables live calls", async () => {
  const s = await setup();
  let client: Client | undefined;
  try {
    const suite = JSON.parse(
      await readFile("examples/demo-crm-lookup/cases.json", "utf8"),
    );
    await verifyWorkflow(s.registry, s.stored, suite);
    s.registry.publish(s.stored.workflow.slug, "1.0.0");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/cli.js"), "serve", "--stdio", "--home", s.directory],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (p): p is [string, string] => p[1] !== undefined,
          ),
        ),
        WORKFLOW_MCP_HOME: s.directory,
      },
      stderr: "pipe",
    });
    client = new Client({
      name: "workflow-integration-client",
      version: "1.0.0",
    });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(1);
    expect(tools.tools[0]?.name).toBe("wf_lookup_support_ticket");
    expect(tools.tools[0]?.inputSchema.additionalProperties).toBe(false);
    expect(tools.tools[0]?.inputSchema.required).toEqual(["ticket_id"]);
    for (const c of suite.cases.slice(0, 2)) {
      const result = await client.callTool({
        name: "wf_lookup_support_ticket",
        arguments: c.input,
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(c.expected);
    }
    const bad = await client.callTool({
      name: "wf_lookup_support_ticket",
      arguments: { ticket_id: 3, approved: true },
    });
    expect(bad.isError).toBe(true);
    s.registry.disable(s.stored.workflow.slug);
    const disabled = await client.callTool({
      name: "wf_lookup_support_ticket",
      arguments: { ticket_id: "TICKET-1001" },
    });
    expect(disabled.isError).toBe(true);
    expect(JSON.stringify(disabled)).toContain("WORKFLOW_NOT_PUBLISHED");
    expect(client.getServerVersion()?.name).toBe("workflow-to-mcp");
  } finally {
    await client?.close();
    await s.close();
  }
});
it("publishes no tool for an imported but unverified workflow", async () => {
  const s = await setup();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/cli.js"), "serve", "--stdio", "--home", s.directory],
    stderr: "pipe",
  });
  const client = new Client({ name: "unverified-client", version: "1.0.0" });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools).toEqual([]);
    await expect(
      client.callTool({
        name: "wf_lookup_support_ticket",
        arguments: { ticket_id: "x" },
      }),
    ).rejects.toThrow();
  } finally {
    await client.close();
    await s.close();
  }
});
