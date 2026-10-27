import { fetchLimited } from "./http.ts";
import { sourceKeyFromAccessUri } from "./keys.ts";
import { log } from "./log.ts";
import { createPdsClient, type PdsClient } from "./pds.ts";

/**
 * An ac.audio record that claims a source file through its accessUri. Anyone
 * can publish a record that points at anyone else's file, so a candidate is
 * only a hint until chooseRecord() checks it against the archived bytes or the
 * account that uploaded the file. A missing record never blocks a copy: the WAV
 * is what matters.
 */
export type RecordCandidate = {
  uri: string;
  /** The repo (DID) the indexer says holds the record. */
  ownerDid: string;
  /** The indexer's CID for the record. */
  cid: string | null;
  /** The indexer's copy of the record's originalCid; null on schemas that lack it. */
  originalCid: string | null;
};

export type FetchedRecord = RecordCandidate & {
  /** The CID the owner's PDS reported for `value`. */
  pdsCid: string | null;
  /** The record as the owner's PDS serves it; null when it could not be fetched. */
  value: unknown | null;
};

/** Every candidate per source key, earliest-indexed first. */
export type RecordLinks = Map<string, RecordCandidate[]>;

const PAGE_SIZE = 1000;
const MAX_PAGES = 200;
const LOAD_DEADLINE_MS = 5 * 60_000;
const INDEXER_TIMEOUT_MS = 60_000;
const INDEXER_MAX_BYTES = 8 * 1024 * 1024;
// Bounds the work (and the manifest size) one key can cost when many records claim it.
const MAX_FETCHED_CANDIDATES = 10;
const MAX_LISTED_CANDIDATES = 20;

/**
 * The hosted indexer's ac.audio schema may predate `originalCid` (see
 * gainforest-app ac-audio-indexed.ts) and may not offer `indexed_at` as a sort
 * field. Most useful query first; a query the schema rejects falls through.
 * `indexed_at` order puts the record the indexer saw first at the front (an
 * edit moves a record later), and unlike createdAt the record's author cannot
 * choose it.
 */
const QUERY_VARIANTS = [
  { sortBy: "indexed_at", fields: "uri did cid accessUri originalCid" },
  { sortBy: "indexed_at", fields: "uri did cid accessUri" },
  { sortBy: "createdAt", fields: "uri did cid accessUri originalCid" },
  { sortBy: "createdAt", fields: "uri did cid accessUri" },
] as const;

type QueryVariant = (typeof QUERY_VARIANTS)[number];
type Node = { uri?: string | null; did?: string | null; cid?: string | null; accessUri?: string | null; originalCid?: string | null };
type Connection = { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; edges?: Array<{ node?: Node | null } | null> };
type GraphQlPage = { data?: { appGainforestAcAudio?: Connection | null } | null; errors?: Array<{ message?: string }> };
type PagedLinks = { links: RecordLinks } | { rejection: string };

async function fetchPage(
  indexerUrl: string,
  variant: QueryVariant,
  after: string | null,
  signal: AbortSignal,
): Promise<{ status: number; page: GraphQlPage }> {
  const query = `query($first: Int!, $after: String) {
    appGainforestAcAudio(first: $first, after: $after, sortBy: ${variant.sortBy}, sortDirection: DESC) {
      pageInfo { hasNextPage endCursor }
      edges { node { ${variant.fields} } }
    }
  }`;
  const { status, body } = await fetchLimited(indexerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { first: PAGE_SIZE, after } }),
    maxBytes: INDEXER_MAX_BYTES,
    timeoutMs: INDEXER_TIMEOUT_MS,
    signal,
  });
  // Hyperindex answers some GraphQL errors with HTTP 400 and a JSON body
  // (see gainforest-app app/_lib/indexer.ts), so the body decides, not the status.
  let page: unknown;
  try {
    page = JSON.parse(body);
  } catch {
    throw new Error(`Indexer answered HTTP ${status} with a body that is not JSON`);
  }
  if (typeof page !== "object" || page === null) throw new Error(`Indexer answered HTTP ${status} with an unexpected body`);
  return { status, page: page as GraphQlPage };
}

function addCandidate(links: RecordLinks, key: string, candidate: RecordCandidate): void {
  const candidates = links.get(key);
  if (!candidates) links.set(key, [candidate]);
  else if (!candidates.some((existing) => existing.uri === candidate.uri)) candidates.push(candidate);
}

/**
 * Pages run newest-first so a truncated load (deadline or MAX_PAGES) drops the
 * oldest records, not the recent ones that pending files need. Each key's
 * candidates are then put back in earliest-indexed-first order.
 */
async function readAllPages(
  indexerUrl: string,
  variant: QueryVariant,
  signal: AbortSignal,
  deadline: AbortSignal,
): Promise<PagedLinks> {
  const links: RecordLinks = new Map();
  let after: string | null = null;
  for (let pages = 0; pages < MAX_PAGES; pages += 1) {
    let result: { status: number; page: GraphQlPage };
    try {
      result = await fetchPage(indexerUrl, variant, after, signal);
    } catch (error) {
      if (!deadline.aborted) throw error;
      log("warn", "record_links_truncated", { reason: "deadline", pages, keys: links.size });
      return { links: oldestFirst(links) };
    }
    const connection = result.page.data?.appGainforestAcAudio;
    if (!connection) {
      if (result.page.errors?.length) return { rejection: result.page.errors[0]?.message ?? "unknown GraphQL error" };
      throw new Error(`Indexer returned no ac.audio data (HTTP ${result.status})`);
    }
    for (const edge of connection.edges ?? []) {
      const node = edge?.node;
      const key = sourceKeyFromAccessUri(node?.accessUri);
      if (!node?.uri || !node.did || !key) continue;
      addCandidate(links, key, { uri: node.uri, ownerDid: node.did, cid: node.cid ?? null, originalCid: node.originalCid ?? null });
    }
    if (!connection.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) return { links: oldestFirst(links) };
    after = connection.pageInfo.endCursor;
  }
  log("warn", "record_links_truncated", { reason: "max_pages", pages: MAX_PAGES, keys: links.size });
  return { links: oldestFirst(links) };
}

function oldestFirst(links: RecordLinks): RecordLinks {
  for (const candidates of links.values()) candidates.reverse();
  return links;
}

/**
 * Every ac.audio record that points at a source file, grouped by source key.
 * Paging stops at an overall deadline or MAX_PAGES; either way it logs a
 * warning and returns what it has, because unlinked files still get copied.
 */
export async function loadRecordLinks(
  indexerUrl: string,
  options: { deadlineMs?: number; signal?: AbortSignal } = {},
): Promise<RecordLinks> {
  const deadline = AbortSignal.timeout(options.deadlineMs ?? LOAD_DEADLINE_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let rejection = "";
  for (const variant of QUERY_VARIANTS) {
    const paged = await readAllPages(indexerUrl, variant, signal, deadline);
    if ("links" in paged) {
      // Which query the schema accepted tells an operator whether indexed_at order and originalCid are available.
      log("info", "record_links_query", { sortBy: variant.sortBy, originalCid: variant.fields.includes("originalCid") });
      return paged.links;
    }
    rejection = paged.rejection;
  }
  throw new Error(`The indexer rejected every ac.audio query, so records cannot be linked. Last error: ${rejection}`);
}

export type RecordFetcher = (candidates: RecordCandidate[], uploaderDid: string) => Promise<FetchedRecord[]>;

/**
 * Fetches each candidate's value from its owner's PDS. Make one per run: it
 * remembers each DID's PDS. It never throws; a record that cannot be read gets
 * `value: null` and a warning that says why.
 */
export function createRecordFetcher(pdsHosts: readonly string[], signal?: AbortSignal): RecordFetcher {
  const pds = createPdsClient(pdsHosts, signal);
  return async (all, uploaderDid) => {
    // The uploader's own records go first, so spam claiming the same key can't
    // push the record most likely to verify past the fetch cap.
    const candidates = [...all.filter((c) => c.ownerDid === uploaderDid), ...all.filter((c) => c.ownerDid !== uploaderDid)];
    const fetched: FetchedRecord[] = [];
    for (const [index, candidate] of candidates.entries()) {
      fetched.push(index < MAX_FETCHED_CANDIDATES ? await fetchValue(pds, candidate) : { ...candidate, pdsCid: null, value: null });
    }
    if (candidates.length > MAX_FETCHED_CANDIDATES) {
      log("warn", "record_candidates_not_fetched", {
        uri: candidates[0]?.uri,
        candidates: candidates.length,
        fetched: MAX_FETCHED_CANDIDATES,
      });
    }
    return fetched;
  };
}

async function fetchValue(pds: PdsClient, candidate: RecordCandidate): Promise<FetchedRecord> {
  try {
    const { value, cid } = await pds.getRecord(candidate.uri, candidate.ownerDid);
    return { ...candidate, pdsCid: cid, value };
  } catch (error) {
    log("warn", "record_value_unavailable", {
      uri: candidate.uri,
      ownerDid: candidate.ownerDid,
      reason: error instanceof Error ? error.message : String(error),
    });
    return { ...candidate, pdsCid: null, value: null };
  }
}

export type ChosenRecord = {
  record: FetchedRecord;
  verified: boolean;
  verifiedBy?: "originalCid" | "uploaderDid";
  /** The record's originalCid: the PDS value's when fetched, else the indexer's. */
  originalCid: string | null;
  /** URIs of the other candidates, at most MAX_LISTED_CANDIDATES. */
  otherCandidates: string[];
};

const OWNED_BY_UPLOADER = 2;
const NAMES_ARCHIVED_BYTES = 1;

function originalCidOf(record: FetchedRecord): string | null {
  const { value } = record;
  if (value && typeof value === "object" && "originalCid" in value && typeof value.originalCid === "string") return value.originalCid;
  return record.originalCid;
}

function trustScore(record: FetchedRecord, archived: { cid: string; uploaderDid: string }): number {
  let score = 0;
  if (record.ownerDid === archived.uploaderDid) score += OWNED_BY_UPLOADER;
  if (originalCidOf(record) === archived.cid) score += NAMES_ARCHIVED_BYTES;
  return score;
}

/**
 * Pick the record to describe an archived file, after its bytes are known.
 *
 * A record is verified when it lives in the repo of the account that uploaded
 * the file (the strongest link: only that account could write the object), or
 * when its originalCid is the CID of the archived bytes (an organization's
 * record for a member's upload). Among verified records, one that meets both
 * tests wins, then the uploader's own. The CID test alone shows the record's
 * author held the bytes; recordings are downloadable, so it is weaker.
 *
 * Nothing verified: the earliest-indexed candidate is returned unverified, so
 * the manifest still shows who claims the file.
 */
export function chooseRecord(records: FetchedRecord[], archived: { cid: string; uploaderDid: string }): ChosenRecord | null {
  let best: { record: FetchedRecord; score: number } | null = null;
  for (const record of records) {
    const score = trustScore(record, archived);
    if (!best || score > best.score) best = { record, score };
  }
  if (!best) return null;
  const { record, score } = best;
  const chosen: ChosenRecord = {
    record,
    verified: score > 0,
    originalCid: originalCidOf(record),
    otherCandidates: records
      .filter((other) => other !== record)
      .map((other) => other.uri)
      .slice(0, MAX_LISTED_CANDIDATES),
  };
  if (score > 0) chosen.verifiedBy = score >= OWNED_BY_UPLOADER ? "uploaderDid" : "originalCid";
  return chosen;
}
