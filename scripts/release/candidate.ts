import { appendFile, readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { assertPreOneVersion } from "./policy.ts";

export const RELEASE_BRANCH = "changeset-release/main";

export const RELEASE_PR_TITLE = "chore: release pi-typesafe-router";

export const RELEASE_CHECK_NAME = "release / candidate";

const versionSchema = z.string().regex(/^0\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);

const packageSchema = z
  .object({ name: z.literal("pi-typesafe-router"), version: versionSchema })
  .passthrough();

const lockSchema = z
  .object({
    version: versionSchema,
    packages: z.object({ "": z.object({ version: versionSchema }).passthrough() }).passthrough(),
  })
  .passthrough();

export interface ReleaseIdentity {
  headRepository: string;
  baseRepository: string;
  baseRef: string;
  headRef: string;
  author: string;
  expectedBot: string;
}

export interface CandidateFiles {
  changed: readonly { filename: string; status: string }[];
  packageJson: string;
  packageLock: string;
  changelog: string;
  basePackageJson: string;
  basePackageLock: string;
}

export function isManagedReleasePullRequest(identity: ReleaseIdentity): boolean {
  return (
    identity.headRepository === identity.baseRepository &&
    identity.baseRef === "main" &&
    identity.headRef === RELEASE_BRANCH &&
    identity.author === identity.expectedBot
  );
}

function compareVersions(before: string, after: string): number {
  const parts = (version: string) => version.split(/[.-]/).slice(0, 3).map(Number);
  const left = parts(before);
  const right = parts(after);

  for (let index = 0; index < 3; index++) {
    if (right[index] !== left[index]) return right[index] - left[index];
  }

  return 0;
}

export function validateReleaseCandidate(files: CandidateFiles): string {
  const allowed = /^(package\.json|package-lock\.json|CHANGELOG\.md|\.changeset\/[^/]+\.md)$/;

  if (files.changed.some(({ filename }) => !allowed.test(filename)))
    throw new Error("release-candidate-has-unrelated-files");

  for (const required of ["package.json", "package-lock.json", "CHANGELOG.md"])
    if (!files.changed.some(({ filename }) => filename === required))
      throw new Error(`release-candidate-missing-${required}`);

  if (
    files.changed.some(
      ({ filename, status }) => filename.startsWith(".changeset/") && status !== "removed",
    )
  )
    throw new Error("release-candidate-must-consume-changesets");

  const next = packageSchema.parse(JSON.parse(files.packageJson));
  const previous = packageSchema.parse(JSON.parse(files.basePackageJson));
  const lock = lockSchema.parse(JSON.parse(files.packageLock));
  const previousLock = lockSchema.parse(JSON.parse(files.basePackageLock));

  assertPreOneVersion(next.version);

  if (compareVersions(previous.version, next.version) <= 0)
    throw new Error("release-version-must-increase");

  if (lock.version !== next.version || lock.packages[""].version !== next.version)
    throw new Error("release-lockfile-version-mismatch");

  const expectedPackage = structuredClone(previous);
  expectedPackage.version = next.version;

  if (!isDeepStrictEqual(next, expectedPackage))
    throw new Error("release-package-has-non-version-changes");

  const expectedLock = structuredClone(previousLock);
  expectedLock.version = next.version;
  expectedLock.packages[""].version = next.version;

  if (!isDeepStrictEqual(lock, expectedLock))
    throw new Error("release-lockfile-has-non-version-changes");

  if (
    !files.changelog.startsWith(`# pi-typesafe-router\n`) ||
    !files.changelog.includes(`## ${next.version}`)
  )
    throw new Error("release-changelog-version-mismatch");

  return next.version;
}

export function validatePreparationState(
  changesetPaths: readonly string[],
  managedPullRequestCount: number,
): boolean {
  if (managedPullRequestCount > 1) throw new Error("multiple-managed-release-pull-requests");

  return changesetPaths.some((path) => path.endsWith(".md") && path !== "README.md");
}

export async function validatePriorPublication(
  repository: string,
  token: string,
  packageText: string,
  fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
): Promise<void> {
  const { version } = packageSchema.parse(JSON.parse(packageText));
  const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` };

  const [npm, tag, release] = await Promise.all([
    fetchImpl(`https://registry.npmjs.org/pi-typesafe-router/${version}`, { redirect: "error" }),
    fetchImpl(`https://api.github.com/repos/${repository}/git/ref/tags/v${version}`, {
      headers,
      redirect: "error",
    }),
    fetchImpl(`https://api.github.com/repos/${repository}/releases/tags/v${version}`, {
      headers,
      redirect: "error",
    }),
  ]);

  const artifacts = [npm, tag, release];

  if (artifacts.every((response) => response.ok)) return;

  if (version === "0.1.0" && artifacts.every((response) => response.status === 404)) return;

  throw new Error("prior-release-is-incomplete");
}

async function main(): Promise<void> {
  if (process.argv[2] !== "preflight") throw new Error("unknown-candidate-command");
  const token = process.env.GITHUB_APP_TOKEN ?? "";
  const repository = process.env.GITHUB_REPOSITORY ?? "";

  if (!token || !repository) throw new Error("missing-workflow-configuration");

  await validatePriorPublication(repository, token, await readFile("package.json", "utf8"));

  const response = await fetch(
    `https://api.github.com/repos/${repository}/pulls?state=open&head=${encodeURIComponent(`${repository.split("/")[0]}:${RELEASE_BRANCH}`)}&per_page=100`,
    {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
      redirect: "error",
    },
  );

  if (!response.ok) throw new Error("release-pull-request-state-is-ambiguous");

  const pulls = z
    .array(z.object({ number: z.number().int().positive() }))
    .parse(await response.json());

  const pending = validatePreparationState(await readdir(".changeset"), pulls.length);
  const output = process.env.GITHUB_OUTPUT;

  if (output) await appendFile(output, `pending=${String(pending)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
