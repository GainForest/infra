import { S3Client, paginateListObjectsV2 } from "@aws-sdk/client-s3";
import type { BucketConfig } from "./config.ts";

export type Bucket = { client: S3Client; name: string };

// Timeouts are per-connection and per-idle-period, not per request: a 2 GB
// copy legitimately takes a long time, and a source body that is paused
// because the upload is behind counts as idle. Five minutes with no bytes in
// either direction means the connection is dead.
const CONNECT_TIMEOUT_MS = 15_000;
const SOCKET_IDLE_TIMEOUT_MS = 300_000;

export function openBucket(config: BucketConfig): Bucket {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // Path-style matches how gainforest-app signs requests against both R2 and S3.
    forcePathStyle: true,
    requestHandler: { connectionTimeout: CONNECT_TIMEOUT_MS, socketTimeout: SOCKET_IDLE_TIMEOUT_MS },
    // Left unset unless asked for, so the SDK's own defaults and AWS_* env settings apply.
    ...(config.checksumMode === "WHEN_REQUIRED"
      ? { requestChecksumCalculation: "WHEN_REQUIRED" as const, responseChecksumValidation: "WHEN_REQUIRED" as const }
      : {}),
  });
  return { client, name: config.bucket };
}

export type ListedObject = { key: string; etag: string | undefined; size: number; lastModified: Date | undefined };

export async function* listObjects(bucket: Bucket, prefix: string, signal?: AbortSignal): AsyncGenerator<ListedObject> {
  const pages = paginateListObjectsV2({ client: bucket.client }, { Bucket: bucket.name, Prefix: prefix }, { abortSignal: signal });
  for await (const page of pages) {
    for (const item of page.Contents ?? []) {
      if (item.Key) yield { key: item.Key, etag: item.ETag, size: item.Size ?? 0, lastModified: item.LastModified };
    }
  }
}

/**
 * Whether exactly this key exists. Uses LIST, which the runner needs anyway:
 * HEAD on a missing key answers 403 instead of 404 unless the credentials may
 * list the bucket, and a 403 would be indistinguishable from a real denial.
 */
export async function objectExists(bucket: Bucket, key: string): Promise<boolean> {
  for await (const item of listObjects(bucket, key)) {
    if (item.key === key) return true;
  }
  return false;
}
