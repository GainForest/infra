import { describeError } from "./errors.ts";

export type LimitedFetchOptions = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** The response body is abandoned (and the request cancelled) beyond this many bytes. */
  maxBytes: number;
  /** Deadline for the whole exchange, body included. */
  timeoutMs: number;
  signal?: AbortSignal;
};

export type LimitedResponse = { status: number; body: string };

/**
 * `fetch` with the guard rails every outbound request here needs. Redirects are
 * errors, because a redirect could send the runner to an address that was never
 * vetted. The exchange has a deadline. The body is read with a byte cap and is
 * never buffered unbounded the way `response.json()` would.
 *
 * The status is returned rather than thrown on, so callers decide what a
 * non-2xx answer means (the indexer reports query errors in a 400 body).
 */
export async function fetchLimited(url: string | URL, options: LimitedFetchOptions): Promise<LimitedResponse> {
  if (!URL.canParse(url)) throw new Error(`"${String(url)}" is not a valid URL`);
  const host = new URL(url).host;
  const deadline = AbortSignal.timeout(options.timeoutMs);
  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
      redirect: "error",
      signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
    });
    return { status: response.status, body: await readCapped(response, options.maxBytes) };
  } catch (error) {
    throw new Error(`Request to ${host} failed: ${describeError(error)}`, { cause: error });
  }
}

/** The body went past the caller's byte cap. Not transient, so never worth retrying. */
export class ResponseTooLargeError extends Error {}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const tooLarge = () => new ResponseTooLargeError(`response is larger than the ${maxBytes} byte limit`);
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw tooLarge();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}
