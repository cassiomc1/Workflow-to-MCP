import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
const exec = promisify(execFile),
  directory = await mkdtemp(join(tmpdir(), "workflow-package-"));
let demo, client;
try {
  const { stdout } = await exec("npm", [
    "pack",
    "--pack-destination",
    directory,
    "--json",
  ]);
  const tarball = join(directory, JSON.parse(stdout)[0].filename);
  const install = join(directory, "install");
  await mkdir(install);
  await writeFile(
    join(install, "package.json"),
    JSON.stringify({
      name: "workflow-package-smoke",
      version: "1.0.0",
      private: true,
    }),
  );
  await exec(
    "npm",
    [
      "install",
      "--prefix",
      install,
      tarball,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    { maxBuffer: 5e6 },
  );
  const bin = join(install, "node_modules/workflow-to-mcp/dist/cli.js"),
    demoModule = await import("../dist/demo-server.js");
  demo = await demoModule.startDemo(0);
  const home = join(directory, "state");
  const cli = async (args) =>
    JSON.parse(
      (await exec(process.execPath, [bin, ...args, "--home", home, "--json"]))
        .stdout,
    );
  await cli(["doctor"]);
  if (process.platform !== "win32") {
    const installedBin = join(
      install,
      "node_modules",
      ".bin",
      "workflow-to-mcp",
    );
    const invoked = JSON.parse(
      (await exec(installedBin, ["doctor", "--home", home, "--json"])).stdout,
    );
    if (!invoked.ok) throw new Error("Installed executable failed doctor.");
  }
  await cli(["policy", "allow", "--origin", demo.origin, "--fixture"]);
  const body = (
    await readFile("examples/demo-crm-lookup/workflow.json", "utf8")
  ).replaceAll("http://127.0.0.1:4173", demo.origin);
  const recording = join(directory, "lookup.workflow.json");
  await writeFile(recording, body);
  const imported = await cli(["workflow", "import", recording]);
  await cli([
    "workflow",
    "trust",
    "lookup_support_ticket",
    "--hash",
    imported.hash,
  ]);
  await cli([
    "workflow",
    "verify",
    "lookup_support_ticket",
    "--suite",
    resolve("examples/demo-crm-lookup/cases.json"),
  ]);
  await cli([
    "workflow",
    "publish",
    "lookup_support_ticket",
    "--version",
    "1.0.0",
  ]);
  client = new Client({ name: "clean-package-smoke", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [bin, "serve", "--stdio", "--home", home],
      env: { ...process.env },
      stderr: "pipe",
    }),
  );
  const tools = await client.listTools();
  if (tools.tools.length !== 1) throw new Error("Wrong tool count");
  for (const ticket_id of ["TICKET-1001", "TICKET-1002"]) {
    const result = await client.callTool({
      name: "wf_lookup_support_ticket",
      arguments: { ticket_id },
    });
    if (result.isError || result.structuredContent?.found !== true)
      throw new Error("MCP invocation failed");
  }
  const sbom = await exec(
    "npm",
    ["sbom", "--prefix", install, "--omit=dev", "--sbom-format", "cyclonedx"],
    { maxBuffer: 5e6 },
  );
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/sbom.cdx.json", sbom.stdout);
  console.log(
    "PASS: clean tarball install, doctor, CLI import/trust/verify/publish, real stdio MCP discovery and two invocations.",
  );
} finally {
  await client?.close();
  await demo?.close();
  await rm(directory, { recursive: true, force: true });
}
