import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import type { Bucket } from "../storage.ts";

export type StoredObject = { body: Buffer; etag: string; lastModified: Date };

/** An error shaped like the SDK's service errors: a name plus `$metadata.httpStatusCode`. */
export function s3Error(name: string, httpStatusCode: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });
}

const LIST_PAGE_SIZE = 2;
// Not a power of two, so chunk edges never line up with part edges.
const BODY_CHUNK_BYTES = 65_011;
// Long enough that code which does not wait for an abort to finish is caught.
const ABORT_LATENCY_MS = 25;

/**
 * A GetObject body that never ends, so a test can be sure the source is still
 * streaming when it fails the upload or aborts the copy. Pass it as `{ Body }`.
 */
export function endlessBody(): Readable {
  return new Readable({
    read() {
      this.push(Buffer.alloc(64 * 1024));
    },
  });
}

const md5 = (body: Buffer) => createHash("md5").update(body).digest("hex");

function* chunked(body: Buffer): Generator<Buffer> {
  for (let offset = 0; offset < body.length; offset += BODY_CHUNK_BYTES) yield body.subarray(offset, offset + BODY_CHUNK_BYTES);
}

/**
 * An in-memory bucket that answers the S3 commands the runner sends, behind a
 * real S3Client whose `send` is replaced. No sockets are opened.
 */
export class FakeS3 {
  readonly objects = new Map<string, StoredObject>();
  /** One entry per command received, in order, e.g. "PutObject audio/v1/…". */
  readonly calls: string[] = [];
  /** Upload ids whose AbortMultipartUpload has been fully answered. */
  readonly abortedUploads: string[] = [];
  readonly bucket: Bucket;
  /** Runs before the built-in answer: throw to fail the command, return a value to replace its output. */
  intercept: (command: unknown) => unknown = () => undefined;
  readonly #uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  #uploadCount = 0;

  constructor(name: string) {
    const client = new S3Client({
      region: "us-east-1",
      endpoint: "http://127.0.0.1:1",
      forcePathStyle: true,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    Object.assign(client, { send: (command: unknown) => this.#handle(command) });
    this.bucket = { client, name };
  }

  /** Store an object and return its ETag (unquoted). */
  put(key: string, body: Buffer | string, lastModified = new Date("2026-01-01T00:00:00Z")): string {
    const stored = Buffer.from(body);
    const etag = md5(stored);
    this.objects.set(key, { body: stored, etag, lastModified });
    return etag;
  }

  /** Keys currently stored, optionally limited to those containing `part`. */
  keys(part = ""): string[] {
    return [...this.objects.keys()].filter((key) => key.includes(part)).sort();
  }

  async #handle(command: unknown): Promise<unknown> {
    this.calls.push(this.#describe(command));
    const replaced = await this.intercept(command);
    if (replaced !== undefined) return replaced;

    if (command instanceof ListObjectsV2Command) {
      const keys = this.keys().filter((key) => key.startsWith(command.input.Prefix ?? ""));
      const offset = Number(command.input.ContinuationToken ?? 0);
      const page = keys.slice(offset, offset + LIST_PAGE_SIZE);
      return {
        Contents: page.map((key) => {
          const object = this.objects.get(key)!;
          return { Key: key, ETag: `"${object.etag}"`, Size: object.body.length, LastModified: object.lastModified };
        }),
        IsTruncated: offset + LIST_PAGE_SIZE < keys.length,
        NextContinuationToken: offset + LIST_PAGE_SIZE < keys.length ? String(offset + LIST_PAGE_SIZE) : undefined,
      };
    }
    if (command instanceof GetObjectCommand) {
      const object = this.objects.get(command.input.Key!);
      if (!object) throw s3Error("NoSuchKey", 404);
      if (command.input.IfMatch && command.input.IfMatch.replaceAll('"', "") !== object.etag) throw s3Error("PreconditionFailed", 412);
      return {
        Body: Readable.from(chunked(object.body)),
        ContentLength: object.body.length,
        ETag: `"${object.etag}"`,
        LastModified: object.lastModified,
      };
    }
    if (command instanceof HeadObjectCommand) {
      const object = this.objects.get(command.input.Key!);
      if (!object) throw s3Error("NotFound", 404);
      return { ContentLength: object.body.length, ETag: `"${object.etag}"`, LastModified: object.lastModified };
    }
    if (command instanceof PutObjectCommand) {
      const etag = this.put(command.input.Key!, Buffer.from(command.input.Body as Uint8Array | string));
      return { ETag: `"${etag}"` };
    }
    if (command instanceof CreateMultipartUploadCommand) {
      const uploadId = `upload-${(this.#uploadCount += 1)}`;
      this.#uploads.set(uploadId, { key: command.input.Key!, parts: new Map() });
      return { UploadId: uploadId };
    }
    if (command instanceof UploadPartCommand) {
      this.#uploads.get(command.input.UploadId!)!.parts.set(command.input.PartNumber!, Buffer.from(command.input.Body as Uint8Array));
      return { ETag: `"part-${command.input.PartNumber}"` };
    }
    if (command instanceof CompleteMultipartUploadCommand) {
      const upload = this.#uploads.get(command.input.UploadId!)!;
      const numbers = command.input.MultipartUpload!.Parts!.map((part) => part.PartNumber!).sort((a, b) => a - b);
      const etag = this.put(upload.key, Buffer.concat(numbers.map((number) => upload.parts.get(number)!)));
      this.#uploads.delete(command.input.UploadId!);
      return { ETag: `"${etag}-${numbers.length}"` };
    }
    if (command instanceof AbortMultipartUploadCommand) {
      await new Promise((resolve) => setTimeout(resolve, ABORT_LATENCY_MS));
      this.#uploads.delete(command.input.UploadId!);
      this.abortedUploads.push(command.input.UploadId!);
      return {};
    }
    throw new Error(`FakeS3 does not implement ${(command as object).constructor.name}`);
  }

  #describe(command: unknown): string {
    const name = (command as object).constructor.name.replace(/Command$/, "");
    const input = (command as { input: { Key?: string; Prefix?: string; PartNumber?: number } }).input;
    const detail = input.PartNumber ? `#${input.PartNumber}` : (input.Key ?? input.Prefix ?? "");
    return `${name} ${detail}`.trim();
  }
}
