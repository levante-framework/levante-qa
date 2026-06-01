#!/usr/bin/env bash
# Skimmer row in vocab-item-bank-en-US.csv points at vocab-item-171 (colander audio).
# Patch audio_file to vocab-item-161 and upload back to levante-assets-dev.
set -euo pipefail

BUCKET="${VOCAB_CORPUS_GCS:-gs://levante-assets-dev/corpus/vocab}"
OBJECT="${BUCKET}/vocab-item-bank-en-US.csv"
TMP="$(mktemp)"
trap 'rm -f "$TMP" "${TMP}.fixed"' EXIT

gsutil cp "$OBJECT" "$TMP"
BEFORE="$(rg -n 'vocab_word_skimmer' "$TMP" || true)"
if [[ -z "$BEFORE" ]]; then
  echo "error: skimmer row not found in $OBJECT" >&2
  exit 1
fi
if ! echo "$BEFORE" | rg -q 'vocab-item-171'; then
  echo "already fixed (no vocab-item-171 on skimmer row):"
  echo "$BEFORE"
  exit 0
fi
sed '/vocab_word_skimmer/ s/,test,vocab-item-171,/,test,vocab-item-161,/' "$TMP" > "${TMP}.fixed"
echo "before: $(rg 'vocab_word_skimmer' "$TMP")"
echo "after:  $(rg 'vocab_word_skimmer' "${TMP}.fixed")"
gsutil cp "${TMP}.fixed" "$OBJECT"
echo "uploaded $OBJECT"
