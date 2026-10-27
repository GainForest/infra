import { copyOriginal, SourceChangedError, type CopyTarget } from "./copy.ts";
import { errorFields } from "./errors.ts";
import { ARCHIVE_PREFIX, SOURCE_PREFIX, archivePaths, normaliseEtag, parseSourceKey } from "./keys.ts";
import { log } from "./log.ts";
import { createRecordFetcher, loadRecordLinks, type RecordLinks } from "./records.ts";
import { listObjects, type Bucket } from "./storage.ts";

export type RunSummary = {
  /** Source objects with no manifest yet, old enough to copy. */
  pending: number;
  copied: number;
  failed: number;
  /** Deleted or replaced after they were listed; picked up (or gone) next run. */
  sourceChanged: number;
  /** Younger than the settle window; left for a later run. */
  tooRecent: number;
  /** Keys under audiomoth/ that do not look like uploads from the app. */
  skippedKeys: number;
  /** Copies whose bytes differ from the CID the uploader's own record carries. */
  cidMismatches: number;
  /** Pending files left for a later run because of --limit. */
  deferredByLimit: number;
};

export type CopyRunOptions = {
  indexerUrl: string;
  /** PDS hosts the runner may read records from. */
  pdsHosts: readonly string[];
  maxBytesPerSecond?: number;
  signal?: AbortSignal;
};

export type RunOptions = CopyRunOptions & {
  dryRun: boolean;
  /** Copy at most this many pending files (a test slice); the rest wait for a later run. */
  limit?: number;
  /** Leave source objects younger than this alone. */
  minAgeMs: number;
};

type TooRecent = { key: string; etag: string; lastModified: Date };

async function listCompletedManifests(archive: Bucket, signal?: AbortSignal): Promise<Set<string>> {
  const done = new Set<string>();
  for await (const item of listObjects(archive, ARCHIVE_PREFIX, signal)) {
    if (item.key.endsWith(".manifest.json")) done.add(item.key);
  }
  return done;
}

/** Source objects with no manifest in the archive yet, split by whether they have settled. */
async function findPending(
  source: Bucket,
  done: Set<string>,
  minAgeMs: number,
  signal?: AbortSignal,
): Promise<{ pending: CopyTarget[]; tooRecent: TooRecent[]; skippedKeys: number }> {
  const pending: CopyTarget[] = [];
  const tooRecent: TooRecent[] = [];
  let skippedKeys = 0;
  const settledBefore = Date.now() - minAgeMs;
  for await (const item of listObjects(source, SOURCE_PREFIX, signal)) {
    const parsed = parseSourceKey(item.key);
    const etag = normaliseEtag(item.etag);
    if (!parsed || !etag) {
      skippedKeys += 1;
      log("warn", "unrecognised_source_key", { key: item.key, etag: item.etag ?? null });
      continue;
    }
    if (done.has(archivePaths(parsed, etag).manifestKey)) continue;
    // A recording is uploaded first and its ac.audio record written afterwards.
    // Copying too soon would archive it before the record exists to link.
    if (item.lastModified && item.lastModified.getTime() > settledBefore) {
      tooRecent.push({ key: item.key, etag, lastModified: item.lastModified });
      continue;
    }
    pending.push({ source: parsed, etag });
  }
  return { pending, tooRecent, skippedKeys };
}

async function loadLinksBestEffort(indexerUrl: string, signal?: AbortSignal): Promise<RecordLinks> {
  try {
    const links = await loadRecordLinks(indexerUrl, { signal });
    log("info", "record_links_loaded", { keys: links.size });
    return links;
  } catch (error) {
    if (signal?.aborted) throw error;
    log("warn", "record_links_unavailable", errorFields(error));
    return new Map();
  }
}

/**
 * Copy `targets` one at a time. Record values are fetched before each transfer,
 * so a slow or broken PDS costs seconds instead of failing a finished copy.
 * Stops early, without counting the interrupted copy, when the signal aborts.
 */
export async function copyTargets(
  source: Bucket,
  archive: Bucket,
  targets: CopyTarget[],
  options: CopyRunOptions,
): Promise<Pick<RunSummary, "copied" | "failed" | "sourceChanged" | "cidMismatches">> {
  const counts = { copied: 0, failed: 0, sourceChanged: 0, cidMismatches: 0 };
  if (targets.length === 0) return counts;
  const links = await loadLinksBestEffort(options.indexerUrl, options.signal);
  const fetchRecords = createRecordFetcher(options.pdsHosts, options.signal);
  // Sequential on purpose: bumi-0's upload bandwidth is the bottleneck, and
  // one file at a time keeps memory bounded and failures easy to read.
  for (const target of targets) {
    if (options.signal?.aborted) break;
    const key = target.source.key;
    const started = Date.now();
    try {
      const records = await fetchRecords(links.get(key) ?? [], target.source.did);
      const manifest = await copyOriginal(source, archive, target, {
        records,
        maxBytesPerSecond: options.maxBytesPerSecond,
        signal: options.signal,
      });
      counts.copied += 1;
      if (manifest.cidMismatch) counts.cidMismatches += 1;
      log(manifest.cidMismatch ? "warn" : "info", manifest.cidMismatch ? "copied_cid_mismatch" : "copied", {
        key,
        archiveKey: manifest.archive.key,
        bytes: manifest.source.bytes,
        seconds: Math.round((Date.now() - started) / 1000),
        sha256: manifest.sha256,
        cid: manifest.cid,
        record: manifest.record?.uri ?? null,
        recordVerified: manifest.record?.verified ?? null,
        recordVerifiedBy: manifest.record?.verifiedBy ?? null,
        cidMismatch: manifest.cidMismatch ?? null,
      });
    } catch (error) {
      if (options.signal?.aborted) break;
      if (error instanceof SourceChangedError) {
        counts.sourceChanged += 1;
        log("warn", "source_changed", { key, etag: target.etag, ...errorFields(error) });
      } else {
        counts.failed += 1;
        log("error", "copy_failed", { key, etag: target.etag, ...errorFields(error) });
      }
    }
  }
  return counts;
}

export async function runOnce(source: Bucket, archive: Bucket, options: RunOptions): Promise<RunSummary> {
  const done = await listCompletedManifests(archive, options.signal);
  const { pending, tooRecent, skippedKeys } = await findPending(source, done, options.minAgeMs, options.signal);
  log("info", "scan_complete", { archived: done.size, pending: pending.length, tooRecent: tooRecent.length, skippedKeys });

  // Listing order is stable (keys sort lexicographically), so repeated limited
  // runs work through the backlog: each copied file has a manifest next time.
  const selected = options.limit === undefined ? pending : pending.slice(0, options.limit);
  const scanned = { pending: pending.length, tooRecent: tooRecent.length, skippedKeys, deferredByLimit: pending.length - selected.length };
  if (scanned.deferredByLimit > 0) log("info", "limit_applied", { limit: options.limit, selected: selected.length, deferred: scanned.deferredByLimit });
  if (options.dryRun) {
    for (const target of selected) log("info", "would_copy", { key: target.source.key, etag: target.etag });
    for (const item of tooRecent) {
      log("info", "would_skip_too_recent", { key: item.key, etag: item.etag, lastModified: item.lastModified.toISOString() });
    }
    return { ...scanned, copied: 0, failed: 0, sourceChanged: 0, cidMismatches: 0 };
  }
  return { ...scanned, ...(await copyTargets(source, archive, selected, options)) };
}
