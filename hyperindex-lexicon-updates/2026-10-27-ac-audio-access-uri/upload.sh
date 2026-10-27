#!/usr/bin/env bash
# Upload the updated app.gainforest.ac.audio lexicon to Hyperindex (saved only;
# takes effect after a Hyperindex restart). Run it yourself; review first.
#
#   HYPERINDEX_URL=https://api-hi.gainforest.app \
#   ADMIN_DID=did:plc:<an admin DID> \
#   ADMIN_API_KEY=... \
#   ./upload.sh
set -euo pipefail
cd "$(dirname "$0")"
: "${HYPERINDEX_URL:?set HYPERINDEX_URL, e.g. https://api-hi.gainforest.app}"
: "${ADMIN_DID:?set ADMIN_DID to an admin DID listed in Hyperindex ADMIN_DIDS}"
: "${ADMIN_API_KEY:?set ADMIN_API_KEY (Hyperindex ADMIN_API_KEY)}"

jq -n --rawfile zip ac-audio.zip.b64 \
  '{query: "mutation($zip: String!) { uploadLexicons(zipBase64: $zip) }", variables: {zip: ($zip | rtrimstr("\n"))}}' |
  curl -sS --fail-with-body "${HYPERINDEX_URL%/}/admin/graphql" \
    -H 'content-type: application/json' \
    -H "X-User-DID: ${ADMIN_DID}" \
    -H "X-Admin-API-Key: ${ADMIN_API_KEY}" \
    --data-binary @- | jq .
# Expected: {"data":{"uploadLexicons":1}}
