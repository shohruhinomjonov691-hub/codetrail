#!/bin/sh
# Starts the pinned llama-server for the D0 generation benchmark on loopback only.
# Usage: CODETRAIL_MODELS_DIR=~/Developer/codetrail-models scripts/gen-server.sh [generation|generation7b]
set -eu
KEY="${1:-generation}"
case "$KEY" in generation|generation7b) ;; *) echo "unknown model key: $KEY" >&2; exit 1 ;; esac
DIR="${CODETRAIL_MODELS_DIR:-./models}"
RELEASE=$(node -e "console.log(require('./models.lock.json').runtime.release)")
FILE=$(node -e "console.log(require('./models.lock.json')['$KEY'].file)")
SHA=$(node -e "console.log(require('./models.lock.json')['$KEY'].sha256)")
ARGS=$(node -e "console.log(require('./models.lock.json')['$KEY'].serverArgs.join(' '))")
BIN=$(find "$DIR/runtime/$RELEASE" -name llama-server -type f | head -n 1)
[ -n "$BIN" ] || { echo "llama-server not found under $DIR/runtime/$RELEASE" >&2; exit 1; }
GOT=$(shasum -a 256 "$DIR/models/$FILE" | cut -d' ' -f1)
[ "$GOT" = "$SHA" ] || { echo "sha256 mismatch for $FILE" >&2; exit 1; }
# shellcheck disable=SC2086
exec "$BIN" -m "$DIR/models/$FILE" $ARGS
