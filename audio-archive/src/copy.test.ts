import { errorFields } from "./errors.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { GetObjectCommand, HeadObjectCommand, UploadPartCommand } from "@aws-sdk/client-s3";
import { copyOriginal, headSource, SourceChangedError } from "./copy.ts";
import { archivePaths, parseSourceKey } from "./keys.ts";
import type { FetchedRecord } from "./records.ts";
import { endlessBody, FakeS3, s3Error } from "./testing/fake-s3.ts";

const UPLOADER = "did:plc:abcdefghijklmnopqrstuvwx";
const STRANGER = "did:plc:zzzzzzzzzzzzzzzzzzzzzzzz";
const KEY = `audiomoth/${UPLOADER}/0123456789abcdef/20260101_120000.WAV`;
const MIB = 1024 * 1024;
// The well-known CID of zero bytes (see cid.test.ts).
const EMPTY_CONTENT_CID = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

/** A source bucket holding `body` at KEY, an empty archive, and the target to copy. */
function setup(body: Buffer) {
  const source = new FakeS3("source-bucket");
  const archive = new FakeS3("archive-bucket");
  const etag = source.put(KEY, body);
  const parsed = parseSourceKey(KEY)!;
  return { source, archive, etag, target: { source: parsed, etag }, paths: archivePaths(parsed, etag) };
}

const sha256Hex = (body: Buffer) => createHash("sha256").update(body).digest("hex");

function candidate(rkey: string, ownerDid: string, extra: Partial<FetchedRecord> = {}): FetchedRecord {
  return {
    uri: `at://${ownerDid}/app.gainforest.ac.audio/${rkey}`,
    ownerDid,
    cid: "bafyindexercid",
    originalCid: null,
    pdsCid: "bafypdscid",
    value: { name: "20260101_120000.WAV" },
    ...extra,
  };
}

const SIZES = [
  ["an empty file", 0],
  ["a single byte", 1],
  ["exactly one 16 MiB part", 16 * MIB],
  ["one byte past a part boundary", 16 * MIB + 1],
  ["a multipart file", 40 * MIB + 12_345],
] as const;

for (const [label, size] of SIZES) {
  test(`archives ${label} byte for byte, manifest last`, async () => {
    const body = randomBytes(size);
    const { source, archive, etag, target, paths } = setup(body);

    const manifest = await copyOriginal(source.bucket, archive.bucket, target);

    assert.ok(archive.objects.get(paths.objectKey)!.body.equals(body), "archived bytes differ from the source");
    assert.equal(manifest.sha256, sha256Hex(body));
    assert.match(manifest.cid, /^bafkrei[a-z2-7]{52}$/);
    if (size === 0) assert.equal(manifest.cid, EMPTY_CONTENT_CID);
    assert.equal(manifest.source.bytes, size);
    assert.equal(manifest.source.etag, etag);
    assert.equal(manifest.source.lastModified, "2026-01-01T00:00:00.000Z");
    assert.deepEqual(
      JSON.parse(archive.objects.get(paths.manifestKey)!.body.toString()),
      JSON.parse(JSON.stringify(manifest)),
      "the stored manifest is not the one returned",
    );
    // The manifest is the completion marker: it follows the completed upload and the size check.
    const [completion, head, manifestWrite] = archive.calls.slice(-3);
    assert.match(completion!, new RegExp(`^(PutObject|CompleteMultipartUpload) ${paths.objectKey}$`));
    assert.equal(head, `HeadObject ${paths.objectKey}`);
    assert.equal(manifestWrite, `PutObject ${paths.manifestKey}`);
    if (size > 16 * MIB) assert.ok(archive.calls.some((call) => call.startsWith("CompleteMultipartUpload")));
  });
}

test("reads the source only if it is still the listed version", async () => {
  const { source, archive, etag, target } = setup(Buffer.from("abc"));
  let ifMatch: string | undefined;
  source.intercept = (command) => {
    if (command instanceof GetObjectCommand) ifMatch = command.input.IfMatch;
    return undefined;
  };

  await copyOriginal(source.bucket, archive.bucket, target);

  assert.equal(ifMatch, `"${etag}"`);
});

test("a source replaced after listing is reported as changed and nothing is archived", async () => {
  const { source, archive, target } = setup(Buffer.from("version one"));
  source.put(KEY, "version two, different bytes, different ETag");

  await assert.rejects(copyOriginal(source.bucket, archive.bucket, target), SourceChangedError);

  assert.deepEqual(archive.calls, []);
});

for (const [name, status, isChange] of [
  ["NoSuchKey", 404, true],
  ["PreconditionFailed", 412, true],
  ["NoSuchBucket", 404, false],
  ["AccessDenied", 403, false],
] as const) {
  test(`a ${status} ${name} from the source ${isChange ? "counts as a source change" : "is a real failure"}`, async () => {
    const { source, archive, target } = setup(Buffer.from("abc"));
    source.intercept = (command) => {
      if (command instanceof GetObjectCommand) throw s3Error(name, status);
      return undefined;
    };

    await assert.rejects(copyOriginal(source.bucket, archive.bucket, target), (error: Error) => {
      assert.equal(error instanceof SourceChangedError, isChange);
      return true;
    });
  });
}

test("a failed part surfaces its own error, after the upload was aborted", async () => {
  const { source, archive, target } = setup(Buffer.from("unused"));
  const endless = endlessBody();
  source.intercept = (command) => (command instanceof GetObjectCommand ? { Body: endless } : undefined);
  archive.intercept = (command) => {
    if (command instanceof UploadPartCommand && command.input.PartNumber === 1) throw s3Error("InternalError", 500);
    return undefined;
  };

  await assert.rejects(copyOriginal(source.bucket, archive.bucket, target), (error: Error) => {
    assert.equal(error.name, "InternalError", "the real error was replaced by another");
    return true;
  });

  assert.equal(archive.abortedUploads.length, 1, "the multipart upload was not aborted before the error was raised");
  assert.equal(archive.objects.size, 0, "a partial upload left an object behind");
  assert.ok(endless.destroyed, "the source connection was left open");
});

test("a source that dies mid-stream aborts the upload before the error is raised", async () => {
  const { source, archive, target } = setup(randomBytes(40 * MIB));
  source.intercept = (command) => {
    if (!(command instanceof GetObjectCommand)) return undefined;
    let sent = 0;
    // Dies after 20 MiB: past the first part, so a multipart upload exists to be aborted.
    const Body = new Readable({
      read() {
        if (sent >= 20 * MIB) {
          this.destroy(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
          return;
        }
        sent += 64 * 1024;
        this.push(Buffer.alloc(64 * 1024));
      },
    });
    return { Body, ContentLength: 40 * MIB };
  };

  await assert.rejects(copyOriginal(source.bucket, archive.bucket, target), (error: Error) => {
    // The log must say which side failed and keep the system error code.
    assert.match(error.message, /^Reading the source failed mid-transfer: .*socket hang up/);
    assert.equal(errorFields(error).errorCode, "ECONNRESET");
    return true;
  });

  assert.equal(archive.abortedUploads.length, 1, "the multipart upload was not aborted before the error was raised");
  assert.equal(archive.objects.size, 0);
});

test("a source shorter than it announced is not given a manifest", async () => {
  const { source, archive, target, paths } = setup(Buffer.from("abc"));
  source.intercept = (command) =>
    command instanceof GetObjectCommand ? { Body: Readable.from([Buffer.alloc(10)]), ContentLength: 20 } : undefined;

  await assert.rejects(copyOriginal(source.bucket, archive.bucket, target), /Read 10 bytes .* expected 20/);

  assert.equal(archive.objects.has(paths.manifestKey), false);
});

test("an archived object of the wrong size is not given a manifest", async () => {
  const { source, archive, target, paths } = setup(Buffer.from("abc"));
  archive.intercept = (command) => (command instanceof HeadObjectCommand ? { ContentLength: 999 } : undefined);

  await assert.rejects(copyOriginal(source.bucket, archive.bucket, target), /is 999 bytes, expected 3/);

  assert.equal(archive.objects.has(paths.manifestKey), false);
});

test("paces the transfer to the requested rate", async () => {
  const body = randomBytes(400_000);
  const { source, archive, target, paths } = setup(body);

  const started = performance.now();
  await copyOriginal(source.bucket, archive.bucket, target, { maxBytesPerSecond: 1_000_000 });
  const elapsed = performance.now() - started;

  // Seven chunks, the first free: the last is released about 390 ms in.
  assert.ok(elapsed >= 300, `400 KB at 1 MB/s finished in ${Math.round(elapsed)} ms`);
  assert.ok(archive.objects.get(paths.objectKey)!.body.equals(body));
});

test("an aborted copy stops, aborts its upload and archives nothing", async () => {
  const { source, archive, target } = setup(Buffer.from("unused"));
  const endless = endlessBody();
  source.intercept = (command) => (command instanceof GetObjectCommand ? { Body: endless } : undefined);
  const controller = new AbortController();
  archive.intercept = (command) => {
    if (command instanceof UploadPartCommand) controller.abort();
    return undefined;
  };

  await assert.rejects(copyOriginal(source.bucket, archive.bucket, target, { signal: controller.signal }), { name: "AbortError" });

  assert.equal(archive.abortedUploads.length, 1);
  assert.equal(archive.objects.size, 0);
  assert.ok(endless.destroyed, "the source connection was left open");
});

test("a verified record that disagrees with the bytes leaves a visible mismatch", async () => {
  const { source, archive, target } = setup(Buffer.from("the bytes in the archive"));
  const records = [
    candidate("3kstranger", STRANGER),
    candidate("3kuploader", UPLOADER, { originalCid: "bafkreiwhatthefilewasatupload" }),
  ];

  const manifest = await copyOriginal(source.bucket, archive.bucket, target, { records });

  assert.equal(manifest.record?.uri, `at://${UPLOADER}/app.gainforest.ac.audio/3kuploader`);
  assert.equal(manifest.record?.verified, true);
  assert.equal(manifest.record?.verifiedBy, "uploaderDid");
  assert.equal(manifest.originalCid, "bafkreiwhatthefilewasatupload");
  assert.equal(manifest.cidMismatch, true);
  assert.deepEqual(manifest.record?.otherCandidates, [`at://${STRANGER}/app.gainforest.ac.audio/3kstranger`]);
});

test("a record nobody can vouch for is kept as an unverified hint without a mismatch claim", async () => {
  const { source, archive, target } = setup(Buffer.from("the bytes in the archive"));
  const records = [
    candidate("3kfirst", STRANGER, { originalCid: "bafkreisomethingelse" }),
    candidate("3ksecond", "did:plc:yyyyyyyyyyyyyyyyyyyyyyyy"),
  ];

  const manifest = await copyOriginal(source.bucket, archive.bucket, target, { records });

  assert.equal(manifest.record?.uri, records[0]!.uri);
  assert.equal(manifest.record?.verified, false);
  assert.equal(manifest.record?.verifiedBy, undefined);
  assert.equal(manifest.record?.pdsCid, "bafypdscid");
  assert.equal(manifest.record?.cid, "bafyindexercid");
  assert.deepEqual(manifest.record?.otherCandidates, [records[1]!.uri]);
  assert.equal(manifest.originalCid, undefined);
  assert.equal(manifest.cidMismatch, undefined);
});

test("copy-one's lookup names the missing source object and its bucket", async () => {
  const source = new FakeS3("the-source-bucket");

  await assert.rejects(headSource(source.bucket, KEY), (error: Error) => {
    assert.equal(error.message, `Source object ${KEY} not found in the-source-bucket`);
    return true;
  });
});
