// Active Leclerc store: the configured one, replaced by set_store and remembered between sessions.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

export const leclercSelectionSchema = z.object({
  /** The store's shopping host, e.g. "fd7-courses.leclercdrive.fr" (the number varies by store). */
  host: z.string().regex(/^fd\d+-courses\.leclercdrive\.fr$/),
  name: z.string().min(1).optional(),
  /** Pickup point (noPR): equal to storeId for a drive, different for a walk-in pickup point. */
  retrievalPointId: z.string().regex(/^\d{6}$/),
  /** Delivery point (noPL), e.g. "123456". */
  storeId: z.string().regex(/^\d{6}$/),
});

export type LeclercSelection = z.infer<typeof leclercSelectionSchema>;

export interface SelectionRepository {
  current(): LeclercSelection;
  save(selection: LeclercSelection): void;
}

/** In-memory selection (tests, or non-persistent state). */
export class MemorySelection implements SelectionRepository {
  #selection: LeclercSelection;

  constructor(initial: LeclercSelection) {
    this.#selection = initial;
  }

  current(): LeclercSelection {
    return this.#selection;
  }

  save(selection: LeclercSelection): void {
    this.#selection = selection;
  }
}

/** Selection persisted in a JSON file; the configuration applies until a choice is made. */
export class FileSelection implements SelectionRepository {
  readonly #path: string;
  #selection: LeclercSelection;

  constructor(path: string, fallback: LeclercSelection) {
    this.#path = path;
    this.#selection = FileSelection.#read(path) ?? fallback;
  }

  current(): LeclercSelection {
    return this.#selection;
  }

  save(selection: LeclercSelection): void {
    this.#selection = leclercSelectionSchema.parse(selection);
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, `${JSON.stringify(this.#selection, null, 2)}\n`, "utf8");
  }

  static #read(path: string): LeclercSelection | null {
    try {
      const parsed = leclercSelectionSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null; // absent ou illisible : on garde la configuration
    }
  }
}
