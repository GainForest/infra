import { setTimeout as delay } from "node:timers/promises";
import { fetchLimited, ResponseTooLargeError, type LimitedResponse } from "./http.ts";

/**
 * Reads a record from its owner's PDS. The owner DID and everything in its DID
 * document come from records anyone can publish, so each step is checked before
 * the runner connects anywhere: otherwise a crafted DID could point this
 * long-running job (it runs on a production host) at an internal address.
 *
 * The runner only ever contacts plc.directory and hosts on an allowlist
 * (AUDIO_ARCHIVE_PDS_HOSTS, default certified.one, matching the BioBlitz
 * archive's BIOBLITZ_ARCHIVE_PDS_HOSTS): a did:web host must be on it before
 * its DID document is fetched, and so must the PDS the document names. Name
 * checks alone can't stop a public hostname that resolves to a private address.
 * Verifying a record against the uploader's DID does not need any of this;
 * only record.value does.
 */

const PLC_DIRECTORY = "https://plc.directory";
const DID_DOC_MAX_BYTES = 64 * 1024;
const DID_DOC_TIMEOUT_MS = 10_000;
const RECORD_MAX_BYTES = 256 * 1024;
const RECORD_TIMEOUT_MS = 15_000;

const DID_PLC = /^did:plc:[a-z2-7]{24}$/;
// did:web with a bare hostname only. `%` and `:` are excluded so an escaped
// port or a path (did:web:host%3A8080, did:web:host:path) is rejected.
const DID_WEB = /^did:web:([A-Za-z0-9.-]+)$/;
// One retry for answers that are usually transient, so a single blip doesn't
// leave a record without its value in a manifest that is never rewritten.
const RETRY_DELAY_MS = 1_500;

const AT_URI = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/;
const NSID = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+){2,}$/i;
const RECORD_KEY = /^[A-Za-z0-9._:~-]{1,512}$/;

export type PdsRecord = { value: unknown; cid: string | null };

export type PdsClient = {
  /**
   * The record at `uri`, exactly as the owner's PDS serves it. `ownerDid` is the
   * account the indexer says owns the record; the URI must be in that repo.
   * Throws an Error whose message says why the record cannot be trusted or read.
   */
  getRecord(uri: string, ownerDid: string): Promise<PdsRecord>;
};

/** One client per run: it remembers each DID's PDS. Failures are not remembered, so the next file retries. */
export function createPdsClient(allowedHosts: readonly string[], signal?: AbortSignal): PdsClient {
  const origins = new Map<string, Promise<string>>();
  const originFor = (did: string): Promise<string> => {
    let origin = origins.get(did);
    if (!origin) {
      origin = resolvePdsOrigin(did, allowedHosts, signal);
      origins.set(did, origin);
      origin.catch(() => origins.delete(did));
    }
    return origin;
  };

  return {
    async getRecord(uri, ownerDid) {
      const { repo, collection, rkey } = parseRecordUri(uri);
      if (repo !== ownerDid) throw new Error(`Record ${shorten(uri)} is in repo ${shorten(repo)}, not in the indexed owner ${shorten(ownerDid)}`);
      const url = new URL("/xrpc/com.atproto.repo.getRecord", await originFor(repo));
      url.search = new URLSearchParams({ repo, collection, rkey }).toString();
      const { status, body } = await fetchRetrying(url, { maxBytes: RECORD_MAX_BYTES, timeoutMs: RECORD_TIMEOUT_MS, signal });
      const json = parseJsonObject(body);
      if (status !== 200) {
        const reason = typeof json?.error === "string" ? ` (${shorten(json.error, 80)})` : "";
        throw new Error(`getRecord answered HTTP ${status}${reason}`);
      }
      if (!json || asObject(json.value) === null) throw new Error("getRecord response has no record value");
      return { value: json.value, cid: typeof json.cid === "string" ? json.cid : null };
    },
  };
}

function parseRecordUri(uri: string): { repo: string; collection: string; rkey: string } {
  const match = AT_URI.exec(uri);
  if (!match) throw new Error(`"${shorten(uri)}" is not an at://<did>/<collection>/<rkey> record URI`);
  const [, repo, collection, rkey] = match;
  if (!NSID.test(collection)) throw new Error(`"${shorten(collection)}" is not a collection name`);
  if (!RECORD_KEY.test(rkey) || rkey === "." || rkey === "..") throw new Error(`"${shorten(rkey)}" is not a record key`);
  return { repo, collection, rkey };
}

function didDocumentUrl(did: string, allowedHosts: readonly string[]): string {
  if (DID_PLC.test(did)) return `${PLC_DIRECTORY}/${did}`;
  const web = DID_WEB.exec(did);
  if (!web) throw new Error(`"${shorten(did)}" is not a did:plc or a did:web with a plain hostname`);
  const host = web[1]!.toLowerCase();
  if (!allowedHosts.includes(host)) throw new Error(`did:web host ${shorten(host)} is not in AUDIO_ARCHIVE_PDS_HOSTS`);
  return `https://${host}/.well-known/did.json`;
}

async function resolvePdsOrigin(did: string, allowedHosts: readonly string[], signal?: AbortSignal): Promise<string> {
  const url = didDocumentUrl(did, allowedHosts);
  const { status, body } = await fetchRetrying(url, { maxBytes: DID_DOC_MAX_BYTES, timeoutMs: DID_DOC_TIMEOUT_MS, signal });
  if (status !== 200) throw new Error(`DID document for ${did} answered HTTP ${status}`);
  const doc = parseJsonObject(body);
  if (!doc) throw new Error(`DID document for ${did} is not a JSON object`);
  if (typeof doc.id !== "string" || doc.id.toLowerCase() !== did.toLowerCase()) {
    throw new Error(`DID document for ${did} describes a different DID`);
  }
  return pdsOriginFrom(findPdsEndpoint(doc, did), allowedHosts);
}

function findPdsEndpoint(doc: Record<string, unknown>, did: string): unknown {
  const services = Array.isArray(doc.service) ? doc.service : [];
  for (const service of services) {
    const entry = asObject(service);
    if (entry && (entry.id === "#atproto_pds" || entry.id === `${did}#atproto_pds` || entry.type === "AtprotoPersonalDataServer")) {
      return entry.serviceEndpoint;
    }
  }
  return undefined;
}

/** The origin of a PDS service endpoint, or an Error saying which rule it broke. */
function pdsOriginFrom(endpoint: unknown, allowedHosts: readonly string[]): string {
  if (typeof endpoint !== "string") throw new Error("DID document has no PDS service endpoint");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("PDS service endpoint is not a URL");
  }
  // The endpoint itself is never echoed: it may carry credentials.
  if (url.protocol !== "https:") throw new Error(`PDS endpoint for ${url.hostname} must use https`);
  if (url.username || url.password) throw new Error(`PDS endpoint for ${url.hostname} must not contain credentials`);
  if (url.port) throw new Error(`PDS endpoint for ${url.hostname} must not name a port`);
  if (url.pathname !== "/" || url.search || url.hash) throw new Error(`PDS endpoint for ${url.hostname} must be a bare origin`);
  if (!allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new Error(`PDS host ${url.hostname} is not in AUDIO_ARCHIVE_PDS_HOSTS`);
  }
  return url.origin;
}

/** A GET that is tried once more after a network error, a 5xx or a 429. */
async function fetchRetrying(
  url: string | URL,
  options: { maxBytes: number; timeoutMs: number; signal?: AbortSignal },
): Promise<LimitedResponse> {
  const attempt = () => fetchLimited(url, { headers: { accept: "application/json" }, ...options });
  try {
    const response = await attempt();
    if (response.status < 500 && response.status !== 429) return response;
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.cause instanceof ResponseTooLargeError)) throw error;
  }
  await delay(RETRY_DELAY_MS, undefined, { signal: options.signal });
  return attempt();
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    return asObject(JSON.parse(text));
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Keeps attacker-controlled text from bloating a log line. */
function shorten(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
