import { z } from "zod";

export const RELEASE_IMPACTS = ["none", "patch", "minor", "major"] as const;

export const releaseImpactSchema = z.enum(RELEASE_IMPACTS);

export type ReleaseImpact = z.infer<typeof releaseImpactSchema>;

export type ChangesetImpact = Exclude<ReleaseImpact, "none" | "major">;

export const RELEASE_LABELS = RELEASE_IMPACTS.map((impact) => `release:${impact}`);

const RELEASE_LABEL_SET = new Set<string>(RELEASE_LABELS);

const changesetImpactSchema = z.enum(["patch", "minor"]);

const PACKAGE_NAME = "pi-typesafe-router";

const MAX_DESCRIPTION_LENGTH = 2_000;

export class ReleasePolicyError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ReleasePolicyError";
  }
}

/** Changesets' major bump would cross 1.0, so breaking pre-1.0 work is a minor bump. */
export function toChangesetImpact(impact: ReleaseImpact): ChangesetImpact | undefined {
  if (impact === "none") return undefined;

  return impact === "major" ? "minor" : impact;
}

export function assertPreOneVersion(version: string): void {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version);

  if (!match || Number(match[1]) >= 1) throw new ReleasePolicyError("version-must-remain-pre-1.0");
}

export function normalizeDescription(description: string): string {
  const normalized = description.replace(/\r\n?/g, "\n").trim();

  const hasUnsafeControl = [...normalized].some((character) => {
    const code = character.charCodeAt(0);

    return (code < 32 && code !== 9 && code !== 10) || code === 127;
  });

  if (!normalized || Buffer.byteLength(normalized) > MAX_DESCRIPTION_LENGTH || hasUnsafeControl)
    throw new ReleasePolicyError("invalid-description");

  return normalized;
}

/** Package identity and frontmatter are deterministic; model prose is only the body. */
export function serializeChangeset(
  impact: Exclude<ReleaseImpact, "none">,
  description: string,
): string {
  const bump = toChangesetImpact(impact);

  if (!bump) throw new ReleasePolicyError("invalid-impact");

  const normalized = normalizeDescription(description);

  const releaseNote =
    impact === "major" && !/\bbreaking\b/i.test(normalized)
      ? `Breaking change: ${normalized}`
      : normalized;

  return `---\n"${PACKAGE_NAME}": ${bump}\n---\n\n${normalizeDescription(releaseNote)}\n`;
}

export function validateGeneratedChangeset(content: string) {
  const match = /^---\n"pi-typesafe-router": (patch|minor)\n---\n\n([^\0]+)\n$/.exec(content);

  if (!match) throw new ReleasePolicyError("invalid-changeset");

  return {
    impact: changesetImpactSchema.parse(match[1]),
    description: normalizeDescription(match[2]),
  };
}

export function generatedChangesetPath(prNumber: number): string {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0)
    throw new ReleasePolicyError("invalid-pr-number");

  return `.changeset/pr-${prNumber}.md`;
}

export function parseReleaseLabels(labels: readonly string[]): ReleaseImpact | undefined {
  const selected = labels.filter((label) => RELEASE_LABEL_SET.has(label));

  if (selected.length > 1) throw new ReleasePolicyError("conflicting-release-labels");

  const label = selected[0];

  return label === undefined
    ? undefined
    : releaseImpactSchema.parse(label.slice("release:".length));
}

export function releaseNoteFromBody(body: string): string {
  const match = /(?:^|\n)## Release note\s*\n([\s\S]*?)(?=\n## |$)/i.exec(body);

  if (!match) throw new ReleasePolicyError("missing-release-note");

  return normalizeDescription(match[1]);
}
