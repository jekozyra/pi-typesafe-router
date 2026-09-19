import { generatedChangesetPath } from "./policy.ts";

export const INPUT_LIMITS = Object.freeze({
  files: 200,
  bytes: 120 * 1024,
  title: 512,
  body: 16_000,
});

export class ReleaseInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ReleaseInputError";
  }
}

export interface PullRequestFile {
  filename: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed";
  additions: number;
  deletions: number;
  patch?: string;
  previous_filename?: string;
}

export interface PullRequestInput {
  number: number;
  title: string;
  body: string;
  files: readonly PullRequestFile[];
}

/** Build a bounded JSON data projection. No PR text is interpolated into model instructions. */
export function buildModelInput(pr: PullRequestInput): string {
  if (pr.title.length > INPUT_LIMITS.title || pr.body.length > INPUT_LIMITS.body)
    throw new ReleaseInputError("input-too-large");

  const ownedPath = generatedChangesetPath(pr.number);
  const files = pr.files.filter((file) => file.filename !== ownedPath);

  if (files.length > INPUT_LIMITS.files) throw new ReleaseInputError("too-many-files");

  for (const file of files) {
    if (!file.filename || file.filename.includes("\0")) throw new ReleaseInputError("invalid-file");

    // GitHub omits patches for binaries and large/truncated diffs. Never silently classify those.
    if (file.patch === undefined) throw new ReleaseInputError("incomplete-diff");
  }

  const projectedFiles = files.map(
    ({ filename, previous_filename, status, additions, deletions, patch }) => ({
      filename,
      previous_filename,
      status,
      additions,
      deletions,
      patch,
    }),
  );

  const value = JSON.stringify({ title: pr.title, body: pr.body, files: projectedFiles });

  if (Buffer.byteLength(value) > INPUT_LIMITS.bytes) throw new ReleaseInputError("input-too-large");

  return value;
}
