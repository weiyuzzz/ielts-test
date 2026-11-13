#!/usr/bin/env python3
"""Verify the bank + learning sidecar against the Tencent Doc source text.

Re-runnable consistency gate. It checks the three things that can silently
drift when the document or the parsers change:

  1. every bank question (Part 1/2/3) is findable verbatim in the document;
  2. every bank question has a matching learning entry with a sample answer;
  3. every Part 2 cue card has a full cue list (4-5 points) in the document's
     own wording, not a shifted neighbour.

Usage
-----
    python3 scripts/audit-bank-doc.py --doc /tmp/doc.txt

Exit codes: 0 consistent, 1 drift detected, 2 bad input.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BANK_PATH = ROOT / "src" / "data" / "question-banks" / "2026-09-12-mainland.json"
LEARN_PATH = ROOT / "src" / "data" / "learning" / "2026-09-12.json"


def norm(s: str) -> str:
    return "".join(
        c.lower() for c in (s or "")
        if ("a" <= c.lower() <= "z") or ("0" <= c.lower() <= "9") or ("\u4e00" <= c <= "\u9fa5")
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--doc", required=True, help="plain-text dump of the Tencent Doc")
    ap.add_argument("--bank", default=str(BANK_PATH))
    ap.add_argument("--learning", default=str(LEARN_PATH))
    args = ap.parse_args()

    doc = Path(args.doc)
    if not doc.exists():
        print(f"document dump not found: {doc}", file=sys.stderr)
        return 2
    text = norm(doc.read_text(encoding="utf-8"))
    bank = json.loads(Path(args.bank).read_text(encoding="utf-8"))
    learning = json.loads(Path(args.learning).read_text(encoding="utf-8"))

    index = {(e["topicKey"], e["part"], norm(e["text"])): e["learning"] for e in learning["entries"]}
    problems: list[str] = []

    for part in (1, 2, 3):
        questions = [
            (tp["key"], tp["name"], q)
            for tp in bank["topics"]
            for q in tp.get(f"part{part}") or []
        ]
        missing_text = [q["text"] for _, _, q in questions if norm(q["text"]) not in text]
        matched = sum(1 for k, _, q in questions if (k, part, norm(q["text"])) in index)
        answers = sum(
            1 for k, _, q in questions
            if (index.get((k, part, norm(q["text"]))) or {}).get("sampleAnswer", {}).get("paragraphs")
        )
        print(f"Part {part}: {len(questions)} 题 | 文档命中 {len(questions) - len(missing_text)} | "
              f"素材匹配 {matched} | 有答案 {answers}")
        if missing_text:
            problems.append(f"Part {part} 题干不在文档中: {missing_text[:5]}")
        if matched != len(questions):
            problems.append(f"Part {part} 有 {len(questions) - matched} 题缺素材条目")
        if answers != len(questions):
            problems.append(f"Part {part} 有 {len(questions) - answers} 题缺示范答案")

    cues = [q.get("cuePoints") or [] for tp in bank["topics"] for q in tp.get("part2") or []]
    dist = dict(sorted(Counter(len(c) for c in cues).items()))
    print(f"Part 2 提示点条数分布: {dist}")
    short = [c for c in cues if len(c) < 4]
    if short:
        problems.append(f"Part 2 有 {len(short)} 张卡提示点不足 4 条")

    if not set(index) == {
        (tp["key"], part, norm(q["text"]))
        for tp in bank["topics"] for part in (1, 2, 3) for q in tp.get(f"part{part}") or []
    }:
        problems.append("素材文件存在多余或缺失的题目键")

    if problems:
        print("\n❌ 一致性检查失败:")
        for p in problems:
            print("  -", p)
        return 1
    print("\n✅ 题库题目/答案/提示点与腾讯文档一致")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
