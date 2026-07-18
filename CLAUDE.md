# CLAUDE.md

## プロジェクト概要

tech-learning-daily: ソフトウェア技術の基礎（k8s・負荷試験・DB・ネットワーク・言語ランタイム・ブラウザ・AI・開発ツールの内部など技術系全般）を初学者向けに 1 日 1 トピック解説し、Cloudflare Pages で公開する静的サイト。tech-news-daily（ニュースダイジェスト）の姉妹サイトで、パイプライン構成は同型。GitHub Actions workflow `daily-article.yml` が claude-code-action で トピック選定 → 調査 → HTML 生成 → main push → Cloudflare Pages デプロイを毎朝自動実行する。

読者像は「Web アプリは書けるがインフラの内部動作は初学者」のエンジニア（= kaionn 自身）。記事の設計思想は `prompts/daily-article.md` の Reader Profile / Writing Rules が一次ソース。

## デプロイパイプライン（GHA daily-article: 生成→push→Cloudflare Pages）

`.github/workflows/daily-article.yml`（cron `23 21 * * *` = 06:23 JST、`workflow_dispatch` で手動実行可）が単一 workflow で完結する:

1. **生成 (claude-code-action@v1)**: `prompts/daily-article.md` の指示に従い Claude がファイルを生成・編集する（記事 HTML + `data/articles.json` への 1 エントリ追記。**`archive/index.html` は編集しない**）。**Claude は git 操作を一切しない**（ファイル生成のみ）。prompt 頼みでなく `--disallowedTools` で git 書き込み系をツール層から物理的に拒否している（tech-news-daily で 2026-07-16/17 に prompt のみのガードが突破された教訓）。workflow / prompt を変更する際もこのガードを外さないこと
2. **アーカイブ一覧の再生成 (workflow step)**: `scripts/build_archive.py` が `data/articles.json`（記事メタデータの一次ソース）から `archive/index.html` を決定的に再生成する。スキーマ違反（未知カテゴリ・難易度・file 命名・重複・実ファイル不在・壊れ JSON）はここで run を fail させる（LLM プロンプトの規則リークをコード側のハード制約で受け止める設計）
3. **反映 (workflow step)**: 生成物（`index.html` / `archive/` / `data/` / `feed.xml` / `topics.md`）に変更があり、`index.html` に当日日付が含まれることを検証してから `github-actions[bot]` 名義で `YYYY-MM-DD の基礎解説: {タイトル}` として main へ commit/push する。変更ゼロ・日付不整合は run を fail させる（失敗が必ず可視化される）
4. **デプロイ**: `GITHUB_TOKEN` push は他 workflow を発火させないため、同 workflow が wrangler による Cloudflare Pages への deploy を自前実行する（`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` repo secrets を使用）

認証は repo secret `CLAUDE_CODE_OAUTH_TOKEN`（Pro/Max サブスクの OAuth トークン、ローカルで `claude setup-token` を実行して生成・失効時も同コマンドで再発行）。PAT は不要。

稼働確認: `gh run list --workflow=daily-article.yml`。失敗時は `gh run view <id> --log-failed`。手動リトライは `gh workflow run daily-article.yml`。

日付は全て **JST 基準**（`TZ=Asia/Tokyo date`）。cron 発火時点（21:23 UTC）では UTC 日付がまだ前日のため、`date -u` を使うと前日記事と衝突する。prompt / workflow の日付処理を変更する際は必ず JST を維持する。

**同日おかわり run**: `gh workflow run daily-article.yml` を同日に再実行すると、置換ではなく追加の 1 本が生成される（次のキュートピックを消化、アーカイブは `YYYY-MM-DD-2.html` 連番、feed・一覧にも追加）。「今日はもっと読みたい」時はこれを叩くだけでよい（スマホの GitHub アプリの Run workflow でも可）。

## topics.md（ネタ帳キュー）の運用

- `## キュー` の先頭 1 行を毎朝の run が消化し、`## 消化済み` に日付付きで移す。キューが空なら Claude がカリキュラム領域と過去アーカイブから自走選定する
- どのセッション・どのマシンからでも、ユーザーが「これ分かってないな」と口にした技術系トピック（インフラに限らず言語・ブラウザ・AI・ツール内部など全般）があれば、このリポジトリの `topics.md` のキュー末尾に追記して push してよい（1 行 1 トピック、`（知りたい観点: ...）` を添える）
- キューの並び順が配信順。優先したいトピックは先頭に移動する

## HTML 構造と生成 prompt の同期

`index.html` の記事構造・CSS クラス（meta-bar, tldr, body-section, diagram, analogy, practical, hands-on, misconceptions, glossary, further-reading 等）を変更した場合、生成 prompt `prompts/daily-article.md` も**同一コミットで**必ず更新する。prompt はテンプレートとして記事構造を前提に毎日生成するため、HTML 構造と prompt が乖離すると生成結果が壊れる。`style.css` に新クラスを足したら prompt の構造定義にも追記する。

`archive/index.html` は例外で、**手編集禁止のビルド成果物**。一覧の構造・検索 UI を変えたい時は `scripts/build_archive.py` のテンプレート部を変更して `python3 scripts/build_archive.py` で再生成する。記事メタデータ（タイトル・サマリ・カテゴリ・難易度・用語）の修正は `data/articles.json` を直して再生成する。カテゴリを増やす時は prompt の Category Tags・`style.css` の `tag-*`・`build_archive.py` の `CATEGORIES` を同一コミットで揃える。

## サイトアセット変更は push まで完了させる

`index.html` / `style.css` / `feed.xml` / `prompts/` / `data/` / `scripts/` を変更したら、同セッション内で必ず commit → push まで完了させる。日次 workflow は毎朝 origin/main を前提に生成・push するため、ローカル未 push の変更は公開サイトに反映されないだけでなく、日次 push とローカルが分岐する。

手動 push でのサイト反映は `.github/workflows/deploy-site.yml`（push トリガー、サイトアセットのパスフィルタ付き）が担う。日次 run の `GITHUB_TOKEN` push はこの workflow を発火させないため二重デプロイにはならない（日次 run は自前で Cloudflare Pages に反映する）。

## archive/ の整合性

- 当日分は生成時（prompt の Step 10）に `archive/YYYY-MM-DD.html` も同時作成されるため、アーカイブリンクは公開直後から解決する（2026-07-18 以前は翌日 run でのアーカイブ化だったため当日 404 が仕様だった）
- 翌日 run の「昨日分をアーカイブ」ステップ（Step 4）はフォールバック。前日 run が途中失敗した場合のみ実ファイルを補完する
- 一覧リンクと実ファイルがズレた場合、git コミット履歴が一次ソース（`git show <commit>:index.html` で各日の記事を復元できる）
- アーカイブ一覧・検索は `data/articles.json` が一次ソース。deploy-site.yml は deploy 直前にも `build_archive.py` を実行するため、公開される一覧は常に JSON と一致する

## コミット前セルフチェック（手動更新時）

- 記事の全 `<a href>` が具体ページへの直リンク（トップページ・docs ルート禁止）
- 本文中の数値・バージョン・デフォルト値に出典がある（発明しない）
- feed.xml の最新 `<entry>` の日付・タイトルが index.html と整合
- topics.md のキューから当日トピックが消え、消化済みに移っている
- `data/articles.json` に当日エントリがあり、`python3 scripts/build_archive.py` が exit 0（アーカイブ一覧も再生成される）
