import { test } from "node:test";
import assert from "node:assert/strict";
import { archivePaths, normaliseEtag, parseSourceKey, sourceKeyFromAccessUri } from "./keys.ts";

const KEY = "audiomoth/did:plc:abc123/0123456789abcdef/20260101_120000.WAV";

test("archive paths mirror the source key and add the etag", () => {
  const parsed = parseSourceKey(KEY);
  assert.ok(parsed);
  assert.deepEqual(archivePaths(parsed, "9b2cf535f27731c974343645a3985328"), {
    objectKey: "audio/v1/did:plc:abc123/0123456789abcdef/20260101_120000.WAV/9b2cf535f27731c974343645a3985328.wav",
    manifestKey: "audio/v1/did:plc:abc123/0123456789abcdef/20260101_120000.WAV/9b2cf535f27731c974343645a3985328.manifest.json",
  });
});

test("rejects keys the app's upload route cannot create", () => {
  assert.equal(parseSourceKey("audiomoth/did:plc:abc/not-a-deployment/x.wav"), null);
  assert.equal(parseSourceKey("audiomoth/did:plc:abc/unassigned/x.mp3"), null);
  assert.equal(parseSourceKey("data-jobs/did:plc:abc/unassigned/x.wav"), null);
  assert.equal(parseSourceKey("audiomoth/did:plc:abc/unassigned/../x.wav"), null);
});

test("normalises quoted and multipart etags", () => {
  assert.equal(normaliseEtag('"abc123"'), "abc123");
  assert.equal(normaliseEtag('"abc123-4"'), "abc123-4");
  assert.equal(normaliseEtag(undefined), null);
  assert.equal(normaliseEtag('"a/b"'), null);
});

test("reads the source key back from an ac.audio accessUri", () => {
  const uri = `https://www.gainforest.app/api/audiomoth/recordings?key=${encodeURIComponent(KEY)}`;
  assert.equal(sourceKeyFromAccessUri(uri), KEY);
  assert.equal(sourceKeyFromAccessUri("https://example.com/file.wav"), null);
  assert.equal(sourceKeyFromAccessUri(null), null);
});
