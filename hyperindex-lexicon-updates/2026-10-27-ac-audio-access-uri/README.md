# Hyperindex: add accessUri / originalCid to app.gainforest.ac.audio

**Why:** the audio archive runner links each archived WAV to its `ac.audio` record
through `accessUri`. api-hi's registered `ac.audio` lexicon predates that field, so
queries fail with `Cannot query field "accessUri" on type "AppGainforestAcAudio"`.

**Source of the schema:** gainforest-app
`app/[locale]/docs/lexicons/_schemas/app/gainforest/ac/audio.json` (last changed in
103f5680, 2026-07-24). It is the version the app writes. **GainForest/lexicons
`main` (6c27c30) does not have these fields**, so upstream should be updated too.

Differences from GainForest/lexicons main:

- adds `accessUri` (string, uri), `originalCid` (string, cid), `variantLiteral` (string)
- `blob` is no longer required (required: `metadata`, `createdAt`), so `blob`
  becomes nullable in GraphQL
- keeps `uploadedBy`; references only `app.gainforest.common.defs#audio|richtext|spectrogram|imageThumbnail`,
  which upstream common.defs already has

## Files

- `ac-audio.zip`: one file, `lexicons/app/gainforest/ac/audio.json`
  (sha256 1d9701154da605851c1e6898ed7c79421726e4e0b982935dd0ac4dd8cd80d82c)
- `ac-audio.zip.b64`: the same, base64, no newline
- `upload.sh`: calls the admin `uploadLexicons` mutation. Not run.

## Steps

1. `./upload.sh` with `HYPERINDEX_URL`, `ADMIN_DID`, `ADMIN_API_KEY` set.
   Expect `{"data":{"uploadLexicons":1}}`. `uploadLexicons` upserts, so no delete
   is needed. It validates the whole next-startup lexicon set before saving.
2. Restart Hyperindex on bumi-0; wait for the `Startup Lexicon set ready` log line.
3. Check (public endpoint):

   ```graphql
   { appGainforestAcAudio(first: 3) { edges { node { uri accessUri originalCid } } } }
   ```

   Records are stored as full JSON, so existing records should show the fields
   without re-indexing (read from Hyperindex d0bc9e3 source; not yet verified on api-hi).
4. In audio-archive: `pnpm plan`, then a `copy-one`; the log should show
   `record_links_query` and `recordVerified`.
   Relink the one already-archived test file with
   `pnpm copy-one 'audiomoth/did:plc:5bvxtsctrwstyyv3ufet3kwh/284dac4b4d252ee5/20261003_101500.WAV' --force`.

**Risk:** the restart briefly interrupts api-hi reads for the app.
