import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { acquireLock } from "./lock.ts";

// The CLI is exercised as a process, the way launchd runs it. Nothing here
// reaches a network: bad arguments and missing config stop it before any S3
// client exists, and the endpoints below point at a port nothing listens on.
const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const KEY = "audiomoth/did:plc:abcdefghijklmnopqrstuvwx/0123456789abcdef/20260101_120000.WAV";

function runCli(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  const lines = (text: string) => text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { level: string; event: string; [key: string]: unknown });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, stdoutEvents: () => lines(result.stdout), stderrEvents: () => lines(result.stderr) };
}

/** Like runCli, but leaves this process's event loop free (a held lock must answer the CLI's probe). */
async function runCliAsync(args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH ?? "", ...env } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const [status] = (await once(child, "close")) as [number | null];
  const lines = (text: string) => text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { level: string; event: string; [key: string]: unknown });
  return { status, stdout, stderr, stdoutEvents: () => lines(stdout), stderrEvents: () => lines(stderr) };
}

const UNREACHABLE = "http://127.0.0.1:1";
const CONFIGURED = {
  DATA_JOBS_S3_ENDPOINT: UNREACHABLE,
  DATA_JOBS_S3_BUCKET: "source",
  DATA_JOBS_S3_ACCESS_KEY_ID: "id",
  DATA_JOBS_S3_SECRET_ACCESS_KEY: "secret",
  ARCHIVE_S3_ENDPOINT: UNREACHABLE,
  ARCHIVE_S3_BUCKET: "archive",
  ARCHIVE_S3_ACCESS_KEY_ID: "id",
  ARCHIVE_S3_SECRET_ACCESS_KEY: "secret",
};

for (const [args, complaint] of [
  [["run", "--dryrun"], 'Unknown argument "--dryrun" for run.'],
  [["run", "now"], 'Unknown argument "now" for run.'],
  [[], "Missing command."],
  [["backup"], 'Unknown command "backup".'],
  [["copy-one"], "copy-one takes exactly one <key>."],
  [["copy-one", KEY, "other"], "copy-one takes exactly one <key>."],
  [["copy-one", KEY, "--forse"], 'Unknown option "--forse" for copy-one.'],
  [["copy-one", "audiomoth/not-a-key.wav"], 'Not an AudioMoth original key: "audiomoth/not-a-key.wav".'],
] as const) {
  test(`${args.join(" ") || "no arguments"} is rejected with usage and exit code 2, before anything runs`, () => {
    const { status, stderr } = runCli([...args]);

    assert.equal(status, 2);
    assert.ok(stderr.includes(complaint), `expected "${complaint}" in: ${stderr}`);
    assert.ok(stderr.includes("Usage:"));
  });
}

test("missing configuration names the variables and where to set them", () => {
  const { status, stderrEvents } = runCli(["run"]);

  assert.equal(status, 1);
  const [fatal] = stderrEvents();
  assert.equal(fatal?.event, "fatal");
  assert.equal(fatal?.level, "error");
  assert.match(String(fatal?.error), /Missing DATA_JOBS_S3_ENDPOINT, DATA_JOBS_S3_BUCKET.*Copy \.env\.example to \.env/);
});

test("an AWS archive endpoint without a region stops the run and says which setting to add", () => {
  const { status, stderrEvents } = runCli(["run", "--dry-run"], {
    ...CONFIGURED,
    ARCHIVE_S3_ENDPOINT: "https://s3.eu-west-3.amazonaws.com",
  });

  assert.equal(status, 1);
  assert.match(String(stderrEvents()[0]?.error), /ARCHIVE_S3_REGION=eu-west-3/);
});

/** Hold the lock the way a running archive would, on a port the CLI is told to use. */
async function withLockHeld<T>(use: (port: number) => Promise<T>): Promise<T> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  const release = await acquireLock(port);
  assert.ok(release);
  try {
    return await use(port);
  } finally {
    await release();
  }
}

test("a run that finds the lock held exits quietly without touching S3", async () => {
  await withLockHeld(async (port) => {
    const { status, stdoutEvents } = await runCliAsync(["run"], { ...CONFIGURED, AUDIO_ARCHIVE_LOCK_PORT: String(port) });

    assert.equal(status, 0);
    assert.deepEqual(stdoutEvents().map((event) => event.event), ["already_running"]);
  });
});

test("a dry run does not take the lock, so it works while a real run holds it", async () => {
  await withLockHeld(async (port) => {
    const { status, stdout, stderrEvents } = await runCliAsync(["run", "--dry-run"], { ...CONFIGURED, AUDIO_ARCHIVE_LOCK_PORT: String(port) });

    assert.ok(!stdout.includes("already_running"), "the dry run was stopped by the lock");
    // It got as far as listing the (unreachable) source bucket.
    assert.equal(status, 1);
    assert.equal(stderrEvents()[0]?.event, "fatal");
  });
});

test("a port held by some other program stops the run loudly instead of looking like a busy run", async () => {
  const other = createServer((socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  const { port } = other.address() as AddressInfo;
  try {
    const { status, stderrEvents } = await runCliAsync(["run"], { ...CONFIGURED, AUDIO_ARCHIVE_LOCK_PORT: String(port) });

    assert.equal(status, 1);
    assert.match(String(stderrEvents()[0]?.error), /in use by another program.*AUDIO_ARCHIVE_LOCK_PORT/);
  } finally {
    await new Promise((resolve) => other.close(resolve));
  }
});
