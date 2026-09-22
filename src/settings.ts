import { mkdir, open } from "node:fs/promises";
import { z } from "zod";
import { dirname } from "node:path";
import { readBoundedFile } from "./bounded-file.ts";
import { parseConfig } from "./config.ts";
import type { RouterConfig } from "./types.ts";

const MAX_CONFIG_BYTES = 65_536;

const UNREADABLE =
  "Invalid or unreadable router config. Check JSON, fields, bounds and model mappings.";

const missingFile = z
  .instanceof(Error)
  .refine((error) => z.object({ code: z.literal("ENOENT") }).safeParse(error).success);

export async function loadConfig(path: string): Promise<RouterConfig | undefined> {
  let text: string;

  try {
    // A regular-file, bounded, non-blocking read: a FIFO at this path fails instead of hanging.
    text = await readBoundedFile(path, MAX_CONFIG_BYTES);
  } catch (error) {
    if (missingFile.safeParse(error).success) return undefined;
    // Config values and filesystem error messages can contain secrets.
    throw new Error(UNREADABLE);
  }

  let value: unknown;

  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(UNREADABLE);
  }

  try {
    return parseConfig(value);
  } catch {
    throw new Error(UNREADABLE);
  }
}

/** Never overwrite an existing configuration, including a symlink. */
export async function createConfig(path: string, config: RouterConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, "wx", 0o600);

  try {
    await file.writeFile(`${JSON.stringify(config, null, 2)}\n`);
  } finally {
    await file.close();
  }
}

/** Bound work whose underlying provider may ignore cancellation. No model setters here. */
export async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let remove = () => {};

  const cancelled = new Promise<never>((_, reject) => {
    const listener = () => reject(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
    remove = () => signal.removeEventListener("abort", listener);
  });

  try {
    return await Promise.race([work(), cancelled]);
  } finally {
    remove();
  }
}
