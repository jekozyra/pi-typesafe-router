/**
 * Bounded, non-blocking reads of one regular file.
 *
 * A path a configuration can name is not necessarily a document. A FIFO blocks a plain read
 * until a writer appears, and a device or directory yields bytes that are not JSON. Every read
 * here opens with `O_NONBLOCK` and re-checks the descriptor with `fstat` before a single byte
 * is read, so a special file fails immediately instead of parking Pi's event loop. Nothing in
 * an error message names the path or its content.
 */

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

/** The largest single allocation per read; a mid-file growth is caught by the byte counter. */
const CHUNK_BYTES = 8192;

export type ReadFailure = "unreadable" | "too-large";

/** A read that failed for a reason a caller translates into its own, path-free message. */
export class ReadError extends Error {
  readonly reason: ReadFailure;

  constructor(reason: ReadFailure) {
    super(reason === "too-large" ? "File exceeds the size limit" : "File is unreadable");
    this.name = "ReadError";
    this.reason = reason;
  }
}

/** Read a regular descriptor into UTF-8, stopping at the byte cap. */
async function readDescriptor(
  handle: FileHandle,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let total = 0;

  while (true) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);

    if (bytesRead === 0) break;
    total += bytesRead;

    if (total > maxBytes) throw new ReadError("too-large");
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }

  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Read one regular file, at most `maxBytes`, without blocking on a special file.
 *
 * The descriptor is opened with `O_NONBLOCK`, so a FIFO cannot wait for a writer, and the
 * `fstat` check is what rejects a FIFO, socket, device, or directory. A missing file keeps its
 * `ENOENT` error, so a caller can still treat absence as a supported state. An aborted signal
 * propagates its own reason, so a caller can tell cancellation from a bad artifact.
 */
export async function readBoundedFile(
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  let handle: FileHandle;

  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();

    throw error instanceof Error ? error : new ReadError("unreadable");
  }

  try {
    const stats = await handle.stat();

    if (!stats.isFile()) throw new ReadError("unreadable");

    if (stats.size > maxBytes) throw new ReadError("too-large");

    return await readDescriptor(handle, maxBytes, signal);
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();

    throw error instanceof Error ? error : new ReadError("unreadable");
  } finally {
    await handle.close().catch(() => {});
  }
}

/** The same contract for a bundled artifact read at module load, where no signal exists. */
export function readBoundedFileSync(path: string, maxBytes: number): string {
  let descriptor: number;

  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    throw new ReadError("unreadable");
  }

  try {
    const stats = fstatSync(descriptor);

    if (!stats.isFile()) throw new ReadError("unreadable");

    if (stats.size > maxBytes) throw new ReadError("too-large");

    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let total = 0;

    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);

      if (bytesRead === 0) break;
      total += bytesRead;

      if (total > maxBytes) throw new ReadError("too-large");
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }

    return Buffer.concat(chunks).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}
