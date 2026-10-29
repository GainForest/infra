#!/usr/bin/env bash
# Validate lexicons/ with Hyperindex's own startup checks (CheckLexiconBytes per
# file, CheckLexiconSet for the whole set), so a bad set is caught before upload.
#
#   HYPERINDEX_SRC=~/Projects/hypercerts/hyperindex \
#   HYPERINDEX_REF=origin/main \
#   ./check.sh
#
# Use the HYPERINDEX_REF your server runs; older versions accept fewer schemas.
set -euo pipefail
cd "$(dirname "$0")"
: "${HYPERINDEX_SRC:?set HYPERINDEX_SRC to a local hyperindex git checkout}"
ref=${HYPERINDEX_REF:-origin/main}
lexdir=$(pwd)/lexicons
[ -d "$lexdir" ] || { echo "no lexicons/; run ./build.sh first" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# git archive copies the tree without touching the checkout or its worktrees.
git -C "$HYPERINDEX_SRC" archive "$ref" | tar -x -C "$work"
module=$(awk '/^module /{print $2; exit}' "$work/go.mod")

mkdir -p "$work/internal/zz_lexcheck"
cat > "$work/internal/zz_lexcheck/set_test.go" <<EOF
package zz_lexcheck

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"$module/internal/validation"
)

func TestLexiconSet(t *testing.T) {
	root := os.Getenv("LEXDIR")
	saved := map[string][]byte{}
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".json") {
			return err
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		id := strings.ReplaceAll(strings.TrimSuffix(rel, ".json"), string(filepath.Separator), ".")
		if err := validation.CheckLexiconBytes(id, raw); err != nil {
			t.Errorf("%s: %v", id, err)
		}
		saved[id] = raw
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := validation.CheckLexiconSet(saved); err != nil {
		t.Fatalf("set: %v", err)
	}
	t.Logf("%d lexicons valid", len(saved))
}
EOF

echo "checking against hyperindex $(git -C "$HYPERINDEX_SRC" rev-parse --short "$ref") ($ref)"
(cd "$work" && LEXDIR="$lexdir" go test -count=1 -v ./internal/zz_lexcheck/) |
  grep -E 'set_test|^(ok|FAIL|---)'
