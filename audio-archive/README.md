# audio-archive

Copies original AudioMoth recordings from Cloudflare R2 into the shared archive
bucket (the same one the BioBlitz archive uses), so a recording survives being
deleted in the app or lost from R2.

## Why it exists

gainforest-app uploads each original WAV straight to R2 and keeps only a small
preview on the PDS. Deleting a recording in the app also deletes the R2 original,
and R2 has no other copy. This runner keeps one.

Files uploaded and deleted between two runs are not captured. That gap is accepted.

## Layout

Source (written by gainforest-app `POST /api/audiomoth/recordings`):

```
audiomoth/<uploaderDid>/<deploymentId | unassigned>/<file>.wav
```

The app limits files to 2 GB, but only by the size the browser declares when it
asks for an upload URL. The URL does not enforce it, so the runner does not
assume it and copies whatever is there.

Archive (mirrors the source key, adds the source ETag):

```
audio/v1/<uploaderDid>/<deploymentId>/<file>.wav/<etag>.wav
audio/v1/<uploaderDid>/<deploymentId>/<file>.wav/<etag>.manifest.json
```

- The folder is the **uploader's** DID. For an organization recording, the
  organization is in `record.ownerDid` when its record is the one chosen (see
  below); otherwise its record URI is listed in `record.otherCandidates`.
- Uploading *different bytes* under an existing name changes the ETag, so they
  are archived as a new copy instead of overwriting the old one. Uploading the
  same bytes again gives the same ETag and is not archived twice.
- If gainforest-app changes its key format, update `SOURCE_KEY_PATTERN` in
  `src/keys.ts`. Unrecognised keys are logged as `unrecognised_source_key`
  (with their ETag) and skipped.

## How a run works

1. Take the lock (see below). A dry run (`--dry-run`) takes none.
2. List every `*.manifest.json` under `audio/v1/` in the archive.
3. List every object under `audiomoth/` in R2. One is pending if the archive has
   no manifest for its current ETag.
   Objects modified in the last 30 minutes are left for a later run and counted
   as `tooRecent`: the app uploads the WAV first and writes its `ac.audio` record
   afterwards, so copying at once would archive the file before the record exists.
4. Load the `ac.audio` records from the indexer (best effort).
5. Copy each pending object, one at a time:
   - fetch the candidate records' values from their owners' PDSes. This comes
     first so a slow or broken PDS costs a warning, not a finished transfer;
   - stream from R2 (`If-Match` on the ETag) into a multipart upload to the
     archive (16 MB parts, about 65 MB of part buffers), hashing as it goes;
   - check the byte count and the archived size, choose the record, then write
     the manifest **last**. A manifest means the copy is complete; an
     interrupted copy has none and is redone next run.

A copy that fails is retried by the next run. A file that was deleted or replaced
after it was listed (`NoSuchKey`/404, or 412 from the `If-Match` read) is logged
as `source_changed` at `warn` and counted separately; it is not a failure.

There is no database or local state. The archive itself is the progress record,
so the runner can move to another machine without losing anything.

Memory stays flat however large the file: the process's resident size was about
200–350 MB (270 MB measured copying a 1.5 GB file on Linux).

**The lock** is a loopback TCP port (`127.0.0.1:29437`, `AUDIO_ARCHIVE_LOCK_PORT`)
held for the length of a run. The kernel frees it however the process ends,
including `kill -9`, so a crashed run never leaves a stale lock behind. A second
run logs `already_running` and exits 0. The lock holder answers connections on
the port with a short banner, so if some other program is using the port the run
fails with an error naming `AUDIO_ARCHIVE_LOCK_PORT` instead of quietly skipping.

## Manifest

```jsonc
{
  "formatVersion": 1,
  "source": { "bucket": "gainforest-data-jobs", "key": "audiomoth/…", "etag": "…", "bytes": 123, "lastModified": "…" },
  "archive": { "bucket": "…", "key": "audio/v1/…", "storageClass": "GLACIER_IR" },
  "sha256": "…",
  "cid": "bafkrei…",              // CID of the archived bytes; same format as ac.audio originalCid
  "originalCid": "bafkrei…",      // only if a verified record carried one
  "cidMismatch": false,           // only with originalCid. true = archived bytes differ from what the app hashed at upload
  "record": {                     // only if some ac.audio record claims this file
    "uri": "at://…", "ownerDid": "did:plc:…",
    "cid": "…",                   // the CID the indexer had for the record
    "pdsCid": "…",                // the CID the owner's PDS returned with value
    "value": { /* the record as the owner's PDS serves it, or null if it couldn't be fetched */ },
    "verified": true,
    "verifiedBy": "uploaderDid",  // or "originalCid"; absent when verified is false
    "otherCandidates": ["at://…"] // other records claiming the same file, at most 20
  },
  "capturedAt": "…"
}
```

### Treat `record` as a hint unless `record.verified` is true

Records are matched to files through the indexer, by the file key in `accessUri`.
Anyone can publish a record that names someone else's file, so a record found
that way is a claim, not proof. The runner keeps every claimant and, once the
bytes are hashed, picks one:

- `verified: true`, `verifiedBy: "uploaderDid"`: the record is in the repo of the
  account that uploaded the file (the DID in the object key). Only that account
  can write under its prefix, so this is the strong link.
- `verified: true`, `verifiedBy: "originalCid"`: the record's `originalCid` is
  the CID of the archived bytes. This is how an organization's record for a
  member's upload verifies. It shows the record's author held the same bytes, but
  recordings are downloadable, so it is weaker.
- `verified: false`: nothing vouches for any claimant. The earliest-indexed record
  is kept anyway so you can see who claims the file, and the others are listed in
  `otherCandidates`.

When several records verify, one that passes both tests wins, then the
uploader's own, then an `originalCid` match; ties go to the earliest indexed.
The indexer is paged newest-first, so if loading stops early (a 5-minute deadline
or 200 pages of 1,000, logged as `record_links_truncated`) it is the oldest
records that are missing, not the recent ones pending files need. Per file, the
uploader's own records are read from their PDS first, and at most 10 candidates
are read (`record_candidates_not_fetched` when more claim the file).

Records are ordered by `indexed_at`: when the indexer last saw each one
(an edit moves a record later). Unlike `createdAt`, the author cannot choose it. If
the indexer's schema lacks that sort, the runner falls back to `createdAt`; the
`record_links_query` log line says which one was used.

`originalCid` and `cidMismatch` are only filled in from a verified record, so a
stranger's record cannot raise an integrity alarm about someone else's file.
`cidMismatch: true` means the bytes in the archive differ from the CID in the
uploader's own record. The copy is kept (it may be the only one) and logged at
`warn`.

Limits: a file's record is not looked up again after its manifest exists, so a
file archived while the indexer was down stays without a `record`. An
organization's record for a damaged file has neither test to pass and shows as
unverified. The app only computes `originalCid` for files up to 1 GiB, so an
organization's record for a larger file can never verify by CID either.

The PDS lookups follow the owner DID and the service endpoint in its DID document,
both of which come from public records. So the runner only contacts
`plc.directory` and hosts on `AUDIO_ARCHIVE_PDS_HOSTS` (default `certified.one`,
exact hostname match, like the BioBlitz archive):

- a `did:web` DID's host must be on the list before its DID document is fetched;
- the PDS a DID document names must be on the list, use `https`, and be a bare
  origin with no port or credentials.

Redirects are errors, and responses are cut off at 64 KiB (DID document) and
256 KiB (record). A network error, 5xx or 429 is retried once after 1.5 s, and a
failed DID lookup is not cached, so the next file tries again. A record on any
other PDS is still linked and verified; only its `value` and `pdsCid` are
`null`, with a `record_value_unavailable` warning in the log.

## Configuration

Set in `.env` (see `.env.example`). The `DATA_JOBS_S3_*` and `ARCHIVE_S3_*` values
are the same ones gainforest-app reads.

| Variable | Default | |
|---|---|---|
| `DATA_JOBS_S3_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY` | required | Source (R2). `_REGION` defaults to `auto` |
| `ARCHIVE_S3_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY` | required | Archive. On AWS also set `ARCHIVE_S3_REGION` (e.g. `eu-west-3`): the runner refuses an `amazonaws.com` endpoint with an empty or `auto` region |
| `INDEXER_URL` | `https://api-hi.gainforest.app/graphql` | Where `ac.audio` records come from |
| `AUDIO_ARCHIVE_PDS_HOSTS` | `certified.one` | Comma-separated PDS hostnames the runner may read record values from |
| `AUDIO_ARCHIVE_MIN_AGE_MINUTES` | `30` | Leave files younger than this for a later run. `0` turns the wait off |
| `AUDIO_ARCHIVE_MAX_MBPS` | unlimited | Cap on transfer speed in **megabits** per second (`80` ≈ 10 MB/s). Paces the download and the upload together. It caps the average: parts still leave in 16 MiB bursts at full speed |
| `AUDIO_ARCHIVE_LOCK_PORT` | `29437` | Loopback port used as the lock |
| `SOURCE_S3_CHECKSUM_MODE` | unset | `when_required`: see Troubleshooting |

## Setup on bumi-0

Requires Node 22.18+ (runs TypeScript directly, no build step) and pnpm.

```sh
pnpm install --prod
cp .env.example .env    # fill in the same DATA_JOBS_S3_* and ARCHIVE_S3_* values as the app
chmod 600 .env          # it holds bucket credentials
mkdir -p logs

pnpm plan                                   # dry run: lists what would be copied, and what is too recent
pnpm copy-one 'audiomoth/did:plc:…/…/….wav' # copy a single file end to end; refuses if it is already
                                            # archived, add --force to copy it again
pnpm archive --limit 20                     # copy at most 20 pending files, then stop
pnpm archive                                # one full run by hand
```

### First backfill, in slices

```sh
pnpm plan > logs/plan.log && grep '"scan_complete"' logs/plan.log   # size of the backlog
pnpm copy-one '<a small key>'; pnpm copy-one '<the largest key>'    # end to end, memory, speed
AUDIO_ARCHIVE_MAX_MBPS=50 pnpm archive --limit 20                   # first real slice, capped
```

Repeat `--limit` runs as often as you like: each one skips everything that
already has a manifest, so it carries on where the last one stopped. Pending
files are taken in key order, so a slice is predictable. When the slices look
right, run `pnpm archive` off-peak for the rest, then install the launchd job.

### Resuming after a failure

There is nothing to resume by hand. A file counts as done only once its manifest
is written, and every run starts by listing the manifests:

- Ctrl-C, `launchctl bootout`, a crash, a reboot or a network drop in the middle of
  a run: the files finished before it are skipped next time; the one in flight is
  copied again from the start. Its partial multipart upload is aborted on a clean
  stop, and the bucket's lifecycle rule cleans it up otherwise.
- A file that fails (`copy_failed`) is retried by the next run. One that keeps
  failing is retried every run, and because slices go in key order, a run of
  permanently failing files at the start can use up a `--limit` slice: check the
  `copy_failed` lines.
- Resuming is per file, not per byte: an interrupted 2 GB file is downloaded
  again in full.

Try `copy-one` on one real file before the first full run. Its `copied` log line
shows the archive key, `sha256`, `cid`, the chosen record and whether it verified.
Arguments are checked
strictly (`--dryrun` is an error, not a real run).

**The first full run copies everything in the bucket at full speed.** bumi-0 also
serves production, so run the backfill off-peak or set `AUDIO_ARCHIVE_MAX_MBPS`
(say `50`) until it has caught up.

### Schedule hourly (launchd)

```sh
mkdir -p ~/Library/LaunchAgents logs
sed -e "s|__DIR__|$PWD|g" -e "s|__NODE__|$(node -p process.execPath)|g" \
  launchd/app.gainforest.audio-archive.plist > ~/Library/LaunchAgents/app.gainforest.audio-archive.plist
launchctl bootout gui/$(id -u)/app.gainforest.audio-archive 2>/dev/null || true   # nothing to remove on first install
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.gainforest.audio-archive.plist
```

- The plist holds the full path to this Node binary. With nvm or Homebrew that path
  contains the version, so **re-run the install after upgrading Node**.
- A LaunchAgent only runs inside a logged-in user's GUI session. On a headless Mac
  mini that means turning on automatic login, or the job stops after a reboot until
  someone logs in. The alternative is a LaunchDaemon: put the plist in
  `/Library/LaunchDaemons` (owned by root), add a `UserName` key, and bootstrap it into
  `system`. Only the LaunchAgent route is set up here.
- Stop: `launchctl bootout gui/$(id -u)/app.gainforest.audio-archive`.

### Logs, exit codes, stopping

Logs go to `logs/audio-archive.log`, one JSON object per line. Nothing rotates
them. Each run writes a handful of lines plus one per file, so they grow slowly, but
add a newsyslog entry (`man newsyslog.conf`) such as this in
`/etc/newsyslog.d/audio-archive.conf`, adjusting path and user:

```
/Users/bumi/audio-archive/logs/audio-archive.log  bumi:staff  644  7  5120  *  JNB
```

- `run_complete` summarises each run: `info` normally, `warn` if any key was
  skipped as unrecognised or any `cidMismatch` was found, `error` if a copy failed.
  It is **not** written when a run dies early (bad config, a listing that fails): that
  logs `fatal` at `error`. Watch for `"level":"error"` as well as `run_complete`.
- Exit codes: `0` done (also when another run holds the lock), `1` a copy failed
  or the run died, `2` bad arguments, `130`/`143` stopped by SIGINT/SIGTERM.
- SIGTERM and SIGINT cancel the transfer in progress (its multipart upload is
  aborted) and stop before the next file. A copy that has already read its last
  ~80 MB from R2 finishes uploading first. launchd waits `ExitTimeOut` (120 s in the
  plist) after SIGTERM before it sends SIGKILL. A second signal quits at once, and
  `kill -9` can leave parts behind, hence the lifecycle rule below.

## Bucket setup

**Source (R2).** The runner only lists and reads, and never writes to or deletes from
the source. Give it a read-only token (R2 "Object Read only") scoped to that bucket.

**Archive (S3).** Credentials the runner needs, and nothing else (no delete):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::<bucket>",
      "Condition": { "StringLike": { "s3:prefix": "audio/v1/*" } } },
    { "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::<bucket>/audio/v1/*" }
  ]
}
```

`s3:GetObject` also covers the `HEAD` that checks the archived size.

Add a lifecycle rule **AbortIncompleteMultipartUpload after 1–3 days**, so an
upload cut off by a crash or power loss does not keep billing for its parts. Check
that no expiration or transition rule on the bucket covers `audio/v1/`.

Objects are written as `GLACIER_IR`: immediate reads, a 90-day minimum storage
charge, and a per-GB retrieval fee.

## Restoring a file

```sh
BUCKET=<archive bucket>; DIR=audio/v1/<did>/<deployment>/<file>.wav
aws s3 ls --region eu-west-3 s3://$BUCKET/$DIR/                              # <etag>.wav and <etag>.manifest.json pairs
aws s3 cp --region eu-west-3 s3://$BUCKET/$DIR/<etag>.manifest.json -        # read the manifest
aws s3 cp --region eu-west-3 s3://$BUCKET/$DIR/<etag>.wav ./<file>.wav
shasum -a 256 ./<file>.wav                                                   # must equal "sha256" in the manifest
```

A file name can hold several `<etag>.wav` and `<etag>.manifest.json` pairs, one per
distinct upload under that name. Compare `source.lastModified` and `capturedAt` in
the manifests to choose. `GLACIER_IR` objects download immediately with no restore
request; AWS bills a per-GB retrieval fee.

## Troubleshooting

- **The first `copy-one` fails against R2 and the error mentions `x-amz-checksum-mode`.**
  The AWS SDK adds that header (and response checksum validation) to every read by
  default. If R2 rejects it, set `SOURCE_S3_CHECKSUM_MODE=when_required` in `.env`.
  This only changes the source client; uploads to the archive keep their checksums.
- **Every request to the archive fails with a signature or region error.** Check
  `ARCHIVE_S3_REGION`; the runner already refuses to start with an AWS endpoint and no region.
- **`fatal` saying the lock port is in use by another program.** Set
  `AUDIO_ARCHIVE_LOCK_PORT` to a free port.

## Development

```sh
pnpm install
pnpm test
pnpm typecheck
```

The tests use an in-memory S3 and a stubbed `fetch`; they open no connections to the
network or to real buckets.
