import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(
  new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")),
);

const extension = fileURLToPath(new URL("../../src/index.ts", import.meta.url));

/** Real Pi subprocess; the caller supplies an isolated profile and explicit environment. */
export async function runDoctor(root: string, env: NodeJS.ProcessEnv) {
  const args = [
    cli,
    "--print",
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
    "--extension",
    extension,
    "--provider",
    "openrouter",
    "--model",
    "openai/gpt-5.6-luna",
    "--thinking",
    "off",
    "/typesafe-router doctor",
    "/typesafe-router status",
  ];

  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      args,
      { cwd: root, env, timeout: 100_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024 },
      (error, stdout, stderr) => {
        // execFile errors contain captured provider output. Do not print them or attach a cause.
        if (error) reject(new Error("Pi E2E subprocess failed or exceeded its 100s deadline."));
        else resolve({ stdout, stderr });
      },
    );

    child.stdin?.end();
  });
}
