#!/usr/bin/env python3
"""data/articles.json から index.html の「最近の記事」セクションを再生成する。

- カテゴリ表示名・難易度絵文字・バリデーション/ソート済み記事リストは
  build_archive.py の定義を再利用する（重複させると定義がズレるため）
- 先頭 1 件（トップページに表示中の当日記事）をスキップし、続く最大 4 件を表示する
- `<!-- recent:start -->` / `<!-- recent:end -->` の間だけを置換する
- マーカーが無い場合は `<footer>` の直前にマーカー付きで自己修復挿入する
"""

import html
import sys
from pathlib import Path

from build_archive import CATEGORIES, DIFFICULTIES, load_and_validate

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "index.html"
START = "    <!-- recent:start -->"
END = "    <!-- recent:end -->"
FOOTER_ANCHOR = "    <footer>"
MAX_CARDS = 4


def fail(msg: str) -> None:
    print(f"::error::{msg}", file=sys.stderr)
    sys.exit(1)


def esc(s: str) -> str:
    return html.escape(s, quote=True)


def render_card(a: dict) -> str:
    cat_label = CATEGORIES[a["category"]]
    diff_label = DIFFICULTIES[a["difficulty"]]
    return f"""      <div class="card">
        <h3><a href="archive/{esc(a['file'])}">{esc(a['title'])}</a></h3>
        <div class="summary">{esc(a['summary'])}</div>
        <div class="meta"><span class="tag tag-{esc(a['category'])}">{esc(cat_label)}</span><span>{esc(diff_label)}</span><span>⏱ 約 {a['readTime']} 分</span><span>{esc(a['date'])}</span></div>
      </div>"""


def render_section(recent: list[dict]) -> str:
    if not recent:
        return ""
    cards = "\n".join(render_card(a) for a in recent)
    return f"""    <section class="section recent-articles">
      <div class="section-title">最近の記事</div>
{cards}
      <div class="recent-more"><a href="archive/">アーカイブですべて見る →</a></div>
    </section>
"""


def apply_markers(text: str, body: str) -> str:
    if START in text and END in text:
        pre, rest = text.split(START, 1)
        _, post = rest.split(END, 1)
        return f"{pre}{START}\n{body}{END}{post}"

    if FOOTER_ANCHOR not in text:
        fail("recent マーカーも <footer> も見つからない。挿入先が無い")
    insertion = f"{START}\n{body}{END}\n\n{FOOTER_ANCHOR}"
    return text.replace(FOOTER_ANCHOR, insertion, 1)


def main() -> None:
    articles = load_and_validate()
    recent = articles[1 : 1 + MAX_CARDS]
    body = render_section(recent)

    text = INDEX.read_text(encoding="utf-8")
    new_text = apply_markers(text, body)
    INDEX.write_text(new_text, encoding="utf-8")
    print(f"OK: index.html の最近の記事セクションを再生成（{len(recent)} 件）")


if __name__ == "__main__":
    main()
