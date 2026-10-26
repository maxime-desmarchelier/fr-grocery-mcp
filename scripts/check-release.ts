import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const PACKAGE_NAME = "fr-grocery-mcp";
const MCP_NAME = "io.github.maxime-desmarchelier/fr-grocery-mcp";
const version = z.string().regex(VERSION);

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

const packageSchema = z.object({
  mcpName: z.literal(MCP_NAME),
  name: z.literal(PACKAGE_NAME),
  version,
});
const serverSchema = z.object({
  name: z.literal(MCP_NAME),
  packages: z.tuple([
    z.object({
      identifier: z.literal(PACKAGE_NAME),
      registryType: z.literal("npm"),
      transport: z.object({ type: z.literal("stdio") }),
      version,
    }),
  ]),
  version,
});
const lockSchema = z.object({
  packages: z.object({ "": z.object({ version }) }),
  version,
});
const manifestSchema = z.object({ ".": version });

const pkg = packageSchema.parse(readJson("package.json"));
const server = serverSchema.parse(readJson("server.json"));
const lock = lockSchema.parse(readJson("package-lock.json"));
const manifest = manifestSchema.parse(readJson(".release-please-manifest.json"));

const serverSource = readFileSync(new URL("../src/interface/mcp/server.ts", import.meta.url), "utf8");
const serverVersion = z
  .string()
  .regex(VERSION)
  .parse(serverSource.match(/^export const SERVER_VERSION = "(.*)";/m)?.[1]);

assert.equal(server.version, pkg.version, "server.json version differs from package.json");
assert.equal(server.packages[0].version, pkg.version, "MCP npm package version differs from package.json");
assert.equal(lock.version, pkg.version, "package-lock.json version differs from package.json");
assert.equal(lock.packages[""].version, pkg.version, "package-lock.json root version differs from package.json");
assert.equal(manifest["."], pkg.version, "release-please manifest differs from package.json");
assert.equal(serverVersion, pkg.version, "SERVER_VERSION in src/interface/mcp/server.ts differs from package.json");

const releaseTag = process.env["RELEASE_TAG"];
if (releaseTag) assert.equal(releaseTag, `v${pkg.version}`, "release tag differs from package.json");

console.error(`Release metadata consistent: ${PACKAGE_NAME} ${pkg.version}, ${MCP_NAME}`);
