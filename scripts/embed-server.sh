#!/bin/sh
# Starts the pinned llama-server for embeddings on loopback only.
# Usage: CODETRAIL_MODELS_DIR=~/Developer/codetrail-models scripts/embed-server.sh
set -eu
DIR="${CODETRAIL_MODELS_DIR:-./models}"
RELEASE=$(node -e "console.log(require('./models.lock.json').runtime.release)")
FILE=$(node -e "console.log(require('./models.lock.json').embedding.file)")
ARGS=$(node -e "console.log(require('./models.lock.json').runtime.serverArgs.join(' '))")
BIN=$(find "$DIR/runtime/$RELEASE" -name llama-server -type f | head -n 1)
[ -n "$BIN" ] || { echo "llama-server not found under $DIR/runtime/$RELEASE (run scripts/fetch-models.mjs)" >&2; exit 1; }
# shellcheck disable=SC2086
exec "$BIN" -m "$DIR/models/$FILE" $ARGS
