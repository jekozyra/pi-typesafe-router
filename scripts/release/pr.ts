import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { isManagedReleasePullRequest, validateReleaseCandidate } from "./candidate.ts";
import { buildModelInput, type PullRequestFile } from "./input.ts";
import { createReleaseModels, type ReleaseModels } from "./models.ts";
import {
  generatedChangesetPath,
  parseReleaseLabels,
  RELEASE_LABELS,
  releaseNoteFromBody,
  serializeChangeset,
  validateGeneratedChangeset,
  type ReleaseImpact,
} from "./policy.ts";

const CHECK_NAME = "release / changeset";

export interface PullRequestState {
  action: string;
  number: number;
  title: string;
  body: string;
  labels: readonly string[];
  headRepository: string;
  baseRepository: string;
  baseRef: string;
  headRef: string;
  author: string;
  headSha: string;
  baseSha: string;
  labelActors: Readonly<Record<string, string | undefined>>;
  latestCommit?: { author: string; files: readonly string[] };
}

export interface PullRequestPort {
  listFiles(): Promise<readonly PullRequestFile[]>;
  permission(actor: string): Promise<"admin" | "maintain" | "write" | "triage" | "read" | "none">;
  readFile(path: string, ref: string): Promise<string | undefined>;
  writeGeneratedFile(input: {
    path: string;
    expectedHead: string;
    content: string | undefined;
    message: string;
  }): Promise<string>;
  verifiedBotUpdate(headSha: string, botLogin: string): Promise<boolean>;
  assertHead(expectedHead: string): Promise<void>;
  check(input: {
    name: string;
    headSha: string;
    conclusion: "success" | "failure";
    summary: string;
  }): Promise<void>;
}

export interface AutomationResult {
  impact: ReleaseImpact;
  headSha: string;
  source: "model" | "override" | "verified-bot-update" | "release-candidate";
}

function canOverride(permission: Awaited<ReturnType<PullRequestPort["permission"]>>): boolean {
  return permission === "admin" || permission === "maintain" || permission === "write";
}

export async function runPullRequestAutomation(
  pr: PullRequestState,
  port: PullRequestPort,
  models: ReleaseModels,
  botLogin: string,
  signal: AbortSignal,
): Promise<AutomationResult> {
  if (pr.headRepository !== pr.baseRepository)
    throw new Error("fork-pull-requests-are-not-supported");

  if (
    isManagedReleasePullRequest({
      headRepository: pr.headRepository,
      baseRepository: pr.baseRepository,
      baseRef: pr.baseRef,
      headRef: pr.headRef,
      author: pr.author,
      expectedBot: botLogin,
    })
  ) {
    const files = await port.listFiles();

    const [packageJson, packageLock, changelog, basePackageJson, basePackageLock] =
      await Promise.all([
        port.readFile("package.json", pr.headSha),
        port.readFile("package-lock.json", pr.headSha),
        port.readFile("CHANGELOG.md", pr.headSha),
        port.readFile("package.json", pr.baseSha),
        port.readFile("package-lock.json", pr.baseSha),
      ]);

    if (!packageJson || !packageLock || !changelog || !basePackageJson || !basePackageLock)
      throw new Error("release-candidate-files-unavailable");

    const version = validateReleaseCandidate({
      changed: files,
      packageJson,
      packageLock,
      changelog,
      basePackageJson,
      basePackageLock,
    });

    await port.assertHead(pr.headSha);
    await port.check({
      name: CHECK_NAME,
      headSha: pr.headSha,
      conclusion: "success",
      summary: `Validated managed release candidate v${version}.`,
    });

    return { impact: "none", headSha: pr.headSha, source: "release-candidate" };
  }

  const path = generatedChangesetPath(pr.number);
  const override = parseReleaseLabels(pr.labels);

  if (override) {
    const label = `release:${override}`;
    const actor = pr.labelActors[label];

    if (!actor || !canOverride(await port.permission(actor)))
      throw new Error("unauthorized-release-override");
  }

  if (
    pr.action === "synchronize" &&
    !override &&
    pr.latestCommit?.author === botLogin &&
    pr.latestCommit.files.length === 1 &&
    pr.latestCommit.files[0] === path &&
    (await port.verifiedBotUpdate(pr.headSha, botLogin))
  ) {
    const content = await port.readFile(path, pr.headSha);

    if (!content) throw new Error("missing-generated-changeset");
    const existing = validateGeneratedChangeset(content);
    const impact: ReleaseImpact = existing.impact;

    await port.assertHead(pr.headSha);
    await port.check({
      name: CHECK_NAME,
      headSha: pr.headSha,
      conclusion: "success",
      summary: `Verified the controller's generated ${impact} changeset.`,
    });

    return { impact, headSha: pr.headSha, source: "verified-bot-update" };
  }

  let impact: ReleaseImpact;
  let description: string | undefined;
  let source: AutomationResult["source"];

  if (override) {
    impact = override;
    description = override === "none" ? undefined : releaseNoteFromBody(pr.body);
    source = "override";
  } else {
    const files = await port.listFiles();

    const input = buildModelInput({
      number: pr.number,
      title: pr.title,
      body: pr.body,
      files,
    });

    impact = await models.classify(input, signal);
    description = impact === "none" ? undefined : await models.describe(input, impact, signal);
    source = "model";
  }

  let content: string | undefined;

  if (impact !== "none") {
    if (description === undefined) throw new Error("missing-release-description");

    content = serializeChangeset(impact, description);
  }

  const existing = await port.readFile(path, pr.headSha);
  let finalHead = pr.headSha;

  if (existing !== content) {
    finalHead = await port.writeGeneratedFile({
      path,
      expectedHead: pr.headSha,
      content,
      message: `${content ? "chore: update" : "chore: remove"} generated changeset for #${pr.number}`,
    });
  }

  await port.assertHead(finalHead);
  await port.check({
    name: CHECK_NAME,
    headSha: finalHead,
    conclusion: "success",
    summary:
      impact === "none"
        ? `No release required (${source}).`
        : `Generated a ${impact} release changeset (${source}).`,
  });

  return { impact, headSha: finalHead, source };
}

const eventSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable(),
    labels: z.array(z.object({ name: z.string() })),
    user: z.object({ login: z.string() }),
    base: z.object({
      sha: z.string(),
      ref: z.string(),
      repo: z.object({ full_name: z.string() }),
    }),
    head: z.object({ sha: z.string(), ref: z.string(), repo: z.object({ full_name: z.string() }) }),
  }),
  repository: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }),
});

const githubFileSchema = z.object({
  filename: z.string(),
  status: z.enum(["added", "modified", "removed", "renamed", "copied", "changed"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().optional(),
  previous_filename: z.string().optional(),
});

const latestCommitSchema = z.object({
  author: z.object({ login: z.string() }).nullish(),
  files: z.array(z.object({ filename: z.string() })).optional(),
});

const checkRunsSchema = z.object({
  check_runs: z.array(
    z.object({
      name: z.string(),
      conclusion: z.string().nullable(),
      app: z.object({ slug: z.string() }).nullable(),
    }),
  ),
});

const permissionSchema = z.object({
  permission: z.enum(["admin", "maintain", "write", "triage", "read", "none"]).catch("none"),
});

const refSchema = z.object({ object: z.object({ sha: z.string() }) });

const commitSchema = z.object({ tree: z.object({ sha: z.string() }) });

const shaSchema = z.object({ sha: z.string() });

const issueEventsSchema = z.array(
  z.object({
    event: z.string().optional(),
    label: z.object({ name: z.string().optional() }).optional(),
    actor: z.object({ login: z.string().optional() }).optional(),
  }),
);

export class GitHubPort implements PullRequestPort {
  constructor(
    private readonly token: string,
    private readonly owner: string,
    private readonly repo: string,
    private readonly prNumber: number,
    private readonly headRef: string,
  ) {}

  private async api(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`https://api.github.com${path}`, {
      ...init,
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(30_000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...init.headers,
      },
    });

    if (!response.ok) throw new Error(`github-api-${response.status}`);

    return response;
  }

  private async apiJson<Schema extends z.ZodType>(
    path: string,
    schema: Schema,
    init: RequestInit = {},
  ): Promise<z.output<Schema>> {
    return schema.parse(await (await this.api(path, init)).json());
  }

  async latestCommit(headSha: string): Promise<{ author: string; files: string[] }> {
    const value = await this.apiJson(
      `/repos/${this.owner}/${this.repo}/commits/${headSha}`,
      latestCommitSchema,
    );

    return {
      author: value.author?.login ?? "",
      files: (value.files ?? []).map(({ filename }) => filename),
    };
  }

  async listFiles(): Promise<readonly PullRequestFile[]> {
    const files: PullRequestFile[] = [];

    for (let page = 1; ; page++) {
      const batch = await this.apiJson(
        `/repos/${this.owner}/${this.repo}/pulls/${this.prNumber}/files?per_page=100&page=${page}`,
        z.array(githubFileSchema),
      );

      files.push(...batch);

      if (batch.length < 100) return files;

      if (files.length > 200) return files;
    }
  }

  async verifiedBotUpdate(headSha: string, botLogin: string): Promise<boolean> {
    const value = await this.apiJson(
      `/repos/${this.owner}/${this.repo}/commits/${headSha}/check-runs?per_page=100`,
      checkRunsSchema,
    );

    const appSlug = botLogin.replace(/\[bot\]$/, "");

    return value.check_runs.some(
      (check) =>
        check.name === CHECK_NAME && check.conclusion === "success" && check.app?.slug === appSlug,
    );
  }

  async assertHead(expectedHead: string): Promise<void> {
    const current = await this.apiJson(
      `/repos/${this.owner}/${this.repo}/git/ref/heads/${encodeURIComponent(this.headRef)}`,
      refSchema,
    );

    if (current.object.sha !== expectedHead) throw new Error("stale-head");
  }

  async permission(
    actor: string,
  ): Promise<"admin" | "maintain" | "write" | "triage" | "read" | "none"> {
    const value = await this.apiJson(
      `/repos/${this.owner}/${this.repo}/collaborators/${encodeURIComponent(actor)}/permission`,
      permissionSchema,
    );

    return value.permission;
  }

  async readFile(path: string, ref: string): Promise<string | undefined> {
    const response = await fetch(
      `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      {
        signal: AbortSignal.timeout(30_000),
        headers: {
          Accept: "application/vnd.github.raw+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );

    if (response.status === 404) return undefined;

    if (!response.ok) throw new Error(`github-api-${response.status}`);

    const releaseMetadata = ["package.json", "package-lock.json", "CHANGELOG.md"].includes(path);
    const maxBytes = releaseMetadata ? 1024 * 1024 : 8 * 1024;

    const sizeError = releaseMetadata
      ? "release-candidate-file-too-large"
      : "generated-changeset-too-large";

    const declared = Number(response.headers.get("content-length"));

    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel();
      throw new Error(sizeError);
    }

    const reader = response.body?.getReader();

    if (!reader) throw new Error("github-invalid-response");

    const chunks: Uint8Array[] = [];
    let length = 0;

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      length += value.byteLength;

      if (length > maxBytes) {
        await reader.cancel();
        throw new Error(sizeError);
      }

      chunks.push(value);
    }

    const bytes = new Uint8Array(length);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return new TextDecoder().decode(bytes);
  }

  async writeGeneratedFile(input: {
    path: string;
    expectedHead: string;
    content: string | undefined;
    message: string;
  }): Promise<string> {
    const current = await this.apiJson(
      `/repos/${this.owner}/${this.repo}/git/ref/heads/${encodeURIComponent(this.headRef)}`,
      refSchema,
    );

    if (current.object.sha !== input.expectedHead) throw new Error("stale-head");

    const parent = await this.apiJson(
      `/repos/${this.owner}/${this.repo}/git/commits/${input.expectedHead}`,
      commitSchema,
    );

    const treeEntry = input.content
      ? {
          path: input.path,
          mode: "100644",
          type: "blob",
          content: input.content,
        }
      : { path: input.path, mode: "100644", type: "blob", sha: null };

    const tree = await this.apiJson(`/repos/${this.owner}/${this.repo}/git/trees`, shaSchema, {
      method: "POST",
      body: JSON.stringify({ base_tree: parent.tree.sha, tree: [treeEntry] }),
    });

    const commit = await this.apiJson(`/repos/${this.owner}/${this.repo}/git/commits`, shaSchema, {
      method: "POST",
      body: JSON.stringify({
        message: input.message,
        tree: tree.sha,
        parents: [input.expectedHead],
      }),
    });

    await this.api(
      `/repos/${this.owner}/${this.repo}/git/refs/heads/${encodeURIComponent(this.headRef)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ sha: commit.sha, force: false }),
      },
    );

    return commit.sha;
  }

  async check(input: {
    name: string;
    headSha: string;
    conclusion: "success" | "failure";
    summary: string;
  }): Promise<void> {
    await this.api(`/repos/${this.owner}/${this.repo}/check-runs`, {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        head_sha: input.headSha,
        status: "completed",
        conclusion: input.conclusion,
        output: { title: input.name, summary: input.summary },
      }),
    });
  }
}

async function findLabelActors(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  labels: readonly string[],
): Promise<Record<string, string>> {
  const wanted = new Set(labels.filter((label) => label.startsWith("release:")));
  const actors: Record<string, string> = {};

  for (let page = 1; wanted.size && page <= 10; page++) {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/events?per_page=100&page=${page}`,
      {
        signal: AbortSignal.timeout(30_000),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );

    if (!response.ok) throw new Error(`github-api-${response.status}`);

    const events = issueEventsSchema.parse(await response.json());

    for (const event of events) {
      const label = event.label?.name;
      const actor = event.actor?.login;

      if (event.event === "labeled" && label && actor && wanted.has(label)) actors[label] = actor;

      if (event.event === "unlabeled" && label) delete actors[label];
    }

    if (events.length < 100) return actors;

    if (page === 10) throw new Error("label-history-too-large");
  }

  return actors;
}

async function main(): Promise<void> {
  const token = process.env.GITHUB_APP_TOKEN ?? "";
  const apiKey = process.env.OPENROUTER_API_KEY ?? "";
  const botLogin = process.env.GITHUB_APP_BOT_LOGIN ?? "";
  const classifierModel = process.env.RELEASE_CLASSIFIER_MODEL ?? "";
  const writerModel = process.env.RELEASE_WRITER_MODEL ?? "";
  const eventPath = process.env.GITHUB_EVENT_PATH;

  if (!token || !botLogin || !classifierModel || !writerModel || !eventPath)
    throw new Error("missing-workflow-configuration");
  const event = eventSchema.parse(JSON.parse(await readFile(eventPath, "utf8")));
  const pull = event.pull_request;
  const owner = event.repository.owner.login;
  const repo = event.repository.name;
  const labels = pull.labels.map(({ name }) => name);
  const port = new GitHubPort(token, owner, repo, pull.number, pull.head.ref);
  const labelActors = await findLabelActors(token, owner, repo, pull.number, labels);
  const hasOverride = labels.some((label) => RELEASE_LABELS.includes(label));
  const latestCommit = hasOverride ? undefined : await port.latestCommit(pull.head.sha);

  const pr: PullRequestState = {
    action: event.action,
    number: pull.number,
    title: pull.title,
    body: pull.body ?? "",
    labels,
    headRepository: pull.head.repo.full_name,
    baseRepository: pull.base.repo.full_name,
    baseRef: pull.base.ref,
    headRef: pull.head.ref,
    author: pull.user.login,
    headSha: pull.head.sha,
    baseSha: pull.base.sha,
    labelActors,
    latestCommit,
  };

  let releaseModels: ReleaseModels | undefined;

  const getModels = () =>
    (releaseModels ??= createReleaseModels(apiKey, undefined, {
      classifier: classifierModel,
      writer: writerModel,
    }));

  const models: ReleaseModels = {
    classify(input, signal) {
      return getModels().classify(input, signal);
    },
    describe(input, impact, signal) {
      return getModels().describe(input, impact, signal);
    },
  };

  try {
    await runPullRequestAutomation(pr, port, models, botLogin, AbortSignal.timeout(60_000));
  } catch (error) {
    await port.check({
      name: CHECK_NAME,
      headSha: pr.headSha,
      conclusion: "failure",
      summary: error instanceof Error ? error.message : "release-automation-failed",
    });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
