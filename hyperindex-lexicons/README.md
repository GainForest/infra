# hyperindex-lexicons

The Lexicon set GainForest's Hyperindex (api-hi) indexes, plus the scripts that
rebuild, validate, and upload it as one `uploadLexicons` call.

Uploading one NSID at a time with `registerLexicon` doesn't work for this set.
Every `ref` has to be saved already, and the set has reference cycles
(`app.bsky.actor.defs` ↔ `app.bsky.graph.defs`,
`pub.leaflet.blocks.orderedList` ↔ `unorderedList`).

## Layout

| Path | What it is | Edited by |
|---|---|---|
| `roots.txt` | Record collections to index | you |
| `overrides/lexicons/` | Pinned Lexicon files used instead of the published version | you |
| `lexicons/`, `lexicons.zip`, `sources.txt` | Built set: roots plus every Lexicon they reference | `build.sh` |
| `build.sh` | Builds the set | |
| `check.sh` | Runs Hyperindex's startup validation on the set | |
| `upload.sh` | Uploads `lexicons.zip` | |

`build.sh` takes each NSID from `overrides/` when a file exists there. Otherwise it
fetches the published record the same way `registerLexicon` does:
`_lexicon` DNS TXT → DID → PDS `com.atproto.lexicon.schema`.

Current overrides (21):

- `app.bsky.*` and `com.atproto.*` (18): bluesky-social/atproto `lexicons/` at
  41a561e80. This is the set `app.bsky.embed.external` needs, which
  `app.gainforest.feed.post` references.
- `pub.leaflet.blocks.orderedList`, `unorderedList`: from hypercerts-lexicon
  (32eb7ea). They reference each other.
- `app.gainforest.ac.audio`: the gainforest-app version with `accessUri` and
  `originalCid`. The published version doesn't have them yet; see
  `../hyperindex-lexicon-updates/2026-10-27-ac-audio-access-uri/`.

## Updating

```bash
# 1. change roots.txt or overrides/, or rebuild to pick up republished Lexicons
./build.sh
git diff --stat -- lexicons/          # review what changed

# 2. validate with the Hyperindex version the server runs
HYPERINDEX_SRC=~/Projects/hypercerts/hyperindex HYPERINDEX_REF=origin/main ./check.sh

# 3. commit, then upload and restart Hyperindex
HYPERINDEX_URL=https://api-hi.gainforest.app ADMIN_DID=did:plc:... ADMIN_API_KEY=... ./upload.sh
```

- **Adding a collection:** add a line to `roots.txt`. Its dependencies are added
  for you.
- **Pinning a version:** put the file at
  `overrides/lexicons/<nsid as path>.json`. Do this for unpublished, outdated, or
  patched Lexicons. Remove the file to go back to the published version.
- **Removing:** drop the root from `roots.txt` to leave it out of the zip.
  `uploadLexicons` only upserts, so this doesn't delete anything already saved on
  the server. Use the admin `deleteLexicon` mutation for that.

`upload.sh` upserts, so re-uploading an unchanged set does no harm. Whatever you
upload takes effect at the next restart. Wait for the
`Startup Lexicon set ready` log line. If Jetstream uses a collection filter, it
must cover any new namespaces.

## Requirements

- `build.sh`: `dig`, `curl`, `jq`, `zip`
- `check.sh`: `go`, a local hyperindex git checkout
- `upload.sh`: `curl`, `jq`

## Compatibility

`check.sh` passes on Hyperindex `main` (6218135). d0bc9e3 rejects three of the
Bluesky files (`app.bsky.embed.record`, `feed.defs`, `graph.defs`) because they
use a boolean `const`. Set `HYPERINDEX_REF` to the version the server runs.
