import { execFileSync } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { isManagedReleasePullRequest, validateReleaseCandidate } from "./candidate.ts";

const packageSchema = z.object({ name: z.literal("pi-typesafe-router"), version: z.string() });

const eventSchema = z.object({
  pull_request: z.object({
    merged: z.literal(true),
    merge_commit_sha: z.string().min(7),
    user: z.object({ login: z.string() }),
    base: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }) }),
    head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }) }),
  }),
});

export interface PublishIdentity {
  merged: boolean;
  mergeSha: string;
  checkedOutSha: string;
  headRepository: string;
  baseRepository: string;
  baseRef: string;
  headRef: string;
  author: string;
  expectedBot: string;
}

export function validatePublishIdentity(identity: PublishIdentity): void {
  if (!identity.merged || identity.mergeSha !== identity.checkedOutSha)
    throw new Error("publish-revision-mismatch");

  if (!isManagedReleasePullRequest(identity)) throw new Error("not-a-managed-release-pr");
}

function compareVersions(left: string, right: string): number {
  const parse = (version: string) => version.split(/[.-]/).slice(0, 3).map(Number);
  const a = parse(left);
  const b = parse(right);

  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }

  return 0;
}

export async function assertPublishConflictsAbsent(
  repository: string,
  version: string,
  token: string,
  fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
): Promise<void> {
  const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` };

  const [versionResponse, latestResponse, tagResponse, releaseResponse] = await Promise.all([
    fetchImpl(`https://registry.npmjs.org/pi-typesafe-router/${version}`, { redirect: "error" }),
    fetchImpl("https://registry.npmjs.org/pi-typesafe-router/latest", { redirect: "error" }),
    fetchImpl(`https://api.github.com/repos/${repository}/git/ref/tags/v${version}`, {
      headers,
      redirect: "error",
    }),
    fetchImpl(`https://api.github.com/repos/${repository}/releases/tags/v${version}`, {
      headers,
      redirect: "error",
    }),
  ]);

  if (versionResponse.status !== 404)
    throw new Error("npm-version-exists-or-registry-is-ambiguous");

  if (!latestResponse.ok) throw new Error("npm-latest-is-ambiguous");

  if (tagResponse.status !== 404 || releaseResponse.status !== 404)
    throw new Error("github-release-conflict");

  const latest = packageSchema.pick({ version: true }).parse(await latestResponse.json()).version;

  if (compareVersions(version, latest) <= 0) throw new Error("release-would-not-advance-latest");
}

export function changelogNotes(changelog: string, version: string): string {
  const escaped = version.replaceAll(".", "\\.");
  const match = new RegExp(`(?:^|\\n)## ${escaped}\\n([\\s\\S]*?)(?=\\n## |$)`).exec(changelog);

  if (!match?.[1].trim()) throw new Error("missing-release-notes");

  return match[1].trim() + "\n";
}

async function main(): Promise<void> {
  const eventPath = process.env.GITHUB_EVENT_PATH ?? "";
  const expectedBot = process.env.GITHUB_APP_BOT_LOGIN ?? "";
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const token = process.env.GITHUB_TOKEN ?? "";
  const output = process.env.GITHUB_OUTPUT ?? "";

  if (!eventPath || !expectedBot || !repository || !token || !output)
    throw new Error("missing-workflow-configuration");

  const event = eventSchema.parse(JSON.parse(await readFile(eventPath, "utf8")));
  const pull = event.pull_request;
  const checkedOutSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  validatePublishIdentity({
    merged: pull.merged,
    mergeSha: pull.merge_commit_sha,
    checkedOutSha,
    headRepository: pull.head.repo.full_name,
    baseRepository: pull.base.repo.full_name,
    baseRef: pull.base.ref,
    headRef: pull.head.ref,
    author: pull.user.login,
    expectedBot,
  });

  const changed = execFileSync(
    "git",
    ["diff", "--name-status", `${checkedOutSha}^`, checkedOutSha],
    {
      encoding: "utf8",
    },
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, filename] = line.split("\t");

      return { filename, status: status === "D" ? "removed" : "modified" };
    });

  const packageJson = await readFile("package.json", "utf8");
  const packageLock = await readFile("package-lock.json", "utf8");
  const changelog = await readFile("CHANGELOG.md", "utf8");

  const basePackageJson = execFileSync("git", ["show", `${checkedOutSha}^:package.json`], {
    encoding: "utf8",
  });

  const basePackageLock = execFileSync("git", ["show", `${checkedOutSha}^:package-lock.json`], {
    encoding: "utf8",
  });

  const version = validateReleaseCandidate({
    changed,
    packageJson,
    packageLock,
    changelog,
    basePackageJson,
    basePackageLock,
  });

  await assertPublishConflictsAbsent(repository, version, token);
  const notesPath = `${process.env.RUNNER_TEMP ?? "."}/release-notes.md`;
  await writeFile(notesPath, changelogNotes(changelog, version));
  await appendFile(
    output,
    `version=${version}\ntag=v${version}\nnotes=${notesPath}\nsha=${checkedOutSha}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
