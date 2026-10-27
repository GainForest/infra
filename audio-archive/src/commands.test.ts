import { afterEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { copyOneCommand, parseArgs, runCommand, type CommandConfig } from "./commands.ts";
import { parseSourceKey } from "./keys.ts";
import { FakeS3, s3Error } from "./testing/fake-s3.ts";
import { captureLogs, indexerPage, stubFetch, stubRecordWorld } from "./testing/stubs.ts";

const UPLOADER = "did:plc:abcdefghijklmnopqrstuvwx";
const keyFor = (file: string) => `audiomoth/${UPLOADER}/0123456789abcdef/${file}`;
const SETTLED = new Date(Date.now() - 2 * 60 * 60_000);
const CONFIG: CommandConfig = { indexerUrl: "https://indexer.test/graphql", pdsHosts: ["pds.example.com"], minAgeMinutes: 30, maxBytesPerSecond: undefined };

afterEach(() => mock.restoreAll());

function emptyIndexer() {
  stubFetch(() => indexerPage([]));
}

for (const [label, expectedLevel, expectedCode, arrange] of [
  [
    "a clean run",
    "info",
    0,
    (source: FakeS3) => {
      source.put(keyFor("fine.wav"), "fine", SETTLED);
      emptyIndexer();
    },
  ],
  [
    "a run that skipped a key it does not recognise",
    "warn",
    0,
    (source: FakeS3) => {
      source.put(`audiomoth/${UPLOADER}/not-a-deployment/odd.wav`, "odd", SETTLED);
      emptyIndexer();
    },
  ],
  [
    "a run that found archived bytes differing from the uploader's own record",
    "warn",
    0,
    (source: FakeS3) => {
      source.put(keyFor("changed.wav"), "bytes", SETTLED);
      stubRecordWorld({ key: keyFor("changed.wav"), ownerDid: UPLOADER, originalCid: "bafkreiwrong" });
    },
  ],
  [
    "a run in which a copy failed",
    "error",
    1,
    (source: FakeS3) => {
      source.put(keyFor("denied.wav"), "denied", SETTLED);
      source.intercept = (command) => {
        if (command instanceof GetObjectCommand) throw s3Error("AccessDenied", 403);
        return undefined;
      };
      emptyIndexer();
    },
  ],
] as const) {
  test(`run_complete is logged at ${expectedLevel} after ${label}, and the exit code is ${expectedCode}`, async () => {
    const logs = captureLogs();
    const source = new FakeS3("source");
    const archive = new FakeS3("archive");
    arrange(source);

    const code = await runCommand(CONFIG, source.bucket, archive.bucket, { dryRun: false });

    assert.equal(logs.find((line) => line.event === "run_complete")?.level, expectedLevel);
    assert.equal(code, expectedCode);
  });
}

// ---- copy-one ----

const target = parseSourceKey(keyFor("one.wav"))!;
const getsFrom = (source: FakeS3) => source.calls.filter((call) => call.startsWith("GetObject")).length;

function quietly() {
  captureLogs();
  const refusals: string[] = [];
  mock.method(console, "error", (message: unknown) => {
    refusals.push(String(message));
  });
  return refusals;
}

test("copy-one will not repeat an archived copy unless --force is given", async () => {
  const refusals = quietly();
  emptyIndexer();
  const source = new FakeS3("source");
  const archive = new FakeS3("archive");
  source.put(keyFor("one.wav"), "the only bytes", SETTLED);

  assert.equal(await copyOneCommand(CONFIG, source.bucket, archive.bucket, target, false), 0);
  assert.equal(getsFrom(source), 1);

  assert.equal(await copyOneCommand(CONFIG, source.bucket, archive.bucket, target, false), 1);
  assert.equal(getsFrom(source), 1, "an archived file was read from the source again");
  assert.match(refusals.join("\n"), /Already archived: s3:\/\/archive\/.*\.manifest\.json\nPass --force to copy it again\./);

  assert.equal(await copyOneCommand(CONFIG, source.bucket, archive.bucket, target, true), 0);
  assert.equal(getsFrom(source), 2);
});

test("copy-one does not report success for a file that changed under it", async () => {
  quietly();
  emptyIndexer();
  const source = new FakeS3("source");
  const archive = new FakeS3("archive");
  source.put(keyFor("one.wav"), "version one", SETTLED);
  source.intercept = (command) => {
    if (command instanceof GetObjectCommand) source.put(keyFor("one.wav"), "version two", SETTLED);
    return undefined;
  };

  assert.equal(await copyOneCommand(CONFIG, source.bucket, archive.bucket, target, false), 1);
  assert.equal(archive.objects.size, 0);
});

test("run --limit takes a whole number of files", () => {
  assert.deepEqual(parseArgs(["run", "--limit", "20"]), { name: "run", dryRun: false, limit: 20 });
  assert.deepEqual(parseArgs(["run", "--", "--dry-run", "--limit=5"]), { name: "run", dryRun: true, limit: 5 });
  for (const bad of [["--limit"], ["--limit", "0"], ["--limit", "2.5"], ["--limit", "-3"], ["--limit=ten"]]) {
    assert.match(String(parseArgs(["run", ...bad])), /--limit needs a whole number/, bad.join(" "));
  }
});
