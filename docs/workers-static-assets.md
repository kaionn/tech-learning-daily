# Workers Static Assets への移行経路

## 対象範囲

この文書は、https://tech-learn.kaion-lab.com/ の配信先を Cloudflare Pages から Workers Static Assets へ切り替えるための手順を定める。
本番は、別途承認された cutover まで Pages のままである。
記事生成の schedule、Claude の model、生成 prompt は変更しない。

## デプロイ先の選択

repo variable `SITE_DEPLOY_TARGET` が配信先を選ぶ。

| 値 | 動作 |
| --- | --- |
| 未設定、空、`pages` | 既存の Pages project `tech-learning-daily` へ deploy する |
| `workers` | assets だけの Worker `tech-learning-daily-site` へ deploy する |
| その他 | スクリプトが fetch や upload をする前に失敗する（workflow の checkout は済んでいる）。別の host へは fallback しない |

`daily-article.yml` と `deploy-site.yml` は、どちらも `deploy-current-site.yml` を呼ぶ。
呼び出し先の job は `site-deploy` lock を取ってから checkout し、`scripts/deploy-current-site.sh` を実行する。

このスクリプトは次の順で動く。

1. `origin/main` を fetch し、その SHA を一時ディレクトリへ archive する。呼び出し元の HEAD は使わないので、遅れて終わった run が新しい記事を巻き戻すことはない。
2. archive の中で `build_archive.py` と `build_recent.py` を実行する。手動 push が再生成を忘れていても、公開される一覧は `data/articles.json` と一致する。
3. 選択された host へ upload する。upload の失敗は job の失敗になり、もう一方の host へは切り替えない。

`site-deploy` は `cancel-in-progress: false` なので、実行中の deploy は取り消されない。
GitHub の concurrency は待機中の job を 1 つしか保持せず、古い待機 job は取り消される。
どの job も実行時点の最新 main を deploy するため、残った job が取り消された分の内容も公開する。

`GITHUB_TOKEN` の push は他の workflow を発火させないので、日次 run と `deploy-site.yml` の二重 deploy は起きない。
日次 run の deploy job は、main への push に成功した場合だけ動く。

## Worker の公開物

`scripts/stage-static-assets.mjs SOURCE OUTPUT` が、次の allowlist だけを `OUTPUT` へコピーする。

- ルート直下：`index.html`、`style.css`、`feed.xml`、`favicon.ico`、`icon-192.png`、`apple-touch-icon.png`
- `archive/` 以下：拡張子が `.html` のファイル
- `data/` 以下：拡張子が `.json` のファイル

ドットで始まる名前は `archive/` と `data/` の走査で読み飛ばす。
次の場合は失敗し、`OUTPUT` を作らない。

- シンボリックリンクまたは通常ファイル以外が公開対象にある
- 必須ファイルまたは公開ディレクトリが無い
- `SOURCE` と `OUTPUT` が重なっている
- 1 ファイルが 25MiB を超える
- 公開ファイルが 20,000 個を超える

既に存在する `OUTPUT` も失敗する。
新しい種類の公開ファイルを足すときは、このスクリプトの allowlist と `scripts/verify-site.mjs` の見本を同時に更新する。

`wrangler.jsonc` は assets だけの設定で、script、binding、route、cron を持たない。
本番の Worker もプレビューも、upload の前に `scripts/workers-config.mjs` がこの形を検査する。未知の key、名前、`workers_dev`、`preview_urls`、`assets` のどれかが変わっていれば失敗する。
そのため main への commit で `assets.directory` を snapshot 全体へ向けても、内部ファイルは公開されない。
`workers_dev` と `preview_urls` は `false` である。
`./public` は deploy 時の一時ディレクトリにだけ作られる。

Pages への deploy は今までどおり tree 全体を upload する。
Pages の deploy は `wrangler.jsonc` の無い一時ディレクトリから実行する。
wrangler は実行ディレクトリから設定を探すので、ここでリポジトリの `wrangler.jsonc` を Pages 設定として読ませないようにしている。

## URL の互換性

Worker は `html_handling: auto-trailing-slash` で配信する。
Atom の ID、記事の path、公開 JSON の path は変わらない。
cutover 後も同じカスタムドメインを使うので、購読とリンクは維持される。

2026-11-03 に本番の Pages を curl で計測した結果と、`wrangler dev --local`（wrangler 4.156.2）で計測した結果は次のとおりである。
本番の Worker での値は未確認である。

| リクエスト | 本番の Pages | ローカルの Worker |
| --- | --- | --- |
| `/archive/2026-11-02.html` | 308 で `/archive/2026-11-02` へ転送 | 307 で `/archive/2026-11-02` へ転送 |
| `/archive/2026-11-02` | 200 | 200 |
| `/__migration_missing__` | 200（ルートの HTML） | 404 |
| `/wrangler.jsonc` | 200（ルートの HTML） | 404 |
| `/scripts/build_archive.py` | 200（ファイル本体） | 404 |

下の 3 行は意図した変更である。
存在しない path は 404 になり、内部ファイルは公開されなくなる。
`not_found_handling: none` なので、SPA 形式の fallback はしない。

`.html` の転送は、恒久（308）から一時（307）へ変わる可能性がある。
転送先は同じなので読者には見えないが、検索エンジンの扱いが変わる可能性はあり、影響は未確認である。
`verify-site.mjs` は転送先の URL だけを見るので、どちらのステータスでも通る。

## ローカルプレビュー

認証情報は要らない。
`assets.directory` がリポジトリ直下を指さないように、一時ディレクトリへ staging してから起動する。

```sh
tmp=$(mktemp -d)
mkdir "$tmp/snapshot"
git archive origin/main | tar -x -C "$tmp/snapshot"
export PYTHONDONTWRITEBYTECODE=1
python3 "$tmp/snapshot/scripts/build_archive.py"
python3 "$tmp/snapshot/scripts/build_recent.py"
node "$tmp/snapshot/scripts/stage-static-assets.mjs" "$tmp/snapshot" "$tmp/public"
cp "$tmp/snapshot/wrangler.jsonc" "$tmp/wrangler.jsonc"
npx --yes wrangler@4 dev --local --config "$tmp/wrangler.jsonc" --port 8799
```

別の端末で、同じ `tmp` の値を設定して次を実行する。

```sh
node "$tmp/snapshot/scripts/verify-site.mjs" "$tmp/snapshot" http://127.0.0.1:8799
```

upload 前の設定確認には dry-run を使う。

```sh
npx --yes wrangler@4 deploy --dry-run --config "$tmp/wrangler.jsonc"
```

## クラウドプレビュー

クラウドプレビューは upload を伴うので、ローカルプレビューとは別の承認を取ってから実行する。

```sh
gh workflow run deploy-workers-preview.yml --ref main
```

この workflow は手動専用かつ main 専用で、`workers-preview-deploy` という別の lock を使う。
入力は持たず、`SITE_DEPLOY_TARGET` を読まず、カスタムドメインも付けない。
latest main の snapshot を、固定の Worker `tech-learning-daily-site-preview` へ `workers_dev: true` で deploy する。
snapshot の `wrangler.jsonc` が assets だけの形から外れていれば（未知の key、script、route、cron、binding、assets の変更）、upload の前に失敗する。

CI の token が Workers に対する権限を持つかは未確認である。
tech-news-daily では同種の手順で `No access to the specified service` が発生した。
権限エラーになったら、そこで止める。
token の権限を広げること、新しい認証情報を作ること、Pages へ fallback することは、この検証の範囲に含まれない。

## 本番の検証

`scripts/verify-site.mjs` は認証なしの GET だけを行う読み取り専用の検査である。
9 個の公開見本について最終 URL、media type、バイト列を比較し、12 個の内部 path または存在しない path が 404 を返すことを確かめる。
リダイレクトは同一オリジンへ 3 回まで許可する。
HTTP は loopback に限って許可する。

この検査は再生成をしない。
渡すスナップショットは、deploy と同じく再生成を済ませた状態でなければならない。
再生成を検査側に持たせると、検査対象のはずのコードを検査が実行してしまい、読み取り専用でもなくなるからである。
リポジトリには再生成済みの出力がコミットされており、391d36a では再生成しても差分が出なかった。
そのため通常は archive のままでも一致するが、手動 push が再生成を忘れた場合に備えて、手順としては毎回再生成する。

```sh
snapshot=$(mktemp -d)
git archive <deploy した SHA> | tar -x -C "$snapshot"
export PYTHONDONTWRITEBYTECODE=1
python3 "$snapshot/scripts/build_archive.py"
python3 "$snapshot/scripts/build_recent.py"
node scripts/verify-site.mjs "$snapshot" https://tech-learn.kaion-lab.com
rm -rf "$snapshot"
```

exit 0 が示すのは見本の応答だけであり、すべての過去 URL、Cloudflare の設定、日次 run の健全性までは示さない。
cutover 前の本番（Pages）に対してこの検査を実行すると、内部 path が 200 を返すので失敗する。

## cutover の手順

cutover は、本番の host を動かす別の承認を取ってから行う。
変数の切り替えだけでは hostname は移らない。
hostname を配信しているのは Pages のカスタムドメインであり、変数が決めるのは upload 先だけである。

1. クラウドプレビューを通し、CI の token で upload できることと、URL と本文が期待どおりであることを確かめる。
2. 日次 run の時刻（06:23 JST）を避け、`daily-article.yml` と `deploy-site.yml` を止めて、実行中と待機中の deploy を空にする。
3. 現在の Pages の deployment、カスタムドメインの関連付け、DNS の内容を記録する。
4. 最新の main を staging し、承認された操作者が `wrangler deploy` で公開 route の無い Worker を用意する。source SHA と Worker の version を記録する。
5. Pages project から `tech-learn.kaion-lab.com` を外し、Worker のカスタムドメインに追加する。Cloudflare は既存の CNAME の上にカスタムドメインを作れないので、実際の DNS を確認してから進め、record を確認せずに消さない。
6. TLS と URL を確かめ、「本番の検証」のコマンドを実行する。
7. `SITE_DEPLOY_TARGET=workers` を設定し、止めた workflow を再開して、次の日次 run の deploy を確かめる。

Pages project、fallback のコード、`pages.dev` の hostname は残す。

## ロールバック

ロールバックは自動では行わず、次の順に手で進める。

1. deploy を止めて空にする。
2. どちらかの方法で戻す。
   - Worker の設定ではなく内容の問題なら、`wrangler rollback <version-id>` で前の version に戻す。古い記事の内容へ戻る点に注意する。
   - host ごと戻すなら、`SITE_DEPLOY_TARGET=pages` にして最新の main を Pages へ upload し、記録しておいたカスタムドメインと DNS の関連付けを Pages へ戻す。
3. 日付、本文、TLS を確かめてから deploy を再開する。

どちらの host も削除しない。

## 未確認の事項

次の事項は、この文書の作成時点で確認していない。
remote への upload の前に確認する。

- アカウントのプランと利用状況
- CI の token の権限ポリシーと、Workers への権限の有無
- Worker 名 `tech-learning-daily-site` と `tech-learning-daily-site-preview` が空いているか
- `tech-learn.kaion-lab.com` の現在の DNS record の内容

## 費用

公式の資料によれば、静的アセットへのリクエストは無料で、ストレージの追加費用も無い。
Workers Free の上限は 1 version あたり 20,000 アセット、1 ファイルあたり 25MiB であり、staging がこの上限を強制する。
このサイトは Worker script、`run_worker_first`、Durable Objects、KV、R2 を使わない。
実際の課金はアカウントの状況に依存するので、上の未確認事項に含めている。

## 公式資料

- [Pages からの移行](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/)
- [HTML routing](https://developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling/)
- [課金と制限](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)
- [Limits](https://developers.cloudflare.com/workers/platform/limits/)
- [CI の認証](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
