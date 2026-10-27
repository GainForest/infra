/**
 * Key layout contract.
 *
 * Source keys are written by gainforest-app's POST /api/audiomoth/recordings:
 *   audiomoth/<uploaderDid>/<deploymentId | "unassigned">/<file>.wav
 * If that route ever changes its key format, update SOURCE_KEY_PATTERN here.
 *
 * Archive keys mirror the source key and add the source ETag, so a file that is
 * re-uploaded under the same name is archived as a new copy instead of
 * overwriting the old one:
 *   audio/v1/<uploaderDid>/<deploymentId>/<file>.wav/<etag>.wav
 *   audio/v1/<uploaderDid>/<deploymentId>/<file>.wav/<etag>.manifest.json
 */

export const SOURCE_PREFIX = "audiomoth/";
export const ARCHIVE_PREFIX = "audio/v1/";

const SOURCE_KEY_PATTERN =
  /^audiomoth\/(did:[a-z0-9:%.\-_]+)\/([0-9a-f]{16}|unassigned)\/([A-Za-z0-9._\-]{1,200}\.wav)$/i;

export type SourceKey = { key: string; did: string; deploymentId: string; filename: string };

export function parseSourceKey(key: string): SourceKey | null {
  const match = SOURCE_KEY_PATTERN.exec(key);
  if (!match) return null;
  const [, did, deploymentId, filename] = match;
  return { key, did: did!, deploymentId: deploymentId!, filename: filename! };
}

/** S3 returns ETags quoted; multipart ETags end in "-<parts>". */
export function normaliseEtag(etag: string | undefined): string | null {
  const bare = etag?.replace(/^W\//, "").replace(/"/g, "").trim() ?? "";
  return /^[A-Za-z0-9-]{1,100}$/.test(bare) ? bare : null;
}

export type ArchivePaths = { objectKey: string; manifestKey: string };

export function archivePaths(source: SourceKey, etag: string): ArchivePaths {
  const dir = `${ARCHIVE_PREFIX}${source.did}/${source.deploymentId}/${source.filename}`;
  return { objectKey: `${dir}/${etag}.wav`, manifestKey: `${dir}/${etag}.manifest.json` };
}

/** The source key of a recording's original, read back from an ac.audio accessUri. */
export function sourceKeyFromAccessUri(accessUri: string | null | undefined): string | null {
  if (!accessUri) return null;
  try {
    const url = new URL(accessUri, "https://placeholder.invalid");
    if (!url.pathname.endsWith("/api/audiomoth/recordings")) return null;
    const key = url.searchParams.get("key");
    return key && key.startsWith(SOURCE_PREFIX) ? key : null;
  } catch {
    return null;
  }
}
