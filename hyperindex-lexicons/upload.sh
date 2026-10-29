#!/usr/bin/env bash
# Upload lexicons.zip to Hyperindex in one uploadLexicons call. Saved only;
# takes effect after a Hyperindex restart. Run it yourself; review first.
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
[ -f lexicons.zip ] || { echo "no lexicons.zip; run ./build.sh first" >&2; exit 1; }

# One call on purpose: the set has reference cycles (app.bsky.actor.defs <->
# app.bsky.graph.defs, pub.leaflet.blocks.orderedList <-> unorderedList) that
# registerLexicon cannot save one NSID at a time.
base64 -w0 lexicons.zip |
  jq -Rn '{query: "mutation($zip: String!) { uploadLexicons(zipBase64: $zip) }", variables: {zip: input}}' |
  curl -sS --fail-with-body "${HYPERINDEX_URL%/}/admin/graphql" \
    -H 'content-type: application/json' \
    -H "X-User-DID: ${ADMIN_DID}" \
    -H "X-Admin-API-Key: ${ADMIN_API_KEY}" \
    --data-binary @- | jq .
echo "expected count: $(wc -l < sources.txt). Restart Hyperindex to apply."
