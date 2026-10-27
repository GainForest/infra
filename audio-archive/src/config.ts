export type BucketConfig = {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Set to skip the SDK's optional checksum headers, for stores that reject them. */
  checksumMode?: "WHEN_REQUIRED";
};

export type Config = {
  source: BucketConfig;
  archive: BucketConfig;
  indexerUrl: string;
  /** Hostnames whose PDS the runner may read ac.audio records from. */
  pdsHosts: readonly string[];
  /** Loopback port held while a run is in progress; see lock.ts. */
  lockPort: number;
  /** Source objects younger than this are left for a later run. */
  minAgeMinutes: number;
  /** Transfer speed cap; undefined means unlimited. */
  maxBytesPerSecond: number | undefined;
};

const DEFAULT_INDEXER_URL = "https://api-hi.gainforest.app/graphql";
const DEFAULT_PDS_HOSTS = ["certified.one"];
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DEFAULT_LOCK_PORT = 29437;
const DEFAULT_MIN_AGE_MINUTES = 30;
const AWS_HOST = /(?:^|\.)amazonaws\.com(?:\.cn)?$/i;
const AWS_REGION_IN_HOST = /(?:^|\.)s3[.-]([a-z]{2}(?:-[a-z]+)+-\d)\.amazonaws\.com/i;

function bucketFromEnv(prefix: string, defaultRegion: string): BucketConfig {
  const read = (name: string) => process.env[`${prefix}_${name}`]?.trim() ?? "";
  const missing = ["ENDPOINT", "BUCKET", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY"].filter((name) => !read(name));
  if (missing.length > 0) {
    throw new Error(
      `Missing ${missing.map((name) => `${prefix}_${name}`).join(", ")}. Copy .env.example to .env and fill it in.`,
    );
  }
  const endpoint = read("ENDPOINT").replace(/\/$/, "");
  const region = read("REGION") || defaultRegion;
  assertRegionMatchesEndpoint(prefix, endpoint, region);
  return {
    endpoint,
    bucket: read("BUCKET"),
    region,
    accessKeyId: read("ACCESS_KEY_ID"),
    secretAccessKey: read("SECRET_ACCESS_KEY"),
  };
}

/**
 * The app's getArchiveS3Config() (app/_lib/s3-storage.ts) defaults an empty
 * region to "auto", which is right for R2 and wrong for AWS: S3 signs requests
 * per region, so every request would fail with a signature error that never
 * mentions the region.
 */
function assertRegionMatchesEndpoint(prefix: string, endpoint: string, region: string): void {
  let host: string;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    throw new Error(`${prefix}_ENDPOINT must be a full URL such as https://<account>.r2.cloudflarestorage.com.`);
  }
  if (!AWS_HOST.test(host) || region !== "auto") return;
  const derived = AWS_REGION_IN_HOST.exec(host)?.[1];
  throw new Error(
    `${prefix}_REGION is empty or "auto", but ${prefix}_ENDPOINT is an AWS endpoint (${host}). ` +
      `AWS rejects requests signed for the wrong region. Set ${prefix}_REGION to the bucket's region, e.g. ${prefix}_REGION=${derived ?? "eu-west-3"}.`,
  );
}

function numberFromEnv(name: string, expectation: string, isValid: (value: number) => boolean): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || !isValid(value)) throw new Error(`${name} must be ${expectation}, got "${raw}".`);
  return value;
}

function checksumModeFromEnv(name: string): "WHEN_REQUIRED" | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw !== "when_required") throw new Error(`${name} must be "when_required" or unset, got "${raw}".`);
  return "WHEN_REQUIRED";
}

export function loadConfig(): Config {
  // Buckets first: a missing required setting is the error a new operator should see first.
  const source = { ...bucketFromEnv("DATA_JOBS_S3", "auto"), checksumMode: checksumModeFromEnv("SOURCE_S3_CHECKSUM_MODE") };
  const archive = bucketFromEnv("ARCHIVE_S3", "auto");
  const maxMbps = numberFromEnv("AUDIO_ARCHIVE_MAX_MBPS", "a positive number of megabits per second (unset for no limit)", (n) => n > 0);
  return {
    source,
    archive,
    indexerUrl: process.env.INDEXER_URL?.trim() || DEFAULT_INDEXER_URL,
    pdsHosts: pdsHostsFromEnv(),
    lockPort:
      numberFromEnv("AUDIO_ARCHIVE_LOCK_PORT", "a port number between 1 and 65535", (n) => Number.isInteger(n) && n >= 1 && n <= 65535) ??
      DEFAULT_LOCK_PORT,
    minAgeMinutes:
      numberFromEnv("AUDIO_ARCHIVE_MIN_AGE_MINUTES", "a number of minutes, 0 or more", (n) => n >= 0) ?? DEFAULT_MIN_AGE_MINUTES,
    maxBytesPerSecond: maxMbps === undefined ? undefined : (maxMbps * 1_000_000) / 8,
  };
}

/** AUDIO_ARCHIVE_PDS_HOSTS: comma-separated hostnames, exact match. Unset means certified.one. */
function pdsHostsFromEnv(): readonly string[] {
  const raw = process.env.AUDIO_ARCHIVE_PDS_HOSTS?.trim();
  if (!raw) return DEFAULT_PDS_HOSTS;
  const hosts = raw.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  const invalid = hosts.filter((host) => !HOSTNAME.test(host));
  if (hosts.length === 0 || invalid.length > 0) {
    throw new Error(
      `AUDIO_ARCHIVE_PDS_HOSTS must be a comma-separated list of hostnames, e.g. "certified.one,pds.example.org"${invalid.length ? `. Not a hostname: ${invalid.join(", ")}` : ""}.`,
    );
  }
  return hosts;
}
