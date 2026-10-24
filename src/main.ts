#!/usr/bin/env node
// Entry point: wires the layers and serves MCP over stdio.
// stdout is reserved for the protocol; diagnostics go to stderr.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildRegistry } from "./composition.ts";
import { loadConfig } from "./config.ts";
import { CdpBrowser } from "./infrastructure/browser/cdp-browser.ts";
import { createServer } from "./interface/mcp/server.ts";

const config = loadConfig();
const browser = new CdpBrowser({ port: config.chromePort, timeoutMs: config.timeoutMs });
const registry = buildRegistry(config, (origin, homePath) => browser.tab(origin, homePath));
const server = createServer(registry);

const shutdown = async () => {
  browser.close();
  await server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(new StdioServerTransport());
console.error(`fr-grocery-mcp ready: ${registry.ids.join(", ")} (Chrome on port ${config.chromePort})`);
