// Configuration: a JSON file (FR_GROCERY_CONFIG) lists the retailers, in order of preference.
// Without a file, only Super U is plugged in (its store is chosen on the site).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { leclercSelectionSchema } from "./infrastructure/retailers/leclerc/selection.ts";

const interval = (ms: number) => z.number().int().min(0).max(60_000).default(ms);

const storeSchema = z.discriminatedUnion("retailer", [
  z.object({ retailer: z.literal("superu"), minIntervalMs: interval(300) }),
  z.object({ retailer: z.literal("leclerc"), store: leclercSelectionSchema, minIntervalMs: interval(1000) }),
]);

const fileSchema = z.object({
  chrome: z
    .object({
      port: z.number().int().min(1).max(65_535).default(9222),
      timeoutMs: z.number().int().min(1000).default(30_000),
    })
    .prefault({}),
  stores: z
    .array(storeSchema)
    .min(1)
    .refine((stores) => new Set(stores.map((s) => s.retailer)).size === stores.length, "duplicate retailer")
    .prefault([{ retailer: "superu" }]),
});

const envSchema = z.object({
  FR_GROCERY_CONFIG: z.string().min(1).optional(),
  FR_GROCERY_STATE_DIR: z.string().min(1).optional(),
  FR_GROCERY_CHROME_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
});

export type StoreConfig = z.infer<typeof storeSchema>;

export interface Config {
  /** Debugging port of the Chrome logged in to the sites. */
  readonly chromePort: number;
  /** Maximum duration of a browser call. */
  readonly timeoutMs: number;
  /** Folder for choices remembered between sessions (Leclerc store). */
  readonly stateDir: string;
  readonly stores: readonly StoreConfig[];
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Config {
  const vars = envSchema.safeParse(env);
  if (!vars.success) throw new Error(`Invalid configuration: ${z.prettifyError(vars.error)}`);
  const { FR_GROCERY_CONFIG: path, FR_GROCERY_STATE_DIR: stateDir, FR_GROCERY_CHROME_PORT: port } = vars.data;

  let raw: unknown = {};
  if (path) {
    try {
      raw = JSON.parse(readFile(path));
    } catch (error) {
      throw new Error(`Unreadable configuration (${path}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const file = fileSchema.safeParse(raw);
  if (!file.success) throw new Error(`Invalid configuration (${path ?? "default"}): ${z.prettifyError(file.error)}`);

  return {
    chromePort: port ?? file.data.chrome.port,
    timeoutMs: file.data.chrome.timeoutMs,
    stateDir: stateDir ?? join(homedir(), ".fr-grocery-mcp"),
    stores: file.data.stores,
  };
}
