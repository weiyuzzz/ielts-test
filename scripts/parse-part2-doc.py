#!/usr/bin/env python3
"""Rebuild Part 2 cue cards and import their answers from the Tencent Doc.

Why this exists
---------------
The bank JSON's Part 2 `cuePoints` came from a one-off scrape that shifted cells:
51 of 58 cards carry the *next* card's first cue point as a bogus 5th item, some
cards lost their first cue entirely, and 7 cards have zero or one cue point.
The learning sidecar has no Part 2 answers at all (the earlier importer skipped
them because the document's "串题故事" shares one story across several cards).

This script fixes both, using only structural anchors from the document:

  1. A card segment starts at `[<season tag>]Describe ...` and ends at the next
     card marker or the next `🤓 英文回答`. Cue points are the English halves of
     the `English cue + Chinese gloss` pairs after `You should say:`.
  2. Consecutive card segments form a story group (gap < 1200 chars). Every
     group is followed within ~300 chars by exactly one `🤓 英文回答` block.
  3. An answer block optionally starts with per-card opening sentences
     (`中文卡名：English opener.`) and a matching Chinese block, then the shared
     story body. A card gets its own opener ONLY when its Chinese name matches
     exactly one label; otherwise it gets the shared body alone — never another
     card's opener. Everything is flagged as a shared story in `variantLabel`.
  4. Bank questions are the authority: this script never adds, renames or drops
     a question. It only fills `cuePoints` and the `learning` sidecar.

Usage
-----
    python3 scripts/parse-part2-doc.py --doc /tmp/doc.txt --check
    python3 scripts/parse-part2-doc.py --doc /tmp/doc.txt --write

Exit codes: 0 ok, 1 assertion failed (nothing written), 2 bad input.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BANK_PATH = ROOT / "src" / "data" / "question-banks" / "2026-09-12-mainland.json"
LEARN_PATH = ROOT / "src" / "data" / "learning" / "2026-09-12.json"

SOURCE = {"kind": "third-party", "label": "腾讯文档《雅思口语9-12月题库【Part123】》"}

CARD = re.compile(r"\[[^\]]{0,45}?9-12月[^\]]{0,20}?\]\s*Describe\b")
ANS = re.compile(r"🤓\s*英文回答")
ZH = re.compile(r"📝\s*中文翻译")
FOLLOW = re.compile(r"🗣️\s*语音跟读")
IDEA = re.compile(r"🔗\s*思路解读")
KW = re.compile(r"✅\s*关键词速记")
VOCAB = re.compile(r"📕\s*语料扩展")
YOU = re.compile(r"You\s+should\s+say\s*[:：]\s*")
CUE = re.compile(
    r"([A-Z][A-Za-z0-9 ,'/()\-:.;!?&’\u2019]{2,140}?)\s*"
    r"([\u4e00-\u9fa5][^A-Z]*?)(?=[A-Z][a-zA-Z]|$)"
)
# A label is Chinese; the opener itself must contain no Chinese (English block)
# or no Latin prose (Chinese block). Keeping the body classes permissive is
# important: openers contain em dashes, slashes and quotes that a whitelist
# would otherwise cut short, leaving another card's opener in the shared body.
OPENER_EN = re.compile(
    r"([\u4e00-\u9fa5][\u4e00-\u9fa5/A-Za-z0-9 ]{1,26})[：:]\s*"
    r"([A-Z][^\u4e00-\u9fa5]{2,320}?[.!?])\s*"
)
OPENER_ZH = re.compile(
    r"([\u4e00-\u9fa5][\u4e00-\u9fa5/A-Za-z0-9 ]{1,26})[：:]\s*"
    r"([\u4e00-\u9fa5][^。！？]{2,320}[。！？])\s*"
)
SENTENCE_EN = re.compile(r"(?<=[.!?])\s*(?=[A-Z(\[])|(?<=[.!?])(?=[A-Z])")
SENTENCE_ZH = re.compile(r"(?<=[。！？])\s*")


def norm(s: str) -> str:
    return "".join(
        c.lower() for c in (s or "")
        if ("a" <= c.lower() <= "z") or ("0" <= c.lower() <= "9") or ("\u4e00" <= c <= "\u9fa5")
    )


def squeeze(s: str) -> str:
    s = re.sub(r"\s+", " ", s or "").strip()
    s = re.sub(r"\s+([,.;:?!，。；：？！])", r"\1", s)
    return re.sub(r"([,;:?!])(?=[A-Za-z])", r"\1 ", s)


def split_paragraphs(text: str, zh: bool = False) -> list[str]:
    """Group sentences into speakable units without ever dropping the ending.

    `validate.ts` allows at most 12 paragraphs of 1200 chars each. A shared
    story can be 3000+ chars, so a fixed "2 sentences per paragraph" rule used
    to hit the cap and silently truncate the conclusion. Instead, derive the
    group size from the sentence count, then split further on the hard char cap.
    """
    text = squeeze(text)
    if not text:
        return []
    parts = [p.strip() for p in (SENTENCE_ZH if zh else SENTENCE_EN).split(text) if p.strip()]
    if not parts:
        return []
    group = max(1, -(-len(parts) // 12))  # ceil(sentences / 12)
    out: list[str] = []
    for i in range(0, len(parts), group):
        chunk = " ".join(parts[i:i + group]).strip()
        while len(chunk) > 1200:
            cut = chunk.rfind("。" if zh else ".", 0, 1200)
            cut = cut + 1 if cut > 200 else 1200
            out.append(chunk[:cut].strip())
            chunk = chunk[cut:].strip()
        if chunk:
            out.append(chunk)
    # A very long story can still exceed 12 chunks after the char split; merge
    # the tail into the previous paragraph rather than discarding it.
    if len(out) > 12:
        merged = out[:11] + [" ".join(out[11:]).strip()]
        out = [p[:1200] for p in merged]
    return [p for p in out if p]


def parse_cues(body: str, ends_at_answer: bool = False) -> list[str]:
    """Extract the English halves of `English cue + Chinese gloss` pairs.

    A card is 4 cues, sometimes 5. A 5th cue is kept only when it is a genuine
    `And explain ...` bullet, or when the segment runs straight into the answer
    block (so nothing could have bled in from a following card). Otherwise the
    5th item is the *next* card's first cue glued onto this cell — the exact
    corruption that put "Where it was" under 嘈杂地 in the old bank.
    """
    ym = YOU.search(body)
    if not ym:
        return []
    raw = body[ym.end():]
    cues = []
    for c in CUE.finditer(raw):
        en = c.group(1).strip(" .,;:/")
        # The document sometimes repeats a phrase (`What it is like What it is
        # like`); collapse the duplication without touching legitimate text.
        en = re.sub(r"\b(.{6,40}?)\s+\1\b", r"\1", en)
        if len(en) < 3 or en.startswith("Question") or ".mp3" in en:
            continue
        cues.append(en)
    if len(cues) > 4:
        fifth = cues[4]
        if re.match(r"And explain", fifth, re.I) or ends_at_answer:
            return cues[:5]
        return cues[:4]
    return cues


def head_text(body: str) -> str:
    ym = YOU.search(body)
    head = body[:ym.start()] if ym else body
    return re.sub(r"^\[[^\]]{0,45}?9-12月[^\]]{0,20}?\]\s*", "", head).strip()


def card_name_zh(text: str, start: int, names: list[str]) -> str | None:
    """The Chinese card name sits immediately before `[<tag>]Describe`."""
    window = text[max(0, start - 45):start]
    hits = [n for n in names if n and n in window]
    return max(hits, key=len) if hits else None


def strip_opener_region(body: str, rx: re.Pattern) -> tuple[list[tuple[str, str]], str]:
    """Split a leading `中文卡名：首句` list from the shared story body.

    The document puts one opening sentence per card before the story that all
    cards share. Matching *every* label (not just a contiguous run) is what
    keeps another card's opener out of the shared body: merged labels such as
    `想颁布的新法律 / 想要颁布的环保法律` are included too.
    """
    scope = body[:3000]
    matches = list(rx.finditer(scope))
    if not matches or matches[0].start() > 80:
        return [], body
    openers = [(m.group(1).strip(), squeeze(m.group(2))) for m in matches]
    return openers, body[matches[-1].end():]


def clean_en(s: str) -> str:
    """Drop structural Chinese subtitles (`万能背景`, `发小`) left in English prose.

    The document glues them directly onto the next English word, e.g.
    `万能背景The person I'd like to talk about...`, so a plain space boundary is
    not enough. Only short pure-Chinese runs are removed; an English sentence
    containing a Chinese quote is never touched.
    """
    s = re.sub(r"[\u4e00-\u9fa5]{2,8}(?=[A-Za-z])", " ", s)
    s = re.sub(r"(?:^|\s)[\u4e00-\u9fa5]{2,8}(?=\s|$)", " ", s)
    return squeeze(s)


def parse_answer_block(text: str, start: int, end: int) -> dict:
    def marker(rx, lo=start, hi=end):
        return rx.search(text, lo, hi)

    zh_m = marker(ZH)
    fol_m = marker(FOLLOW)
    idea_m = marker(IDEA)
    kw_m = marker(KW)
    voc_m = marker(VOCAB)
    boundaries = [m.start() for m in (zh_m, fol_m, idea_m, kw_m, voc_m) if m] + [end]
    ans_end = min(boundaries)

    en = text[start:ans_end]
    zh_start = zh_m.end() if zh_m else None
    zh_end = min(
        [m.start() for m in (fol_m, idea_m, kw_m, voc_m) if m and m.start() > (zh_start or 0)] + [end]
    ) if zh_m else end
    zh_body = text[zh_start:zh_end] if zh_m else ""

    idea_start = idea_m.end() if idea_m else None
    idea_end = min(
        [m.start() for m in (kw_m, voc_m) if m and m.start() > (idea_start or 0)] + [end]
    ) if idea_m else end
    idea_body = text[idea_start:idea_end] if idea_m else ""

    en_openers, shared_en = strip_opener_region(en, OPENER_EN)
    zh_openers, shared_zh = strip_opener_region(zh_body, OPENER_ZH)
    return {
        "enOpeners": en_openers,
        "zhOpeners": zh_openers,
        "sharedEn": clean_en(shared_en) if en_openers else clean_en(en),
        "sharedZh": squeeze(shared_zh) if zh_openers else squeeze(zh_body),
        "idea": squeeze(idea_body),
    }


def label_match(label: str, name: str) -> bool:
    """Conservative match between a document opener label and a bank card name."""
    def clean(s):
        return re.sub(r"[\s/·、，,（）()]+", "", s or "")
    l, n = clean(label), clean(name)
    if not l or not n:
        return False
    if l == n:
        return True
    if len(n) >= 3 and (n in l or l in n):
        return True
    if len(n) >= 4 and len(l) >= 4 and n[:4] == l[:4]:
        return True
    return False


def pick_opener(openers: list[tuple[str, str]], name: str) -> str | None:
    hits = [s for lab, s in openers if label_match(lab, name)]
    # Only a unique match is safe; a shared/merged label must not be guessed.
    return hits[0] if len(hits) == 1 else None


def parse_idea(raw: str) -> list[dict]:
    """Part 2 思路解读: `第1️⃣段：背景与去的原因🙌 Note: ...` per stage."""
    if not raw:
        return []
    marks = list(re.finditer(r"第\s*[0-9\u20e3\ufe0f]+\s*段\s*[：:]\s*", raw))
    out = []
    for i, m in enumerate(marks[:10]):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(raw)
        chunk = raw[m.end():end]
        label, _, note = chunk.partition("🙌")
        note = re.sub(r"^\s*Note\s*[:：]\s*", "", note).strip(" •")
        out.append({
            "label": squeeze(label)[:40],
            "text": squeeze(note)[:400],
            "phrases": [],
        })
    return [x for x in out if x["label"] or x["text"]]


def build(text: str, bank: dict, learning: dict) -> tuple[list[dict], dict, list[str]]:
    topics = bank["topics"]
    cards = []
    for tp in topics:
        for q in tp.get("part2") or []:
            cards.append({
                "key": tp["key"], "name": tp["name"], "text": q["text"],
                "oldCues": q.get("cuePoints") or [],
            })
    names = [c["name"] for c in cards] + [tp["name"] for tp in topics if tp.get("part2")]
    by_norm = {norm(c["text"]): c for c in cards}

    marks = list(CARD.finditer(text))
    ans_marks = list(ANS.finditer(text))
    if not marks or not ans_marks:
        raise SystemExit("no Part 2 card / answer markers found — wrong document?")

    segments = []
    for i, m in enumerate(marks):
        nxt_c = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        nxt_a = next((a.start() for a in ans_marks if a.start() > m.start()), len(text))
        body = text[m.start():min(nxt_c, nxt_a)]
        head = head_text(body)
        nh = norm(head)
        card = None
        for cn, c in by_norm.items():
            if nh.startswith(cn) or cn.startswith(nh) or (len(cn) > 20 and cn in nh):
                card = c
                break
        segments.append({
            "start": m.start(), "end": min(nxt_c, nxt_a),
            "cues": parse_cues(body, ends_at_answer=(nxt_a < nxt_c)), "card": card,
            "name": card_name_zh(text, m.start(), names),
        })

    # A story group = consecutive card segments in document order.
    groups, cur = [], [0]
    for i in range(len(segments) - 1):
        if segments[i + 1]["start"] - segments[i]["end"] < 1200:
            cur.append(i + 1)
        else:
            groups.append(cur)
            cur = [i + 1]
    groups.append(cur)

    group_answer = {}
    for gi, g in enumerate(groups):
        end = segments[g[-1]]["end"]
        a = next((x for x in ans_marks if x.start() >= end and x.start() - end < 1200), None)
        group_answer[gi] = a
    blocks = {}
    for a in ans_marks:
        ai = ans_marks.index(a)
        end = ans_marks[ai + 1].start() if ai + 1 < len(ans_marks) else len(text)
        blocks[a.start()] = parse_answer_block(text, a.end(), end)

    # Attach each bank card to the best (longest) answer block it belongs to.
    best_block: dict[str, tuple[int, dict]] = {}
    for gi, g in enumerate(groups):
        a = group_answer.get(gi)
        if not a:
            continue
        block = blocks[a.start()]
        for si in g:
            seg = segments[si]
            if not seg["card"]:
                continue
            k = norm(seg["card"]["text"])
            score = len(block["sharedEn"])
            if k not in best_block or score > best_block[k][0]:
                best_block[k] = (score, block)

    # Vote on cue points across every occurrence of the same card.
    cue_votes: dict[str, list[tuple[str, ...]]] = defaultdict(list)
    for seg in segments:
        if seg["card"] and len(seg["cues"]) >= 3:
            cue_votes[norm(seg["card"]["text"])].append(tuple(seg["cues"]))
    final_cues = {}
    for k, votes in cue_votes.items():
        final_cues[k] = list(Counter(votes).most_common(1)[0][0])

    problems: list[str] = []
    built: list[dict] = []
    for c in cards:
        k = norm(c["text"])
        cues = final_cues.get(k)
        if not cues or len(cues) < 3:
            problems.append(f"cuePoints 无法从文档重建（保留原值）: {c['name']}")
            cues = None
        info = best_block.get(k)
        if not info:
            problems.append(f"找不到答案块: {c['name']} | {c['text'][:60]}")
            built.append({"card": c, "cues": cues, "learning": {}})
            continue
        block = info[1]
        opener = pick_opener(block["enOpeners"], c["name"])
        opener_zh = pick_opener(block["zhOpeners"], c["name"])
        en = " ".join(x for x in (opener, block["sharedEn"]) if x).strip()
        zh_text = " ".join(x for x in (opener_zh, block["sharedZh"]) if x).strip()
        if not en:
            problems.append(f"答案为空: {c['name']}")
            built.append({"card": c, "cues": cues, "learning": {}})
            continue
        paras = split_paragraphs(en)
        paras_zh = split_paragraphs(zh_text, zh=True)
        if not paras:
            problems.append(f"答案分段为空: {c['name']}")
            built.append({"card": c, "cues": cues, "learning": {}})
            continue
        group_size = sum(
            1 for g in groups
            if any(segments[si]["card"] and norm(segments[si]["card"]["text"]) == k for si in g)
        )
        lc = {
            "sampleAnswer": {
                "paragraphs": paras,
                **({"paragraphsZh": paras_zh} if paras_zh else {}),
                "variantLabel": "串题故事（多卡共用正文）" if group_size > 1 else "示范答案",
                "source": SOURCE,
                "reviewStatus": "draft",
                "targetBandHint": None,
            },
        }
        idea = parse_idea(block["idea"])
        if idea:
            lc["ideaNotes"] = idea
        built.append({"card": c, "cues": cues, "learning": lc})

    stats = {
        "documents": len(cards),
        "segments": len(segments),
        "groups": len(groups),
        "answerBlocks": len(ans_marks),
        "cardsWithAnswer": sum(1 for b in built if b["learning"]),
        "cardsWithCues": sum(1 for b in built if b["cues"]),
        "cuesChanged": sum(1 for b in built if b["cues"] and [norm(x) for x in b["cues"]] != [norm(x) for x in b["card"]["oldCues"]]),
        "openersMatched": sum(1 for b in built if b["learning"] and b["learning"].get("sampleAnswer", {}).get("variantLabel")),
    }
    return built, stats, problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--doc", required=True)
    ap.add_argument("--bank", default=str(BANK_PATH))
    ap.add_argument("--learning", default=str(LEARN_PATH))
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    doc = Path(args.doc)
    if not doc.exists():
        print(f"document dump not found: {doc}", file=sys.stderr)
        return 2
    text = doc.read_text(encoding="utf-8")
    bank = json.loads(Path(args.bank).read_text(encoding="utf-8"))
    learning = json.loads(Path(args.learning).read_text(encoding="utf-8"))

    built, stats, problems = build(text, bank, learning)
    print("=== Part 2 重建统计 ===")
    for k, v in stats.items():
        print(f"  {k}: {v}")
    print("\n=== cuePoints 变化示例（前 12）===")
    shown = 0
    for b in built:
        if b["cues"] and [norm(x) for x in b["cues"]] != [norm(x) for x in b["card"]["oldCues"]]:
            print(f"  {b['card']['name']}")
            print(f"    旧: {b['card']['oldCues']}")
            print(f"    新: {b['cues']}")
            shown += 1
            if shown >= 12:
                break
    if problems:
        print(f"\n=== 告警 {len(problems)} 条 ===")
        for p in problems[:20]:
            print("  ⚠️", p)

    # Hard invariants: never lose a question, never ship an empty answer/cue.
    assert len(built) == stats["documents"], "card count changed"
    fail = []
    if stats["cardsWithAnswer"] != stats["documents"]:
        fail.append(f"only {stats['cardsWithAnswer']}/{stats['documents']} cards have answers")
    if stats["cardsWithCues"] != stats["documents"]:
        fail.append(f"only {stats['cardsWithCues']}/{stats['documents']} cards have cue points")
    bad_cues = [b["card"]["name"] for b in built if b["cues"] and len(b["cues"]) < 3]
    if bad_cues:
        fail.append(f"cue points < 3: {bad_cues}")
    if fail:
        print("\n断言失败：", *fail, sep="\n  ")
        return 1

    if args.write:
        # 1) bank: replace cuePoints only, preserving every other field.
        cue_by_key = {(b["card"]["key"], norm(b["card"]["text"])): b["cues"] for b in built}
        for tp in bank["topics"]:
            for q in tp.get("part2") or []:
                cues = cue_by_key.get((tp["key"], norm(q["text"])))
                if cues:
                    q["cuePoints"] = cues
        Path(args.bank).write_text(json.dumps(bank, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

        # 2) learning sidecar: replace ONLY part-2 entries, keep P1/P3 byte-equal.
        lc_by_key = {(b["card"]["key"], norm(b["card"]["text"])): b["learning"] for b in built}
        for e in learning["entries"]:
            if e.get("part") == 2:
                lc = lc_by_key.get((e["topicKey"], norm(e["text"])))
                if lc is not None:
                    e["learning"] = lc
        Path(args.learning).write_text(json.dumps(learning, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"\n已写入 {args.bank} 与 {args.learning}")
    else:
        print("\n未写入（dry run，加 --write 生效）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
