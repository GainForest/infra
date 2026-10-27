import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.ts";
import { openBucket } from "./storage.ts";

const SETTINGS = [
  "AUDIO_ARCHIVE_PDS_HOSTS",
  "AWS_REQUEST_CHECKSUM_CALCULATION",
  "AWS_RESPONSE_CHECKSUM_VALIDATION",
  "DATA_JOBS_S3_ENDPOINT",
  "DATA_JOBS_S3_BUCKET",
  "DATA_JOBS_S3_ACCESS_KEY_ID",
  "DATA_JOBS_S3_SECRET_ACCESS_KEY",
  "DATA_JOBS_S3_REGION",
  "ARCHIVE_S3_ENDPOINT",
  "ARCHIVE_S3_BUCKET",
  "ARCHIVE_S3_ACCESS_KEY_ID",
  "ARCHIVE_S3_SECRET_ACCESS_KEY",
  "ARCHIVE_S3_REGION",
  "SOURCE_S3_CHECKSUM_MODE",
  "INDEXER_URL",
  "AUDIO_ARCHIVE_MIN_AGE_MINUTES",
  "AUDIO_ARCHIVE_MAX_MBPS",
  "AUDIO_ARCHIVE_LOCK_PORT",
];

// A working setup: R2 as the source, S3 in eu-west-3 as the archive.
const WORKING = {
  DATA_JOBS_S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  DATA_JOBS_S3_BUCKET: "source",
  DATA_JOBS_S3_ACCESS_KEY_ID: "id",
  DATA_JOBS_S3_SECRET_ACCESS_KEY: "secret",
  DATA_JOBS_S3_REGION: "auto",
  ARCHIVE_S3_ENDPOINT: "https://s3.eu-west-3.amazonaws.com",
  ARCHIVE_S3_BUCKET: "archive",
  ARCHIVE_S3_ACCESS_KEY_ID: "id",
  ARCHIVE_S3_SECRET_ACCESS_KEY: "secret",
  ARCHIVE_S3_REGION: "eu-west-3",
};

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(SETTINGS.map((name) => [name, process.env[name]]));
  for (const name of SETTINGS) delete process.env[name];
  Object.assign(process.env, WORKING);
});

afterEach(() => {
  for (const name of SETTINGS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const withEnv = (settings: Record<string, string | undefined>) => {
  for (const [name, value] of Object.entries(settings)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
};

for (const [endpoint, region, suggestion] of [
  ["https://s3.eu-west-3.amazonaws.com", undefined, "eu-west-3"],
  ["https://s3.eu-west-3.amazonaws.com", "auto", "eu-west-3"],
  ["https://my-bucket.s3.us-east-2.amazonaws.com", "auto", "us-east-2"],
  ["https://s3.amazonaws.com", undefined, "eu-west-3"],
] as const) {
  test(`an AWS archive endpoint (${endpoint}) with region ${region ?? "unset"} is refused, suggesting ${suggestion}`, () => {
    withEnv({ ARCHIVE_S3_ENDPOINT: endpoint, ARCHIVE_S3_REGION: region });

    assert.throws(loadConfig, (error: Error) => {
      assert.match(error.message, /ARCHIVE_S3_REGION is empty or "auto"/);
      assert.ok(error.message.includes(`ARCHIVE_S3_REGION=${suggestion}`), error.message);
      return true;
    });
  });
}

test("the same guard protects a source that is on AWS", () => {
  withEnv({ DATA_JOBS_S3_ENDPOINT: "https://s3.eu-west-1.amazonaws.com", DATA_JOBS_S3_REGION: "auto" });

  assert.throws(loadConfig, /DATA_JOBS_S3_REGION is empty or "auto".*DATA_JOBS_S3_REGION=eu-west-1/);
});

test("AWS with its region set, and R2 with the default region, are accepted", () => {
  withEnv({ DATA_JOBS_S3_REGION: undefined });

  const config = loadConfig();

  assert.equal(config.archive.region, "eu-west-3");
  assert.equal(config.source.region, "auto");
});

test("an endpoint that is not a URL is refused with the setting's name", () => {
  withEnv({ ARCHIVE_S3_ENDPOINT: "s3.eu-west-3.amazonaws.com" });

  assert.throws(loadConfig, /ARCHIVE_S3_ENDPOINT must be a full URL/);
});

for (const [name, value] of [
  ["AUDIO_ARCHIVE_MAX_MBPS", "fast"],
  ["AUDIO_ARCHIVE_MAX_MBPS", "0"],
  ["AUDIO_ARCHIVE_MAX_MBPS", "-5"],
  ["AUDIO_ARCHIVE_MIN_AGE_MINUTES", "-1"],
  ["AUDIO_ARCHIVE_MIN_AGE_MINUTES", "soon"],
  ["AUDIO_ARCHIVE_LOCK_PORT", "0"],
  ["AUDIO_ARCHIVE_LOCK_PORT", "70000"],
  ["AUDIO_ARCHIVE_LOCK_PORT", "80.5"],
  ["SOURCE_S3_CHECKSUM_MODE", "sometimes"],
] as const) {
  test(`${name}=${value} is refused instead of being ignored`, () => {
    withEnv({ [name]: value });

    assert.throws(loadConfig, new RegExp(`${name} must be .*"${value}"`));
  });
}

test("the bandwidth cap is in megabits per second, the settle window in minutes, both optional", () => {
  const defaults = loadConfig();
  assert.equal(defaults.maxBytesPerSecond, undefined);
  assert.equal(defaults.minAgeMinutes, 30);

  withEnv({ AUDIO_ARCHIVE_MAX_MBPS: "8", AUDIO_ARCHIVE_MIN_AGE_MINUTES: "0", AUDIO_ARCHIVE_LOCK_PORT: "40123" });
  const tuned = loadConfig();

  assert.equal(tuned.maxBytesPerSecond, 1_000_000);
  assert.equal(tuned.minAgeMinutes, 0);
  assert.equal(tuned.lockPort, 40123);
});

test("skipping optional checksums applies to the source client only", async () => {
  // The SDK also reads these; clear them so the archive client shows the SDK default.
  withEnv({ SOURCE_S3_CHECKSUM_MODE: "when_required", AWS_REQUEST_CHECKSUM_CALCULATION: undefined, AWS_RESPONSE_CHECKSUM_VALIDATION: undefined });
  const config = loadConfig();
  const source = openBucket(config.source).client.config;
  const archive = openBucket(config.archive).client.config;

  assert.equal(await source.requestChecksumCalculation(), "WHEN_REQUIRED");
  assert.equal(await source.responseChecksumValidation(), "WHEN_REQUIRED");
  assert.equal(await archive.requestChecksumCalculation(), "WHEN_SUPPORTED");
  assert.equal(await archive.responseChecksumValidation(), "WHEN_SUPPORTED");
});

test("record lookups default to the certified.one PDS and accept an explicit host list", () => {
  assert.deepEqual(loadConfig().pdsHosts, ["certified.one"]);
  process.env.AUDIO_ARCHIVE_PDS_HOSTS = " Certified.one , pds.example.org ";
  assert.deepEqual(loadConfig().pdsHosts, ["certified.one", "pds.example.org"]);
});

test("a PDS host list with something that is not a hostname is refused", () => {
  for (const value of ["https://certified.one", "127.0.0.1", "certified.one:443", ","]) {
    process.env.AUDIO_ARCHIVE_PDS_HOSTS = value;
    assert.throws(() => loadConfig(), /AUDIO_ARCHIVE_PDS_HOSTS must be a comma-separated list of hostnames/, value);
  }
});
