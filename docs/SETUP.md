## 背景

tech-learning-daily（AI が毎朝届けるソフトウェア技術の基礎解説サイト）の初期構築は完了し、main に push 済み。ただし GitHub 側の設定 2 点が App トークン権限の都合でできておらず、日次 workflow がまだ動かない。この Issue はその残作業の実行手順書。別 PC の Claude Code セッションで本 Issue を読み込んで実行する想定。

構成の全体像はリポジトリの `CLAUDE.md` を参照（tech-news-daily と同型: claude-code-action が生成 → workflow が commit/push → Pages デプロイ）。

## 残作業

### 1. GitHub Pages を有効化する

https://github.com/kaionn/tech-learning-daily/settings/pages で Build and deployment の Source を「GitHub Actions」にする。

CLI でやる場合（管理権限のあるトークンが必要。`Resource not accessible by integration` が出たら web UI で）:

```bash
gh api -X POST repos/kaionn/tech-learning-daily/pages -f build_type=workflow
```

### 2. repo secret `CLAUDE_CODE_OAUTH_TOKEN` を登録する

ローカルで OAuth トークン（Pro/Max サブスク）を発行し、repo secret に登録する:

```bash
claude setup-token   # 表示された sk-ant-oat01-... をコピー
gh secret set CLAUDE_CODE_OAUTH_TOKEN -R kaionn/tech-learning-daily   # プロンプトに貼り付け
```

CLI が 403 の場合は https://github.com/kaionn/tech-learning-daily/settings/secrets/actions/new で Name: `CLAUDE_CODE_OAUTH_TOKEN` として登録。

### 3. 初回 run を発火して通しで検証する

```bash
gh workflow run daily-article.yml -R kaionn/tech-learning-daily
gh run list --workflow=daily-article.yml -R kaionn/tech-learning-daily
```

（CLI が 403 なら Actions タブ → Daily article (generate & deploy) → Run workflow）

### 4. 検証チェックリスト

- [ ] run が全 step green（生成 → commit → Pages デプロイ）
- [ ] main に `YYYY-MM-DD の基礎解説: {タイトル}` コミットが github-actions[bot] 名義で乗っている
- [ ] https://tech-learn.kaion-lab.com/ に第 1 号（キュー先頭「Kubernetes の全体像」のはず）が表示される
- [ ] 記事構造が揃っている: 3 行まとめ / ASCII 図解 / たとえるなら / 実務でどう出会うか / 手を動かす / よくある誤解 / 用語ミニ辞典 / もっと深く（全リンクが個別ページ直リンク）
- [ ] `topics.md` のキュー先頭が消え `## 消化済み` に移っている
- [ ] `feed.xml` が well-formed（`python3 -c "import xml.dom.minidom;xml.dom.minidom.parse('feed.xml')"`）

### 失敗時

`gh run view <id> --log-failed -R kaionn/tech-learning-daily`。トラブルシューティングの前提知識は `CLAUDE.md` の「デプロイパイプライン」節にまとまっている。完了したらこの Issue を close する。
