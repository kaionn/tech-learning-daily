#!/usr/bin/env python3
"""data/articles.json（記事メタデータの一次ソース）から archive/index.html を再生成する。

- 日次 workflow が Claude の生成ステップ後に実行する（LLM は archive/index.html を編集しない）
- バリデーション失敗は exit 1 で run を落とす（サイレントな腐敗より loud fail）
- 依存: Python 3 stdlib のみ
"""

import html
import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "articles.json"
OUT = ROOT / "archive" / "index.html"

CATEGORIES = {
    "container": "Container",
    "infra": "Infra",
    "db": "DB",
    "network": "Network",
    "security": "Security",
    "arch": "Arch",
    "perf": "Perf",
    "obs": "Obs",
    "lang": "Lang",
    "frontend": "Frontend",
    "ai": "AI",
    "dev": "Dev",
}
DIFFICULTIES = {"入門": "🌱 入門", "基礎": "🌿 基礎", "応用": "🌳 応用"}
FILE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.html$")
VISIBLE_CHIPS = 8  # カテゴリチップをこの数まで表示し、残りは「もっと見る」に畳む


def fail(msg: str) -> None:
    print(f"::error::articles.json validation failed: {msg}", file=sys.stderr)
    sys.exit(1)


def load_and_validate() -> list[dict]:
    try:
        articles = json.loads(DATA.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        fail(f"JSON が読めない: {e}")
    if not isinstance(articles, list) or not articles:
        fail("トップレベルは 1 件以上の配列であること")

    seen_files: set[str] = set()
    for i, a in enumerate(articles):
        ctx = f"entry[{i}]"
        if not isinstance(a, dict):
            fail(f"{ctx}: オブジェクトではない")
        for key in ("file", "date", "title", "summary", "category", "difficulty", "readTime", "terms"):
            if key not in a:
                fail(f"{ctx}: フィールド {key} が無い")
        m = FILE_RE.match(a["file"])
        if not m:
            fail(f"{ctx}: file 形式が不正: {a['file']}")
        if m.group(1) != a["date"]:
            fail(f"{ctx}: date ({a['date']}) と file ({a['file']}) の日付が不一致")
        if a["file"] in seen_files:
            fail(f"{ctx}: file 重複: {a['file']}")
        seen_files.add(a["file"])
        if not (ROOT / "archive" / a["file"]).is_file():
            fail(f"{ctx}: archive/{a['file']} が存在しない（リンクが 404 になる）")
        if a["category"] not in CATEGORIES:
            fail(f"{ctx}: 未知のカテゴリ: {a['category']}（許可: {', '.join(CATEGORIES)}）")
        if a["difficulty"] not in DIFFICULTIES:
            fail(f"{ctx}: 未知の難易度: {a['difficulty']}（許可: {', '.join(DIFFICULTIES)}）")
        if not isinstance(a["readTime"], int) or a["readTime"] <= 0:
            fail(f"{ctx}: readTime は正の整数であること")
        if not isinstance(a["terms"], list) or not all(isinstance(t, str) and t for t in a["terms"]):
            fail(f"{ctx}: terms は文字列の配列であること")
        for key in ("title", "summary"):
            if not isinstance(a[key], str) or not a[key].strip():
                fail(f"{ctx}: {key} が空")

    def sort_key(a: dict):
        m = FILE_RE.match(a["file"])
        return (a["date"], int(m.group(2) or 1))

    return sorted(articles, key=sort_key, reverse=True)


def esc(s: str) -> str:
    return html.escape(s, quote=True)


def render_card(a: dict) -> str:
    cat_label = CATEGORIES[a["category"]]
    diff_label = DIFFICULTIES[a["difficulty"]]
    terms_display = " / ".join(a["terms"])
    search_text = f"{a['title']} {a['summary']}".lower()
    return f"""      <div class="card" data-cat="{esc(a['category'])}" data-diff="{esc(a['difficulty'])}"
           data-search="{esc(search_text)}" data-terms="{esc(terms_display)}">
        <h3><a href="{esc(a['file'])}">{esc(a['title'])}</a></h3>
        <div class="summary">{esc(a['summary'])}</div>
        <div class="term-hit"></div>
        <div class="meta"><span class="tag tag-{esc(a['category'])}">{esc(cat_label)}</span><span>{esc(diff_label)}</span><span>⏱ 約 {a['readTime']} 分</span><span>{esc(a['date'])}</span></div>
      </div>"""


def render_cat_chips(articles: list[dict]) -> str:
    counts = Counter(a["category"] for a in articles)
    ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    chips = ['        <button class="chip on" data-cat="">すべて</button>']
    for idx, (cat, n) in enumerate(ordered):
        hidden = ' data-overflow="1" hidden' if idx >= VISIBLE_CHIPS else ""
        chips.append(
            f'        <button class="chip" data-cat="{esc(cat)}"{hidden}>{esc(CATEGORIES[cat])} <span class="chip-count">{n}</span></button>'
        )
    if len(ordered) > VISIBLE_CHIPS:
        rest = len(ordered) - VISIBLE_CHIPS
        chips.append(f'        <button class="chip chip-more" id="chip-more">+ {rest} 件</button>')
    return "\n".join(chips)


def render_months(articles: list[dict]) -> str:
    months: dict[str, list[dict]] = {}
    for a in articles:
        months.setdefault(a["date"][:7], []).append(a)
    parts = []
    for ym in sorted(months, reverse=True):
        y, m = ym.split("-")
        cards = "\n".join(render_card(a) for a in months[ym])
        parts.append(f"""    <section class="section month" data-month="{ym}">
      <div class="section-title">{y} 年 {int(m)} 月 <span class="count"></span></div>
{cards}
    </section>""")
    return "\n\n".join(parts)


SCRIPT = """  <script>
    (function () {
      var searchEl = document.getElementById('search');
      var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
      var months = Array.prototype.slice.call(document.querySelectorAll('.month'));
      var info = document.getElementById('result-info');
      var empty = document.getElementById('empty');
      var cat = '';
      var diff = '';

      var more = document.getElementById('chip-more');
      if (more) {
        more.addEventListener('click', function () {
          document.querySelectorAll('[data-overflow]').forEach(function (c) { c.hidden = false; });
          more.remove();
        });
      }

      function setupChips(rowId, attr, onChange) {
        var row = document.getElementById(rowId);
        row.addEventListener('click', function (e) {
          var btn = e.target.closest('.chip');
          if (!btn || btn.id === 'chip-more') return;
          row.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('on'); });
          btn.classList.add('on');
          onChange(btn.getAttribute(attr) || '');
          apply();
        });
      }
      setupChips('cat-chips', 'data-cat', function (v) { cat = v; });
      setupChips('diff-chips', 'data-diff', function (v) { diff = v; });

      function apply() {
        var q = searchEl.value.trim().toLowerCase();
        var visible = 0;

        cards.forEach(function (card) {
          var okCat = !cat || card.getAttribute('data-cat') === cat;
          var okDiff = !diff || card.getAttribute('data-diff') === diff;
          var okQ = true;
          var termHitText = '';

          if (q) {
            var inBody = card.getAttribute('data-search').indexOf(q) !== -1;
            var terms = card.getAttribute('data-terms') || '';
            var inTerms = terms.toLowerCase().indexOf(q) !== -1;
            okQ = inBody || inTerms;
            if (okQ && inTerms) termHitText = '📖 用語ミニ辞典: ' + terms;
          }

          var show = okCat && okDiff && okQ;
          card.style.display = show ? '' : 'none';
          var hitEl = card.querySelector('.term-hit');
          hitEl.textContent = termHitText;
          hitEl.classList.toggle('show', !!termHitText);
          if (show) visible++;
        });

        months.forEach(function (m) {
          var count = 0;
          m.querySelectorAll('.card').forEach(function (c) { if (c.style.display !== 'none') count++; });
          m.style.display = count ? '' : 'none';
          m.querySelector('.count').textContent = '— ' + count + ' 本';
        });

        empty.classList.toggle('show', visible === 0);
        info.textContent = (q || cat || diff)
          ? visible + ' 本がヒット（全 ' + cards.length + ' 本）'
          : '全 ' + cards.length + ' 本';
      }

      searchEl.addEventListener('input', apply);
      apply();
    })();
  </script>"""


def main() -> None:
    articles = load_and_validate()
    page = f"""<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tech Learning Daily — アーカイブ</title>
  <meta name="description" content="Tech Learning Daily の全記事アーカイブ。カテゴリ・難易度・キーワードで検索できる。">
  <link rel="stylesheet" href="../style.css">
  <link rel="alternate" type="application/atom+xml" title="Tech Learning Daily" href="../feed.xml">
</head>
<body>
  <div class="container">
    <header class="with-nav">
      <h1><a href="../">Tech Learning Daily</a></h1>
      <div class="tagline">AI が毎朝届ける、ソフトウェア技術の基礎解説</div>
    </header>

    <nav class="site-nav">
      <a href="../">最新号</a>
      <a href="./" class="active">アーカイブ</a>
      <a href="../feed.xml">RSS</a>
    </nav>

    <div class="toolbar">
      <div class="search-wrap">
        <span class="icon">🔍</span>
        <input id="search" type="search" placeholder="タイトル・サマリ・用語で検索" autocomplete="off">
      </div>
      <div class="chip-row" id="cat-chips">
        <span class="row-label">カテゴリ</span>
{render_cat_chips(articles)}
      </div>
      <div class="chip-row" id="diff-chips">
        <span class="row-label">難易度</span>
        <button class="chip on" data-diff="">すべて</button>
        <button class="chip" data-diff="入門">🌱 入門</button>
        <button class="chip" data-diff="基礎">🌿 基礎</button>
        <button class="chip" data-diff="応用">🌳 応用</button>
      </div>
      <div class="result-info" id="result-info"></div>
    </div>

{render_months(articles)}

    <div class="empty" id="empty">該当する記事がない。検索語を短くするか、フィルタを外してみて。</div>

    <footer>
      <p>Generated by Claude Code (GitHub Actions)</p>
      <a href="../" class="archive-link">最新号へ戻る</a>
    </footer>
  </div>

{SCRIPT}
</body>
</html>
"""
    OUT.write_text(page, encoding="utf-8")
    print(f"OK: {OUT.relative_to(ROOT)} を再生成（{len(articles)} 記事）")


if __name__ == "__main__":
    main()
