import { afterEach, test, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { GetObjectCommand, UploadPartCommand } from "@aws-sdk/client-s3";
import { archivePaths, parseSourceKey } from "./keys.ts";
import { runOnce, type RunOptions } from "./run.ts";
import { endlessBody, FakeS3, s3Error } from "./testing/fake-s3.ts";
import { captureLogs, indexerPage, stubFetch, stubRecordWorld } from "./testing/stubs.ts";

const UPLOADER = "did:plc:abcdefghijklmnopqrstuvwx";
const keyFor = (file: string) => `audiomoth/${UPLOADER}/0123456789abcdef/${file}`;
const md5 = (text: string) => createHash("md5").update(text).digest("hex");
const HOUR = 60 * 60_000;
const SETTLED = new Date(Date.now() - 2 * HOUR);
const FRESH = new Date(Date.now() - 5 * 60_000);

const OPTIONS: RunOptions = { indexerUrl: "https://indexer.test/graphql", pdsHosts: ["pds.example.com"], dryRun: false, minAgeMs: 30 * 60_000 };

/** Source and archive buckets, with no record links in the indexer. */
function setup() {
  const logs = captureLogs();
  stubFetch(() => indexerPage([]));
  return { logs, source: new FakeS3("source"), archive: new FakeS3("archive") };
}

const manifestKeyFor = (file: string, etag: string) => archivePaths(parseSourceKey(keyFor(file))!, etag).manifestKey;

afterEach(() => mock.restoreAll());

test("a file is pending unless a manifest exists for its current ETag", async () => {
  const { logs, source, archive } = setup();
  const archivedEtag = source.put(keyFor("archived.wav"), "same bytes", SETTLED);
  source.put(keyFor("reuploaded.wav"), "second version", SETTLED);
  source.put(keyFor("new.wav"), "never seen", SETTLED);
  archive.put(manifestKeyFor("archived.wav", archivedEtag), "{}");
  archive.put(manifestKeyFor("reuploaded.wav", md5("first version")), "{}");

  const summary = await runOnce(source.bucket, archive.bucket, { ...OPTIONS, dryRun: true });

  const planned = logs.filter((line) => line.event === "would_copy");
  assert.deepEqual(
    planned.map((line) => [line.key, line.etag]),
    [
      [keyFor("new.wav"), md5("never seen")],
      [keyFor("reuploaded.wav"), md5("second version")],
    ],
  );
  assert.equal(summary.pending, 2);
  assert.equal(archive.keys().length, 2, "a dry run wrote to the archive");
});

test("keys the app could not have created are counted and logged with their ETag", async () => {
  const { logs, source, archive } = setup();
  const etag = source.put(`audiomoth/${UPLOADER}/not-a-deployment/x.wav`, "odd", SETTLED);

  const summary = await runOnce(source.bucket, archive.bucket, { ...OPTIONS, dryRun: true });

  assert.equal(summary.skippedKeys, 1);
  assert.equal(summary.pending, 0);
  const warning = logs.find((line) => line.event === "unrecognised_source_key");
  assert.equal(warning?.key, `audiomoth/${UPLOADER}/not-a-deployment/x.wav`);
  assert.equal(warning?.etag, `"${etag}"`);
});

test("a dry run lists files that have not settled separately", async () => {
  const { logs, source, archive } = setup();
  source.put(keyFor("old.wav"), "old", SETTLED);
  source.put(keyFor("fresh.wav"), "fresh", FRESH);

  const summary = await runOnce(source.bucket, archive.bucket, { ...OPTIONS, dryRun: true });

  assert.deepEqual(
    logs.filter((line) => line.event === "would_copy").map((line) => line.key),
    [keyFor("old.wav")],
  );
  assert.deepEqual(
    logs.filter((line) => line.event === "would_skip_too_recent").map((line) => line.key),
    [keyFor("fresh.wav")],
  );
  assert.equal(summary.tooRecent, 1);
});

test("a file that has not settled is left for a later run, without counting as a failure", async () => {
  const { source, archive } = setup();
  source.put(keyFor("old.wav"), "old", SETTLED);
  source.put(keyFor("fresh.wav"), "fresh", FRESH);

  const summary = await runOnce(source.bucket, archive.bucket, OPTIONS);

  assert.deepEqual(summary, { pending: 1, copied: 1, failed: 0, sourceChanged: 0, tooRecent: 1, skippedKeys: 0, cidMismatches: 0, deferredByLimit: 0 });
  assert.equal(archive.keys("old.wav").length, 2);
  assert.equal(archive.keys("fresh.wav").length, 0);
});

test("a file replaced after listing counts as a source change, not a failure", async () => {
  const { logs, source, archive } = setup();
  const key = keyFor("moving.wav");
  source.put(key, "version one", SETTLED);
  source.intercept = (command) => {
    if (command instanceof GetObjectCommand) source.put(key, "version two", SETTLED);
    return undefined;
  };

  const summary = await runOnce(source.bucket, archive.bucket, OPTIONS);

  assert.equal(summary.sourceChanged, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.copied, 0);
  assert.equal(archive.objects.size, 0);
  const warning = logs.find((line) => line.event === "source_changed");
  assert.equal(warning?.level, "warn");
  assert.equal(warning?.httpStatusCode, 412);
});

test("one failing file is logged with its error details and the run carries on", async () => {
  const { logs, source, archive } = setup();
  source.put(keyFor("a-denied.wav"), "denied", SETTLED);
  source.put(keyFor("b-fine.wav"), "fine", SETTLED);
  source.intercept = (command) => {
    if (command instanceof GetObjectCommand && command.input.Key === keyFor("a-denied.wav")) throw s3Error("AccessDenied", 403);
    return undefined;
  };

  const summary = await runOnce(source.bucket, archive.bucket, OPTIONS);

  assert.equal(summary.failed, 1);
  assert.equal(summary.copied, 1);
  assert.equal(archive.keys("b-fine.wav").length, 2);
  const failure = logs.find((line) => line.event === "copy_failed");
  assert.equal(failure?.level, "error");
  assert.equal(failure?.key, keyFor("a-denied.wav"));
  assert.equal(failure?.errorName, "AccessDenied");
  assert.equal(failure?.httpStatusCode, 403);
  assert.equal(failure?.etag, md5("denied"));
});

test("the record is looked up before the transfer starts, and a mismatch is counted", async () => {
  const logs = captureLogs();
  const source = new FakeS3("source");
  const archive = new FakeS3("archive");
  const key = keyFor("recorded.wav");
  source.put(key, "recorded bytes", SETTLED);
  const timeline: string[] = [];
  const { uri } = stubRecordWorld({ key, ownerDid: UPLOADER, originalCid: "bafkreiwrong", onRequest: (host) => timeline.push(`fetch ${host}`) });
  source.intercept = (command) => {
    timeline.push((command as object).constructor.name);
    return undefined;
  };

  const summary = await runOnce(source.bucket, archive.bucket, OPTIONS);

  assert.ok(
    timeline.indexOf("fetch pds.example.com") !== -1 && timeline.indexOf("fetch pds.example.com") < timeline.indexOf("GetObjectCommand"),
    `the record was fetched after the transfer began: ${timeline.join(", ")}`,
  );
  assert.equal(summary.copied, 1);
  assert.equal(summary.cidMismatches, 1);
  assert.equal(logs.find((line) => line.event === "copied_cid_mismatch")?.level, "warn");
  const manifestKey = archive.keys(".manifest.json")[0]!;
  const manifest = JSON.parse(archive.objects.get(manifestKey)!.body.toString());
  assert.equal(manifest.record.uri, uri);
  assert.equal(manifest.record.pdsCid, "bafypds");
  assert.equal(manifest.record.verified, true);
});

test("an interrupt aborts the upload in flight and does not start the next file", async () => {
  const { logs, source, archive } = setup();
  source.put(keyFor("a-first.wav"), "listed only", SETTLED);
  source.put(keyFor("b-second.wav"), "never reached", SETTLED);
  source.intercept = (command) => (command instanceof GetObjectCommand ? { Body: endlessBody() } : undefined);
  const controller = new AbortController();
  archive.intercept = (command) => {
    if (command instanceof UploadPartCommand) controller.abort();
    return undefined;
  };

  const summary = await runOnce(source.bucket, archive.bucket, { ...OPTIONS, signal: controller.signal });

  assert.equal(archive.abortedUploads.length, 1, "the upload in flight was left running");
  assert.equal(archive.objects.size, 0);
  assert.equal(source.calls.filter((call) => call.startsWith("GetObject")).length, 1, "a second file was started");
  assert.equal(summary.copied, 0);
  assert.equal(summary.failed, 0, "an interrupt was reported as a failure");
  assert.equal(logs.some((line) => line.event === "copy_failed"), false);
});

test("--limit copies a slice, and the next limited run carries on without redoing it", async () => {
  const { source, archive } = setup();
  for (const file of ["a.wav", "b.wav", "c.wav"]) source.put(keyFor(file), `bytes of ${file}`, SETTLED);
  const copiedFiles = () => archive.keys().filter((key) => key.endsWith(".wav")).map((key) => key.split("/")[4]).sort();

  const first = await runOnce(source.bucket, archive.bucket, { ...OPTIONS, limit: 2 });
  assert.equal(first.copied, 2);
  assert.equal(first.deferredByLimit, 1);
  assert.deepEqual(copiedFiles(), ["a.wav", "b.wav"]);

  const second = await runOnce(source.bucket, archive.bucket, { ...OPTIONS, limit: 2 });
  assert.equal(second.pending, 1, "files archived by the first slice came up again");
  assert.equal(second.copied, 1);
  assert.equal(second.deferredByLimit, 0);
  assert.deepEqual(copiedFiles(), ["a.wav", "b.wav", "c.wav"]);
});
