# CLAUDE.md

## プロジェクト概要

tech-learning-daily: ソフトウェア技術の基礎（k8s・負荷試験・DB・ネットワーク・言語ランタイム・ブラウザ・AI・開発ツールの内部など技術系全般）を初学者向けに 1 日 1 トピック解説し、GitHub Pages で公開する静的サイト。tech-news-daily（ニュースダイジェスト）の姉妹サイトで、パイプライン構成は同型。GitHub Actions workflow `daily-article.yml` が claude-code-action で トピック選定 → 調査 → HTML 生成 → main push → Pages デプロイを毎朝自動実行する。

読者像は「Web アプリは書けるがインフラの内部動作は初学者」のエンジニア（= kaionn 自身）。記事の設計思想は `prompts/daily-article.md` の Reader Profile / Writing Rules が一次ソース。

## デプロイパイプライン（GHA daily-article: 生成→push→Pages）

`.github/workflows/daily-article.yml`（cron `23 21 * * *` = 06:23 JST、`workflow_dispatch` で手動実行可）が単一 workflow で完結する:

1. **生成 (claude-code-action@v1)**: `prompts/daily-article.md` の指示に従い Claude がファイルを生成・編集する。**Claude は git 操作を一切しない**（ファイル生成のみ）。prompt 頼みでなく `--disallowedTools` で git 書き込み系をツール層から物理的に拒否している（tech-news-daily で 2026-07-16/17 に prompt のみのガードが突破された教訓）。workflow / prompt を変更する際もこのガードを外さないこと
2. **反映 (workflow step)**: 生成物（`index.html` / `archive/` / `feed.xml` / `topics.md`）に変更があり、`index.html` に当日日付が含まれることを検証してから `github-actions[bot]` 名義で `YYYY-MM-DD の基礎解説: {タイトル}` として main へ commit/push する。変更ゼロ・日付不整合は run を fail させる（失敗が必ず可視化される）
3. **デプロイ**: `GITHUB_TOKEN` push は他 workflow を発火させないため、同 workflow が `configure-pages` → `upload-pages-artifact` → `deploy-pages` を自前実行する

認証は repo secret `CLAUDE_CODE_OAUTH_TOKEN`（Pro/Max サブスクの OAuth トークン、ローカルで `claude setup-token` を実行して生成・失効時も同コマンドで再発行）。PAT は不要。

稼働確認: `gh run list --workflow=daily-article.yml`。失敗時は `gh run view <id> --log-failed`。手動リトライは `gh workflow run daily-article.yml`。

## topics.md（ネタ帳キュー）の運用

- `## キュー` の先頭 1 行を毎朝の run が消化し、`## 消化済み` に日付付きで移す。キューが空なら Claude がカリキュラム領域と過去アーカイブから自走選定する
- どのセッション・どのマシンからでも、ユーザーが「これ分かってないな」と口にした技術系トピック（インフラに限らず言語・ブラウザ・AI・ツール内部など全般）があれば、このリポジトリの `topics.md` のキュー末尾に追記して push してよい（1 行 1 トピック、`（知りたい観点: ...）` を添える）
- キューの並び順が配信順。優先したいトピックは先頭に移動する

## HTML 構造と生成 prompt の同期

`index.html` の記事構造・CSS クラス（meta-bar, tldr, body-section, diagram, analogy, practical, hands-on, misconceptions, glossary, further-reading 等）を変更した場合、生成 prompt `prompts/daily-article.md` も**同一コミットで**必ず更新する。prompt はテンプレートとして記事構造を前提に毎日生成するため、HTML 構造と prompt が乖離すると生成結果が壊れる。`style.css` に新クラスを足したら prompt の構造定義にも追記する。

## サイトアセット変更は push まで完了させる

`index.html` / `style.css` / `feed.xml` / `prompts/` を変更したら、同セッション内で必ず commit → push まで完了させる。日次 workflow は毎朝 origin/main を前提に生成・push するため、ローカル未 push の変更は公開サイトに反映されないだけでなく、日次 push とローカルが分岐する。

## archive/ の整合性

- 当日分（`index.html` のトップ）は、翌日 run の「昨日分をアーカイブ」ステップで初めて `archive/YYYY-MM-DD.html` 化される。当日中は `archive/index.html` の当日リンクが 404 になるが仕様通り
- 一覧リンクと実ファイルがズレた場合、git コミット履歴が一次ソース（`git show <commit>:index.html` で各日の記事を復元できる）

## コミット前セルフチェック（手動更新時）

- 記事の全 `<a href>` が具体ページへの直リンク（トップページ・docs ルート禁止）
- 本文中の数値・バージョン・デフォルト値に出典がある（発明しない）
- feed.xml の最新 `<entry>` の日付・タイトルが index.html と整合
- topics.md のキューから当日トピックが消え、消化済みに移っている
