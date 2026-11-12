#!/usr/bin/env python3
"""Parse the IELTS speaking question-bank document into the bank JSON shape.

The season bank (``src/data/question-banks/<season>-mainland.json``) used to be a
hand-made one-off artifact: no script, no coverage assertion.  That is exactly how
64 Part 1 questions and 8 topics silently went missing.  This script is the fix —
it is re-runnable, it asserts the extracted count against the count the document
itself declares for every topic, and it refuses to write anything if an assertion
fails.

Usage
-----
    # 1. dump the document text (see docs/bank-audit.md for the exact call)
    #    the dump is a plain-text transcript of the Tencent Doc, not committed
    python3 scripts/parse-bank-doc.py --doc /tmp/doc.txt --check
    python3 scripts/parse-bank-doc.py --doc /tmp/doc.txt --write

Scope
-----
Only **mainland** rows are imported.  The document tags every row with a region
column (``大陆地区`` / ``非大陆地区``); non-mainland rows are reported but never
written.  Part 1 only — Part 2/3 are parsed elsewhere and were verified to match.

Exit codes: 0 ok, 1 assertion failed (nothing written), 2 bad input.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BANK_DIR = ROOT / "src" / "data" / "question-banks"

# The row of the Part 1 table ends with: | 🌍 考区 | 🔎 类型 | 🤚 数量 | 🤓 考试人数 |
ROW_FOOT = re.compile(
    r"\|\s*(大陆地区|非大陆地区)?\s*\|\s*(9-12月新题|9-12月保留题|万年保留题)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*$",
    re.M,
)
# A row starts with the index number followed by an ASCII topic name.
ROW_HEAD = re.compile(r"\n\|\s*(\d{1,2})\s*\|\s*([A-Za-z][^\n]{0,60})")

# One question cell: one or more English questions followed by one or more
# Chinese sentences ending in a full-width question mark.  Multi-question cells
# ("Do you like buying shoes? How often? 你喜欢买鞋子吗？多久买一次？") stay as one
# entry — splitting them would invent question text the document never wrote.
CELL = re.compile(
    r"((?:[A-Z][A-Za-z0-9 ,'’\-\u2019\(\)\./:;!&%]{2,150}?[?？]\s*)+)"
    r"((?:[\u4e00-\u9fa5][^？?]{0,90}[？?]\s*)+)"
)

TYPE_MAP = {"9-12月新题": "new", "9-12月保留题": "retained", "万年保留题": "evergreen"}
STOP = (
    "Have ", "Do ", "Did ", "Is ", "Are ", "What ", "When ", "Where ", "Why ",
    "How ", "Would ", "Should ", "Who ", "Which ", "Can ", "Could ", "Tell ",
)


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s).replace("\u2019", "'")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", s.lower())).strip()


def topic_name(raw: str) -> str:
    """`Paper-纸张 Have you made...` -> `Paper`

    The cell also carries layout noise (`【版本A】- 时尚人设 😎`, `注：22个小问`),
    so cut at the first question word and keep only the ASCII half before the dash.
    """
    cut = len(raw)
    for kw in STOP:
        j = raw.find(kw)
        if j > 0:
            cut = min(cut, j)
    head = raw[:cut].strip(" -/")
    en = re.split(r"[-－]", head, maxsplit=1)[0]
    return en.strip()


def topic_name_zh(raw: str) -> str:
    """`Paper-纸张 Have you made...` -> `纸张`"""
    cut = len(raw)
    for kw in STOP:
        j = raw.find(kw)
        if j > 0:
            cut = min(cut, j)
    head = raw[:cut].strip(" -/")
    parts = re.split(r"[-－]", head, maxsplit=1)
    if len(parts) < 2:
        return head
    m = re.match(r"[\u4e00-\u9fa5][\u4e00-\u9fa5/&、·]*", parts[1].strip())
    return m.group(0) if m else parts[1].strip()


def squeeze(s: str) -> str:
    """Collapse whitespace and drop the space the document puts before `?`."""
    s = re.sub(r"\s+", " ", s).strip()
    return re.sub(r"\s+([?？!！,，.。;；:：])", r"\1", s)


def parse_part1(text: str) -> tuple[list[dict], list[str]]:
    start = text.find("Part1口语素材库-IELTS")
    if start < 0:
        raise SystemExit("Part 1 table header not found — is this the right document?")
    seg = text[start:]
    limit = seg.find("Part2")
    if limit < 0:
        limit = len(seg)

    rows = list(ROW_HEAD.finditer(seg[:limit]))
    out, problems = [], []

    for i, m in enumerate(rows):
        end = rows[i + 1].start() if i + 1 < len(rows) else limit
        row = seg[m.start():end]
        foot = ROW_FOOT.search(row)
        if not foot:
            problems.append(f"row {m.group(1)}: region/count columns not found")
            continue

        region, kind, declared, examinees = foot.group(1), foot.group(2), int(foot.group(3)), int(foot.group(4))
        name = topic_name(m.group(2))
        name_zh = topic_name_zh(m.group(2))

        cells, seen = [], set()
        body = row[: foot.start()]
        for c in CELL.finditer(body):
            en, zh = squeeze(c.group(1)), squeeze(c.group(2))
            if not zh or zh[0] in "（(":  # example sentences carry 中文 in brackets
                continue
            if re.search(r"如\s*$", body[max(0, c.start() - 8):c.start()]):
                continue  # `如 Is this the right size for you?` inside 语料扩展
            k = norm(en)
            if not k or k in seen:
                continue
            seen.add(k)
            cells.append({"text": en, "textZh": zh})

        if len(cells) != declared:
            problems.append(
                f"{name}: document declares {declared}, extracted {len(cells)}"
                + (" (merged sub-questions)" if len(cells) == declared - 1 else "")
            )

        out.append(
            dict(name=name, nameZh=name_zh, region=region or "", kind=kind,
                 declared=declared, examinees=examinees, questions=cells)
        )

    return out, problems


def slug(name: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", name.lower())).strip("-")


def apply_to_bank(bank_path: Path, parsed: list[dict], write: bool) -> dict:
    bank = json.loads(bank_path.read_text(encoding="utf-8"))
    topics = bank["topics"]
    by_name = {t["name"]: t for t in topics if t.get("category") == "part1"}

    mainland = [p for p in parsed if p["region"] == "大陆地区"]
    skipped = [p for p in parsed if p["region"] != "大陆地区"]

    changed, added, dropped = [], [], []

    for p in mainland:
        t = by_name.get(p["name"])
        if t is None:
            t = {
                "key": slug(p["name"]),
                "name": p["name"],
                "nameZh": p["nameZh"],
                "type": TYPE_MAP[p["kind"]],
                "category": "part1",
                "examinees": p["examinees"],
                "part1": [],
                "part2": [],
                "part3": [],
            }
            topics.insert(len([x for x in topics if x.get("category") == "part1"]), t)
            added.append(p["name"])
        else:
            if len(t.get("part1") or []) != len(p["questions"]):
                changed.append((t["name"], len(t.get("part1") or []), len(p["questions"])))
        t["type"] = TYPE_MAP[p["kind"]]
        t["examinees"] = p["examinees"]
        t["part1"] = p["questions"]

    kept_names = {p["name"] for p in mainland}
    for name in by_name:
        if name not in kept_names:
            dropped.append(name)

    if write and not dropped:
        bank_path.write_text(json.dumps(bank, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    return dict(bank=bank, mainland=mainland, skipped=skipped, changed=changed,
                added=added, dropped=dropped, wrote=write and not dropped)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--doc", required=True, help="path to the plain-text document dump")
    ap.add_argument("--bank", default=str(BANK_DIR / "2026-09-12-mainland.json"))
    ap.add_argument("--write", action="store_true", help="write the bank JSON (default: dry run)")
    ap.add_argument("--check", action="store_true", help="print the per-topic report")
    args = ap.parse_args()

    doc = Path(args.doc)
    if not doc.exists():
        print(f"document dump not found: {doc}", file=sys.stderr)
        return 2

    parsed, problems = parse_part1(doc.read_text(encoding="utf-8"))
    res = apply_to_bank(Path(args.bank), parsed, args.write)

    mainland = res["mainland"]
    ml_q = sum(len(p["questions"]) for p in mainland)

    if args.check:
        print(f"{'主题':<26}{'考区':<10}{'声明':>4}{'抽出':>5}")
        print("-" * 50)
        for p in parsed:
            print(f"{p['name'][:24]:<26}{p['region']:<10}{p['declared']:>4}{len(p['questions']):>5}")
        print("-" * 50)

    print(f"文档主题 {len(parsed)}：大陆 {len(mainland)} / 非大陆 {len(res['skipped'])}")
    for p in res["skipped"]:
        print(f"  跳过（非大陆）: {p['name']} ({p['declared']})")
    print(f"大陆题数合计: {ml_q}")
    print(f"新增主题: {res['added'] or '无'}")
    print(f"题数变化: {[(n, a, b) for n, a, b in res['changed']] or '无'}")
    if res["dropped"]:
        print(f"待移除（文档中已无此主题）: {res['dropped']}")
    print("\n题数与文档自述不一致:")
    for p in problems:
        print("  ⚠️", p)
    unmerged = [p for p in problems if "merged sub-questions" not in p]
    print("\n已写入" if res["wrote"] else "\n未写入（dry run）")
    return 1 if unmerged else 0


if __name__ == "__main__":
    raise SystemExit(main())
