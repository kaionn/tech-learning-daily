#!/usr/bin/env bash
# 手動専用のプレビュー。本番の deploy 先変数は読まない。
set -euo pipefail
if [ "${GITHUB_REF:-}" != refs/heads/main ]; then
  echo '::error::Workers preview deployment requires main'
  exit 1
fi
git fetch origin main
SHA=$(git rev-parse origin/main)
CLEAN=$(mktemp -d)
trap 'rm -rf "$CLEAN"' EXIT
mkdir "$CLEAN/snapshot"
git archive "$SHA" | tar -x -C "$CLEAN/snapshot"
export PYTHONDONTWRITEBYTECODE=1
python3 "$CLEAN/snapshot/scripts/build_archive.py"
python3 "$CLEAN/snapshot/scripts/build_recent.py"
node "$CLEAN/snapshot/scripts/stage-static-assets.mjs" "$CLEAN/snapshot" "$CLEAN/public"
node "$CLEAN/snapshot/scripts/workers-config.mjs" "$CLEAN/snapshot/wrangler.jsonc" "$CLEAN/wrangler.jsonc" --preview
echo "Deploying preview from latest main snapshot: $SHA"
npx --yes wrangler@4 deploy --config "$CLEAN/wrangler.jsonc" --message "preview main $SHA"
