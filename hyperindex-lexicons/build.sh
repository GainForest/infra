#!/usr/bin/env bash
# Build lexicons/ and lexicons.zip from roots.txt plus everything they reference.
# Each NSID comes from overrides/ when a file exists there, otherwise from its
# published record (_lexicon DNS TXT -> DID -> PDS com.atproto.lexicon.schema),
# the same resolution Hyperindex registerLexicon uses.
set -euo pipefail
cd "$(dirname "$0")"
for cmd in dig curl jq zip; do
  command -v "$cmd" >/dev/null || { echo "build.sh needs $cmd on PATH" >&2; exit 1; }
done

nsid_path() { echo "lexicons/$(echo "$1" | tr . /).json"; }

declare -A did_by_authority pds_by_did

resolve_pds() {
  local nsid=$1 authority did
  # app.gainforest.feed.post -> _lexicon.feed.gainforest.app
  authority=$(echo "${nsid%.*}" | awk -F. '{for (i = NF; i > 0; i--) printf "%s%s", $i, (i > 1 ? "." : "")}')
  if [ -z "${did_by_authority[$authority]:-}" ]; then
    did=$(dig +short TXT "_lexicon.$authority" | tr -d '"' | sed -n 's/^did=//p' | head -1)
    [ -n "$did" ] || { echo "no _lexicon.$authority DNS record for $nsid; add overrides/$(nsid_path "$nsid")" >&2; return 1; }
    did_by_authority[$authority]=$did
  fi
  did=${did_by_authority[$authority]}
  if [ -z "${pds_by_did[$did]:-}" ]; then
    pds_by_did[$did]=$(curl -sSf "https://plc.directory/$did" |
      jq -r '.service[] | select(.id == "#atproto_pds") | .serviceEndpoint')
  fi
  echo "$did ${pds_by_did[$did]}"
}

fetch_published() {
  local nsid=$1 did pds
  read -r did pds < <(resolve_pds "$nsid")
  curl -sSf "$pds/xrpc/com.atproto.repo.getRecord?repo=$did&collection=com.atproto.lexicon.schema&rkey=$nsid" |
    jq '.value | del(."$type")'
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mapfile -t queue < <(sed -e 's/#.*//' -e 's/[[:space:]]//g' roots.txt | grep -v '^$')
declare -A seen
: > "$work/sources.txt"
while [ ${#queue[@]} -gt 0 ]; do
  nsid=${queue[0]}
  queue=("${queue[@]:1}")
  [ -n "${seen[$nsid]:-}" ] && continue
  seen[$nsid]=1

  rel=$(nsid_path "$nsid")
  mkdir -p "$work/$(dirname "$rel")"
  if [ -f "overrides/$rel" ]; then
    jq . "overrides/$rel" > "$work/$rel"
    echo "$nsid override" >> "$work/sources.txt"
  else
    fetch_published "$nsid" > "$work/$rel"
    echo "$nsid published" >> "$work/sources.txt"
  fi
  got=$(jq -r .id "$work/$rel")
  [ "$got" = "$nsid" ] || { echo "$rel has id $got, expected $nsid" >&2; exit 1; }

  for ref in $(jq -r '.. | objects | (.ref?, (.refs? // [])[]?) | strings' "$work/$rel" |
               grep -v '^#' | sed 's/#.*//' | sort -u); do
    [ -z "${seen[$ref]:-}" ] && queue+=("$ref")
  done
done

rm -rf lexicons lexicons.zip
mv "$work/lexicons" lexicons
sort "$work/sources.txt" > sources.txt
# -X and sorted input keep the zip byte-identical when nothing changed.
find lexicons -name '*.json' | LC_ALL=C sort | TZ=UTC xargs touch -t 202001010000
find lexicons -name '*.json' | LC_ALL=C sort | zip -q -X lexicons.zip -@

echo "built $(wc -l < sources.txt) lexicons ($(grep -c ' override$' sources.txt) from overrides/)"
echo "review: git diff --stat -- lexicons/   then run ./check.sh"
