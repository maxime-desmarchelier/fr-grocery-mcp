import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entrypoint = process.argv[2];
assert.ok(entrypoint, "Usage: node scripts/smoke-package.ts /path/to/package/dist/main.js");

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
};
const client = new Client({ name: "package-smoke-test", version: pkg.version });
const isJavaScript = entrypoint.endsWith(".js");

try {
  await client.connect(
    new StdioClientTransport({
      args: isJavaScript ? [entrypoint] : [],
      command: isJavaScript ? process.execPath : entrypoint,
      stderr: "inherit",
    }),
  );
  assert.equal(client.getServerVersion()?.name, pkg.name);
  assert.equal(client.getServerVersion()?.version, pkg.version);
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === "search_products"));
  assert.ok(tools.some((tool) => tool.name === "compare_carts"));
  console.error(`Packed MCP server passed its stdio smoke test (${tools.length} tools)`);
} finally {
  await client.close();
}
