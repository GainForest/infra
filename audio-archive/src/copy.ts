import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, type GetObjectCommandOutput } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { cidFromSha256 } from "./cid.ts";
import { describeError, httpStatusOf } from "./errors.ts";
import { archivePaths, normaliseEtag, type SourceKey } from "./keys.ts";
import { chooseRecord, type ChosenRecord, type FetchedRecord } from "./records.ts";
import type { Bucket } from "./storage.ts";
import { HashingTransform, Throttle } from "./streams.ts";

// Same class as the BioBlitz archive.
const STORAGE_CLASS = "GLACIER_IR";
// 16 MB parts x 4 in flight: the part buffers hold about 65 MB regardless of file size.
const PART_SIZE = 16 * 1024 * 1024;
const QUEUE_SIZE = 4;

export type Manifest = {
  formatVersion: 1;
  source: { bucket: string; key: string; etag: string; bytes: number; lastModified: string | null };
  archive: { bucket: string; key: string; storageClass: string };
  sha256: string;
  /** CID of the archived bytes, same format as ac.audio originalCid. */
  cid: string;
  /** Present only when a verified record carried originalCid. */
  originalCid?: string;
  /** True when the archived bytes differ from what the app hashed at upload. Only set alongside originalCid. */
  cidMismatch?: boolean;
  /** A hint about what the file is, unless `verified` is true. */
  record?: {
    uri: string;
    ownerDid: string;
    /** The indexer's CID for the record. */
    cid: string | null;
    /** The CID the owner's PDS returned with `value`. */
    pdsCid: string | null;
    value: unknown | null;
    verified: boolean;
    verifiedBy?: "originalCid" | "uploaderDid";
    otherCandidates?: string[];
  };
  capturedAt: string;
};

export type CopyTarget = { source: SourceKey; etag: string };

export type CopyOptions = {
  /** Candidate ac.audio records with their values already fetched; one is chosen after hashing. */
  records?: FetchedRecord[];
  /** Pace the transfer to this many bytes per second. */
  maxBytesPerSecond?: number;
  /** Aborts the transfer; the in-flight multipart upload is aborted before copyOriginal rejects. */
  signal?: AbortSignal;
};

/** The source object was deleted or replaced between listing it and copying it. Not a failure. */
export class SourceChangedError extends Error {
  override name = "SourceChangedError";
}

/**
 * Copy one original from R2 to the archive. The manifest is written last, so
 * its presence is what marks a copy as complete; an interrupted copy is
 * simply redone on the next run.
 */
export async function copyOriginal(from: Bucket, to: Bucket, target: CopyTarget, options: CopyOptions = {}): Promise<Manifest> {
  const { source, etag } = target;
  const paths = archivePaths(source, etag);

  const object = await getSource(from, source.key, etag, options.signal);
  const { bytes, sha256 } = await transfer(object.Body as Readable, to, paths.objectKey, options);
  if (object.ContentLength !== undefined && bytes !== object.ContentLength) {
    throw new Error(`Read ${bytes} bytes from ${source.key}, expected ${object.ContentLength}`);
  }
  await verifyArchivedSize(to, paths.objectKey, bytes);

  const manifest: Manifest = {
    formatVersion: 1,
    source: { bucket: from.name, key: source.key, etag, bytes, lastModified: object.LastModified?.toISOString() ?? null },
    archive: { bucket: to.name, key: paths.objectKey, storageClass: STORAGE_CLASS },
    sha256: sha256.toString("hex"),
    cid: cidFromSha256(sha256),
    capturedAt: new Date().toISOString(),
  };
  const chosen = chooseRecord(options.records ?? [], { cid: manifest.cid, uploaderDid: source.did });
  if (chosen) describeRecord(manifest, chosen);

  await to.client.send(
    new PutObjectCommand({
      Bucket: to.name,
      Key: paths.manifestKey,
      Body: JSON.stringify(manifest, null, 2),
      ContentType: "application/json",
      StorageClass: STORAGE_CLASS,
    }),
  );
  return manifest;
}

/** Start reading the source. If-Match: fail rather than archive a different version under this ETag. */
async function getSource(from: Bucket, key: string, etag: string, signal?: AbortSignal): Promise<GetObjectCommandOutput> {
  let object: GetObjectCommandOutput;
  try {
    object = await from.client.send(new GetObjectCommand({ Bucket: from.name, Key: key, IfMatch: `"${etag}"` }), { abortSignal: signal });
  } catch (error) {
    if (isSourceGone(error)) {
      throw new SourceChangedError(`Source object ${key} was deleted or replaced before it could be copied`, { cause: error });
    }
    throw error;
  }
  if (!object.Body) throw new Error(`Source returned no body for ${key}`);
  return object;
}

/** Deleted (404) or no longer the listed version (412). A missing bucket is a misconfiguration, not a change. */
function isSourceGone(error: unknown): boolean {
  const status = httpStatusOf(error);
  const name = error instanceof Error ? error.name : "";
  return name === "NoSuchKey" || name === "PreconditionFailed" || status === 412 || (status === 404 && name !== "NoSuchBucket");
}

/**
 * Stream `body` into a multipart upload, hashing as it goes. Waits for both
 * sides to settle before returning or throwing, so that when this rejects the
 * upload has already been aborted (nothing is left behind to bill) and both
 * streams are closed.
 */
async function transfer(body: Readable, to: Bucket, key: string, options: CopyOptions): Promise<{ bytes: number; sha256: Buffer }> {
  const hasher = new HashingTransform();
  const upload = new Upload({
    client: to.client,
    params: { Bucket: to.name, Key: key, Body: hasher, ContentType: "audio/wav", StorageClass: STORAGE_CLASS },
    partSize: PART_SIZE,
    queueSize: QUEUE_SIZE,
    leavePartsOnError: false,
  });
  // lib-storage closes the stream itself when a part fails. Closing it here too
  // keeps the pipeline from waiting forever on a reader that is gone if that changes.
  const uploading = upload.done().catch((error: unknown) => {
    hasher.destroy();
    throw error;
  });
  const pace = options.maxBytesPerSecond ? [new Throttle(options.maxBytesPerSecond)] : [];
  const stages: [Readable, ...Throttle[], HashingTransform] = [body, ...pace, hasher];
  const [piped, uploaded] = await Promise.allSettled([pipeline(stages, { signal: options.signal }), uploading]);

  // The upload's error is the root cause: a failed part makes lib-storage close
  // the stream, which fails the pipeline with a bare AbortError. It also only
  // rejects after sending AbortMultipartUpload, so it is the one to wait for.
  // When the source fails, lib-storage rejects with that same error object
  // (after aborting), so an identical reason means the download is to blame.
  const sourceFailed = piped.status === "rejected" && (uploaded.status === "fulfilled" || uploaded.reason === piped.reason);
  if (sourceFailed && !options.signal?.aborted) {
    // Name the side that failed: a reset R2 download otherwise logs as a bare "aborted".
    throw new Error(`Reading the source failed mid-transfer: ${describeError(piped.reason)}`, { cause: piped.reason });
  }
  if (uploaded.status === "rejected") throw uploaded.reason;
  if (piped.status === "rejected") throw piped.reason;
  return { bytes: hasher.bytes, sha256: hasher.digest() };
}

async function verifyArchivedSize(to: Bucket, key: string, bytes: number): Promise<void> {
  const head = await to.client.send(new HeadObjectCommand({ Bucket: to.name, Key: key }));
  if (head.ContentLength !== bytes) {
    throw new Error(`Archived ${key} is ${head.ContentLength} bytes, expected ${bytes}`);
  }
}

/**
 * Describe the chosen record in the manifest. originalCid and cidMismatch come
 * only from a verified record, so a stranger's record cannot raise an
 * integrity alarm about someone else's file.
 */
function describeRecord(manifest: Manifest, chosen: ChosenRecord): void {
  const { record } = chosen;
  manifest.record = {
    uri: record.uri,
    ownerDid: record.ownerDid,
    cid: record.cid,
    pdsCid: record.pdsCid,
    value: record.value,
    verified: chosen.verified,
  };
  if (chosen.verifiedBy) manifest.record.verifiedBy = chosen.verifiedBy;
  if (chosen.otherCandidates.length > 0) manifest.record.otherCandidates = chosen.otherCandidates;
  if (chosen.verified && chosen.originalCid) {
    manifest.originalCid = chosen.originalCid;
    manifest.cidMismatch = chosen.originalCid !== manifest.cid;
  }
}

/** Look up a single source object's ETag, for copy-one. */
export async function headSource(from: Bucket, key: string): Promise<string> {
  let etag: string | null;
  try {
    etag = normaliseEtag((await from.client.send(new HeadObjectCommand({ Bucket: from.name, Key: key }))).ETag);
  } catch (error) {
    if (httpStatusOf(error) === 404 || (error instanceof Error && error.name === "NotFound")) {
      throw new Error(`Source object ${key} not found in ${from.name}`, { cause: error });
    }
    throw error;
  }
  if (!etag) throw new Error(`Source object ${key} has no usable ETag`);
  return etag;
}
