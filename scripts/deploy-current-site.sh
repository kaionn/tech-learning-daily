#!/usr/bin/env bash
# deploy-current-site.yml の site-deploy ロック下でのみ呼ばれる。
set -euo pipefail
# 未設定/空は Pages。別途承認された cutover まで本番を動かさないため。
TARGET=${SITE_DEPLOY_TARGET:-pages}
case "$TARGET" in
  pages|workers) ;;
  *) echo "::error::SITE_DEPLOY_TARGET must be pages or workers"; exit 1 ;;
esac
git fetch origin main
SHA=$(git rev-parse origin/main)
CLEAN=$(mktemp -d)
trap 'rm -rf "$CLEAN"' EXIT
# 呼び出し元 HEAD は使わない。遅れて終わった古い run が新しい push を巻き戻さないように。
mkdir "$CLEAN/snapshot"
git archive "$SHA" | tar -x -C "$CLEAN/snapshot"
# 再生成漏れの push でも公開一覧を articles.json に揃える。
# bytecode を止めるのは、Pages が tree 全体を上げるため __pycache__ が公開されてしまうから。
export PYTHONDONTWRITEBYTECODE=1
python3 "$CLEAN/snapshot/scripts/build_archive.py"
python3 "$CLEAN/snapshot/scripts/build_recent.py"
echo "Deploying latest main snapshot to $TARGET: $SHA"
if [ "$TARGET" = pages ]; then
  SUBJECT=$(git log -1 --format=%s "$SHA")
  # wrangler は cwd から上へ設定を探す。リポジトリ直下の wrangler.jsonc を Pages 設定として読ませない。
  # git repo 外の cwd では wrangler がメッセージを拾えないので明示する。
  cd "$CLEAN"
  npx --yes wrangler@4 pages deploy "$CLEAN/snapshot" --project-name=tech-learning-daily --branch=main --commit-hash="$SHA" --commit-message="$SUBJECT"
else
  node "$CLEAN/snapshot/scripts/workers-config.mjs" "$CLEAN/snapshot/wrangler.jsonc" "$CLEAN/wrangler.jsonc"
  node "$CLEAN/snapshot/scripts/stage-static-assets.mjs" "$CLEAN/snapshot" "$CLEAN/public"
  npx --yes wrangler@4 deploy --config "$CLEAN/wrangler.jsonc" --message "main $SHA"
fi
