import { createHash } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";

/** Passes bytes through unchanged while counting them and computing their SHA-256. */
export class HashingTransform extends Transform {
  bytes = 0;
  readonly #hash = createHash("sha256");

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.#hash.update(chunk);
    this.bytes += chunk.length;
    callback(null, chunk);
  }

  /** Only meaningful once the stream has finished. */
  digest(): Buffer {
    return this.#hash.digest();
  }
}

/**
 * Paces a stream to `bytesPerSecond` on average. A chunk is held back until the
 * chunks before it have had time to "transmit", so the burst is at most one
 * chunk and idle time earns no credit.
 */
export class Throttle extends Transform {
  readonly #msPerByte: number;
  #nextFreeAt = 0;
  #timer: NodeJS.Timeout | undefined;

  constructor(bytesPerSecond: number) {
    super();
    this.#msPerByte = 1000 / bytesPerSecond;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const now = performance.now();
    const releaseAt = Math.max(now, this.#nextFreeAt);
    this.#nextFreeAt = releaseAt + chunk.length * this.#msPerByte;
    if (releaseAt <= now) {
      callback(null, chunk);
      return;
    }
    this.#timer = setTimeout(callback, releaseAt - now, null, chunk);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    clearTimeout(this.#timer);
    callback(error);
  }
}
