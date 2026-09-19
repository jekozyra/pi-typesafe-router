import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const packageSchema = z.object({ version: z.string().min(1) });

const lockSchema = z
  .object({
    version: z.string(),
    packages: z.object({ "": z.object({ version: z.string() }).passthrough() }).passthrough(),
  })
  .passthrough();

export function updateLockfileVersion(packageText: string, lockText: string): string {
  const { version } = packageSchema.parse(JSON.parse(packageText));
  const value: unknown = JSON.parse(lockText);
  lockSchema.parse(value);
  // SAFETY: Validated above; retain the original object to preserve JSON key order.
  const lock = value as z.infer<typeof lockSchema>;
  lock.version = version;
  lock.packages[""].version = version;

  return `${JSON.stringify(lock, null, 2)}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const packageText = await readFile("package.json", "utf8");
  const lockText = await readFile("package-lock.json", "utf8");
  await writeFile("package-lock.json", updateLockfileVersion(packageText, lockText));
}
