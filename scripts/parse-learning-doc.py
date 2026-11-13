#!/usr/bin/env python3
"""
Build the learning sidecar (`src/data/learning/<season>.json`) from the source
document dump.

Input  : plain-text dump of the Tencent Doc (`--doc`) + the bank JSON that was
         generated from the same document (`--bank`).
Output : one entry per *bank* question:

   { topicKey, part, text, learning: { sampleAnswer, ideaNotes, keyPhrases, vocabGroups } }

Rules
-----
1. The bank decides which questions exist. This script only attaches material;
   it never creates, renames or deletes a question.
2. Questions are located by their own wording (normalised), not by position:
   the document is a table whose cells drift.
3. Missing material stays missing and is reported. Nothing is invented.
4. Evergreen topics answer a block of sub-questions with one answer
   ("类似小问合并回答"); that block is shared and flagged, not passed off as
   fifteen separate answers.

Usage
-----
    python3 scripts/parse-learning-doc.py --doc /tmp/doc.txt --check
    python3 scripts/parse-learning-doc.py --doc /tmp/doc.txt --write
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BANK_DIR = ROOT / "src" / "data" / "question-banks"
LEARNING_DIR = ROOT / "src" / "data" / "learning"

ROW_FOOT = re.compile(
    r"\|\s*(大陆地区|非大陆地区)?\s*\|\s*(9-12月新题|9-12月保留题|万年保留题)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*$",
    re.M,
)
ROW_HEAD = re.compile(r"\n\|\s*(\d{1,2})\s*\|\s*([A-Za-z][^\n]{0,60})")

M_ANSWER_ZH = "📔 中文翻译"
M_FOLLOW = "📢 语音跟读"
M_IDEA = "🔗 思路解读"
M_KEYWORDS_1 = "❗️关键词速记"
M_KEYWORDS_2 = "🧩 关键词速记"
M_VOCAB = "📕 语料扩展"
M_P3_ANSWER = "🗣️ 具体回答"
M_P2_ANSWER = "🤓 英文回答"

SOURCE = {"kind": "third-party", "label": "腾讯文档《雅思口语9-12月题库【Part123】》"}

STOP = (
    "Have ", "Do ", "Did ", "Is ", "Are ", "What ", "When ", "Where ", "Why ",
    "How ", "Would ", "Should ", "Who ", "Which ", "Can ", "Could ", "Tell ",
)

# --------------------------------------------------------------------------- #
# text helpers
# --------------------------------------------------------------------------- #


def norm(s: str) -> str:
    out = []
    for ch in s:
        low = ch.lower()
        if ("a" <= low <= "z") or ("0" <= low <= "9") or ("\u4e00" <= ch <= "\u9fa5"):
            out.append(low)
    return "".join(out)


def norm_with_map(s: str) -> tuple[str, list[int]]:
    out, pos = [], []
    for i, ch in enumerate(s):
        low = ch.lower()
        if ("a" <= low <= "z") or ("0" <= low <= "9") or ("\u4e00" <= ch <= "\u9fa5"):
            out.append(low)
            pos.append(i)
    return "".join(out), pos


def squeeze(s: str) -> str:
    s = re.sub(r"\s+", " ", s or "").strip()
    s = re.sub(r"\s+([,.;:?!，。；：？！])", r"\1", s)
    return re.sub(r"([,;:?!])(?=[A-Za-z])", r"\1 ", s)


def split_sections(text: str, markers: list[tuple[str, str]]) -> dict[str, str]:
    found = []
    for name, mark in markers:
        i = text.find(mark)
        if i >= 0:
            found.append((i, name, mark))
    found.sort()
    sections: dict[str, str] = {"lead": text[: found[0][0]] if found else text}
    for idx, (i, name, mark) in enumerate(found):
        end = found[idx + 1][0] if idx + 1 < len(found) else len(text)
        sections[name] = text[i + len(mark) : end]
    return sections


ZH_QUESTION = re.compile(r"^[\s?？.。,，]*\s*(?P<zh>[\u4e00-\u9fa5][^？?]{0,130}[？?])")


def split_question_and_translation(chunk: str) -> tuple[str, str]:
    m = ZH_QUESTION.match(chunk or "")
    if not m:
        return "", squeeze(chunk)
    return m.group("zh").strip(), squeeze(chunk[m.end() :])


# --------------------------------------------------------------------------- #
# idea notes
# --------------------------------------------------------------------------- #

META_WORDS = ("说明", "引出", "连接", "强调", "表达", "转折", "补充", "指代", "从句", "语气", "对照", "总结")
LABEL_TAIL = re.compile(r"([\u4e00-\u9fa5\u20e3\ufe0f +\-]{2,16})$")


def clean_label(head: str) -> str:
    head = (head or "").strip(" ：:；;")
    m = LABEL_TAIL.search(head)
    label = (m.group(1) if m else head).strip()
    if any(w in label for w in META_WORDS):
        parts = [p for p in label.split() if p and not any(w in p for w in META_WORDS)]
        label = parts[-1] if parts else label
    return label[:16]


def phrases_of(text: str) -> list[str]:
    return [p.strip(" ：:") for p in re.split(r"➕|\s\+\s", (text or "").strip()) if p.strip(" ：:")]


def parse_idea_p1(raw: str) -> list[dict]:
    """`直接表态：a ➕ b 🙌 Note: ... 观看原因：c ➕ d 🙌 Note: ...` -> steps.

    The document glues a heading onto the previous step's note, and the note
    mixes Chinese glosses with English. Splitting on `🙌 Note:` and then finding
    the last colon whose tail has no Chinese recovers the boundary without
    guessing at headings.
    """
    text = squeeze(raw)
    if not text:
        return []
    chunks = re.split(r"🙌\s*Note\s*[:：]\s*", text)
    head = chunks[0]
    colon = head.find("：")
    cur_label = clean_label(head[:colon]) if colon > 0 else ""
    cur_phrases = phrases_of(head[colon + 1 :] if colon > 0 else head)

    out: list[dict] = []
    for chunk in chunks[1:]:
        cut = None
        for m in reversed(list(re.finditer("：", chunk))):
            tail = chunk[m.end() :].strip()
            if tail and not re.search(r"[\u4e00-\u9fa5]", tail) and re.search(r"[A-Za-z]", tail):
                cut = m
                break
        if cut is None:
            note = squeeze(chunk)
            if note and out:
                out[-1]["note"] = (out[-1]["note"] + "；" + note).strip("；")
            elif note:
                out.append({"label": "", "text": "", "phrases": [], "note": note})
            continue

        note = squeeze(chunk[: cut.start()])
        next_label = clean_label(chunk[: cut.start()])
        if next_label and note.endswith(next_label):
            note = squeeze(note[: -len(next_label)])
        next_phrases = phrases_of(chunk[cut.end() :])

        if cur_phrases or cur_label:
            out.append(
                {
                    "label": cur_label,
                    "text": " + ".join(cur_phrases) if cur_phrases else cur_label,
                    "phrases": cur_phrases,
                    "note": note,
                }
            )
        elif note:
            out.append({"label": "", "text": "", "phrases": [], "note": note})
        cur_label, cur_phrases = next_label, next_phrases

    if cur_phrases or cur_label:
        out.append(
            {
                "label": cur_label,
                "text": " + ".join(cur_phrases) if cur_phrases else cur_label,
                "phrases": cur_phrases,
                "note": "",
            }
        )
    return out


P3_STAGE = re.compile(r"(观点|解释|例子|延伸\[可选\]|延伸)")
P3_STAGE_MAP = {"观点": "main-idea", "解释": "reason", "例子": "example", "延伸": "result", "延伸[可选]": "result"}


def parse_idea_p3(raw: str) -> list[dict]:
    """`观点 <EN> <ZH> 解释 <EN> <ZH> ...` -> one note per stage."""
    text = squeeze(raw)
    marks = list(P3_STAGE.finditer(text))
    out = []
    for idx, m in enumerate(marks):
        end = marks[idx + 1].start() if idx + 1 < len(marks) else len(text)
        body = text[m.end() : end].strip(" •")
        if not body:
            continue
        en, zh = body, ""
        first_zh = re.search(r"[\u4e00-\u9fa5]", body)
        if first_zh:
            en, zh = body[: first_zh.start()].strip(), body[first_zh.start() :].strip()
        out.append(
            {
                "stage": P3_STAGE_MAP.get(m.group(1), "main-idea"),
                "label": m.group(1),
                "text": en or m.group(1),
                "textZh": zh,
            }
        )
    return out


# --------------------------------------------------------------------------- #
# keywords + vocabulary
# --------------------------------------------------------------------------- #

KW_P1 = re.compile(r"([A-Za-z][A-Za-z0-9'’\- /]{1,40}?)\s*[（(]([^）)]{0,80})[）)]")
EMOJI = re.compile(r"[\U0001F000-\U0001FAFF\u2600-\u27BF\ufe0f\u2192\u2b05\u2b06\u2934\u2935]")


def parse_keywords(raw: str) -> list[dict]:
    text = squeeze(raw)
    out, seen = [], set()
    for m in KW_P1.finditer(text):
        phrase = m.group(1).strip(" -/")
        if not phrase or phrase.lower() in seen:
            continue
        seen.add(phrase.lower())
        out.append({"phrase": phrase, "zh": squeeze(m.group(2))})
    if out:
        return out
    for part in EMOJI.split(text):
        phrase = part.strip(" →-—·,")
        if not phrase or len(phrase) > 60 or not re.search(r"[A-Za-z]{2}", phrase):
            continue
        if phrase.lower() in seen:
            continue
        seen.add(phrase.lower())
        out.append({"phrase": phrase, "zh": ""})
    return out


VOCAB_TITLE = re.compile(r"(?:^|•|\s)([\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z/ +\-]{0,18})：")
VOCAB_ITEM = re.compile(r"^([A-Za-z][A-Za-z0-9'’\- ./+&]{0,42}?)\s*[（(]?\s*([\u4e00-\u9fa5][^）)]*)[）)]?$")


def parse_vocab(raw: str) -> list[dict]:
    text = squeeze(raw)
    if not text:
        return []
    marks = list(VOCAB_TITLE.finditer(text))
    if not marks:
        return [{"title": "语料扩展", "items": [], "note": text}]
    groups: list[dict] = []
    for idx, m in enumerate(marks):
        end = marks[idx + 1].start() if idx + 1 < len(marks) else len(text)
        title = m.group(1).strip(" •")
        items = []
        for chunk in text[m.end() : end].split("/"):
            chunk = chunk.strip(" •；;,、")
            if not chunk or not re.search(r"[A-Za-z]{2}", chunk):
                continue
            im = VOCAB_ITEM.match(chunk)
            if not im:
                continue
            en = im.group(1).strip(" -")
            zh = squeeze(im.group(2) or "")
            if en and len(en) <= 60:
                items.append({"en": en, "zh": zh})
        if items:
            groups.append({"title": title, "items": items})
    return groups or [{"title": "语料扩展", "items": [], "note": text}]


# --------------------------------------------------------------------------- #
# anchoring
# --------------------------------------------------------------------------- #


def anchor_offsets(body: str, texts: list[str]) -> list[tuple[int, int] | None]:
    nstr, pos = norm_with_map(body)
    out: list[tuple[int, int] | None] = []
    cursor = 0
    for text in texts:
        n = norm(text)
        i = nstr.find(n, cursor) if n else -1
        if i < 0:
            out.append(None)
            continue
        out.append((pos[i], pos[i + len(n) - 1] + 1))
        cursor = i + len(n)
    return out


def slice_between(body: str, anchors: list[tuple[int, int] | None]) -> list[tuple[int, int] | None]:
    starts = [a[0] if a else None for a in anchors]
    spans = []
    for i, start in enumerate(starts):
        if start is None:
            spans.append(None)
            continue
        nxt = next((s for s in starts[i + 1 :] if s is not None), len(body))
        spans.append((start, nxt))
    return spans


SENTENCE = re.compile(r"(?<=[.!?])\s+(?=[A-Z(\[])")


def split_paragraphs(text: str) -> list[str]:
    sentences = [s.strip() for s in SENTENCE.split(text) if s.strip()]
    return [" ".join(sentences[i : i + 2]) for i in range(0, len(sentences), 2)]


def build_learning(
    answer: str,
    answer_zh: list[str],
    idea,
    keywords,
    vocab,
    variant: str | None = None,
) -> dict:
    learning: dict = {}
    answer = squeeze(answer)
    if answer:
        learning["sampleAnswer"] = {
            "paragraphs": split_paragraphs(answer),
            "paragraphsZh": [p for p in answer_zh if p],
            "source": SOURCE,
            "reviewStatus": "draft",
            "targetBandHint": None,
            **({"variantLabel": variant} if variant else {}),
        }
    if idea:
        learning["ideaNotes"] = idea[:10]
    if keywords:
        learning["keyPhrases"] = keywords[:18]
    if vocab:
        learning["vocabGroups"] = vocab[:12]
    return learning


# --------------------------------------------------------------------------- #
# Part 1
# --------------------------------------------------------------------------- #


def raw_topic_name(raw: str) -> str:
    cut = len(raw)
    for kw in STOP:
        j = raw.find(kw)
        if j > 0:
            cut = min(cut, j)
    head = raw[:cut].strip(" -/")
    return re.split(r"[-－]", head, maxsplit=1)[0].strip()


def part1_rows(text: str) -> list[tuple[str, str, int]]:
    start = text.find("Part1口语素材库-IELTS")
    if start < 0:
        raise SystemExit("Part 1 table header not found")
    seg = text[start:]
    limit = seg.find("Part2")
    if limit < 0:
        limit = len(seg)
    rows = list(ROW_HEAD.finditer(seg[:limit]))
    out = []
    for i, m in enumerate(rows):
        end = rows[i + 1].start() if i + 1 < len(rows) else limit
        row = seg[m.start() : end]
        foot = ROW_FOOT.search(row)
        if not foot or foot.group(1) != "大陆地区":
            continue
        out.append((raw_topic_name(m.group(2)), row[: foot.start()], int(foot.group(4))))
    return out


def parse_p1_question(after: str) -> dict:
    sections = split_sections(
        after,
        [("answerZh", M_ANSWER_ZH), ("follow", M_FOLLOW), ("idea", M_IDEA),
         ("keywords", M_KEYWORDS_1), ("vocab", M_VOCAB)],
    )
    _text_zh, answer = split_question_and_translation(sections.get("lead", ""))
    answer_zh = squeeze(sections.get("answerZh", ""))
    return build_learning(
        answer,
        [answer_zh] if answer_zh else [],
        parse_idea_p1(sections.get("idea", "")),
        parse_keywords(sections.get("keywords", "")),
        parse_vocab(sections.get("vocab", "")),
    )


def shared_answer(learning: dict) -> dict:
    out = dict(learning)
    answer = out.get("sampleAnswer")
    if answer:
        out["sampleAnswer"] = {**answer, "variantLabel": "合并回答（同组共用）"}
    return out


def parse_part1(text: str, topics: list[dict]) -> tuple[dict, list[str]]:
    rows = part1_rows(text)
    by_name = {t["name"]: t for t in topics if t.get("category") == "part1"}
    result: dict[tuple[str, int, str], dict] = {}
    problems: list[str] = []

    for name, body, _examinees in rows:
        topic = by_name.get(name)
        if not topic:
            problems.append(f"Part 1 主题「{name}」不在题库中，已跳过")
            continue
        questions = topic.get("part1") or []
        anchors = anchor_offsets(body, [q["text"] for q in questions])
        spans = slice_between(body, anchors)
        pending: list[dict] = []
        for q, anchor, span in zip(questions, anchors, spans):
            if anchor is None or span is None:
                problems.append(f"Part 1「{name}」未定位：{q['text'][:60]}")
                continue
            after = body[anchor[1] : span[1]]
            if M_ANSWER_ZH not in after:
                pending.append(q)
                continue
            learning = parse_p1_question(after)
            for shared in pending:
                result[(topic["key"], 1, norm(shared["text"]))] = shared_answer(learning)
            pending = []
            result[(topic["key"], 1, norm(q["text"]))] = learning
        for shared in pending:
            problems.append(f"Part 1「{name}」无回答块：{shared['text'][:50]}")
    return result, problems


# --------------------------------------------------------------------------- #
# Part 3
# --------------------------------------------------------------------------- #


def parse_p3_question(after: str) -> dict:
    sections = split_sections(
        after,
        [("answer", M_P3_ANSWER), ("follow", M_FOLLOW), ("keywords", M_KEYWORDS_2), ("vocab", M_VOCAB)],
    )
    _zh, lead = split_question_and_translation(sections.get("lead", ""))
    # A few rows put `📢 语音跟读` immediately after `🗣️ 具体回答`, before the
    # actual 观点/解释/例子 text. In that case `answer` is empty and the answer
    # body lands in `follow`. Only fall back when the normal source yields no
    # stages at all AND `follow` really carries stage markers — otherwise a row
    # whose answer legitimately lives in `lead` would be overwritten by an
    # unrelated neighbouring block.
    body = sections.get("answer", "") or lead
    follow = sections.get("follow", "")
    if not parse_idea_p3(body) and parse_idea_p3(follow):
        body = follow
    idea = parse_idea_p3(body)
    learning = build_learning(
        "",
        [],
        idea,
        parse_keywords(sections.get("keywords", "")),
        parse_vocab(sections.get("vocab", "")),
    )
    # One paragraph per stage keeps每个 stage 的英文与中文一一对应（Part 3 的
    # 观点/解释/例子/延伸 本来就是四段）。
    if idea:
        learning["sampleAnswer"] = {
            "paragraphs": [n["text"] for n in idea if n.get("text")],
            "paragraphsZh": [n.get("textZh", "") for n in idea if n.get("textZh")],
            "source": SOURCE,
            "reviewStatus": "draft",
            "targetBandHint": None,
        }
    return learning


def parse_part3(text: str, topics: list[dict]) -> tuple[dict, list[str]]:
    nstr, pos = norm_with_map(text)
    found: list[dict] = []
    problems: list[str] = []
    cursor: dict[str, int] = {}

    for topic in topics:
        for q in topic.get("part3") or []:
            n = norm(q.get("text") or "")
            if not n:
                continue
            start_n = nstr.find(n, cursor.get(n, 0))
            if start_n < 0:
                problems.append(f"Part 3「{topic['name']}」未定位：{q['text'][:60]}")
                continue
            cursor[n] = start_n + len(n)
            found.append({"topic": topic, "q": q, "start": pos[start_n], "end": pos[start_n + len(n) - 1] + 1})

    found.sort(key=lambda x: x["start"])
    result: dict[tuple[str, int, str], dict] = {}
    by_start: dict[int, dict] = {}
    for idx, item in enumerate(found):
        end = found[idx + 1]["start"] if idx + 1 < len(found) else len(text)
        if end <= item["end"]:
            continue
        learning = parse_p3_question(text[item["end"] : end])
        by_start[item["start"]] = learning
        result[(item["topic"]["key"], 3, norm(item["q"]["text"]))] = learning

    # A question the document carries once but the bank uses under two cards
    # shares one parse instead of being left empty.
    shared = {norm(i["q"]["text"]): by_start.get(i["start"]) for i in found}
    for topic in topics:
        for q in topic.get("part3") or []:
            key = (topic["key"], 3, norm(q.get("text") or ""))
            if key not in result and shared.get(key[2]):
                result[key] = shared[key[2]]
    return result, problems


# --------------------------------------------------------------------------- #
# Part 2 (story groups)
# --------------------------------------------------------------------------- #

# `| card | story … | 大陆地区 | 9-12月新题 | 518 |` — one line per card in the
# index tables. The story cell can be a whole cue list, so it is not captured.
P2_INDEX_ROW = re.compile(
    r"\n\|\s*([^|\n]{2,30}?)\s*\|[^\n]*?\|\s*(大陆地区|非大陆地区)\s*\|\s*([^|\n]{1,16}?)\s*\|\s*(\d+)\s*\|"
)


def p2_examinees(text: str) -> dict[str, int]:
    """card name -> 考试人数 (mainland rows only)."""
    out: dict[str, int] = {}
    for m in P2_INDEX_ROW.finditer(text):
        name, region, _kind, count = m.groups()
        if region != "大陆地区":
            continue
        out.setdefault(name.strip(), int(count))
    return out


def p2_blocks(text: str, card_names: list[str]) -> dict[str, str]:
    """card name -> the story block it belongs to.

    A story block starts with the cue list of every card it covers and is
    followed by `🤓 英文回答`. Assigning cards by the cue list that precedes that
    marker avoids depending on the index table's story column, which is often
    empty or free text.
    """
    anchors = [m.start() for m in re.finditer(M_P2_ANSWER, text)]
    blocks: dict[str, str] = {}
    for idx, at in enumerate(anchors):
        prev = anchors[idx - 1] if idx > 0 else 0
        window = text[max(prev, at - 6000) : at]
        inline = [n for n in card_names if n in window]
        block = text[at : anchors[idx + 1] if idx + 1 < len(anchors) else len(text)]
        for name in inline:
            blocks.setdefault(name, block)
    return blocks


def parse_p2(text: str, topics: list[dict]) -> tuple[dict, list[str]]:
    cards = [t for t in topics if t.get("part2")]
    names = [t["name"] for t in cards]
    blocks = p2_blocks(text, names)
    result: dict[tuple[str, int, str], dict] = {}
    problems: list[str] = []
    cache: dict[int, dict] = {}
    for topic in cards:
        block = blocks.get(topic["name"])
        if not block:
            problems.append(f"Part 2「{topic['name']}」找不到串题故事块")
            continue
        key = id(block)
        if key not in cache:
            cache[key] = split_p2_story(block)
        body = cache[key]
        learning = build_learning(
            body["answer"],
            [body["answerZh"]] if body["answerZh"] else [],
            body["idea"],
            body["keywords"],
            body["vocab"],
            variant="串题故事",
        )
        answer = body.get("perCard", {}).get(topic["name"], body["answer"])
        if answer and learning.get("sampleAnswer"):
            learning["sampleAnswer"] = {**learning["sampleAnswer"], "paragraphs": split_paragraphs(answer)}
        for card in topic.get("part2") or []:
            result[(topic["key"], 2, norm(card["text"]))] = learning
    return result, problems


def split_p2_story(block: str) -> dict:
    sections = split_sections(
        block,
        [("answerZh", M_ANSWER_ZH), ("follow", M_FOLLOW), ("idea", M_IDEA),
         ("keywords", M_KEYWORDS_1), ("vocab", M_VOCAB)],
    )
    lead = sections.get("lead", "")
    lead = lead[len(M_P2_ANSWER) :] if lead.startswith(M_P2_ANSWER) else lead
    # The lead opens with one "首句扣题" per card, then the shared story. Drop the
    # per-card openers so a single card does not read as five openings.
    header = re.search(r"首句扣题[^\n]{0,20}?回答", lead)
    after = lead[header.end() :] if header else lead
    # `嘈杂地方：A noisy place … 拥挤地方：A crowded place … 去过的无聊地方：A place
    # … <shared story>`: every card keeps its own opening line and shares the body
    # that follows the last opening's first sentence.
    pieces = re.split(r"([\u4e00-\u9fa5]{2,10})\s*[:：]\s*(?=[A-Z])", after)
    per_card: dict[str, str] = {}
    body = after
    if len(pieces) >= 3:
        labels = pieces[1::2]
        texts = pieces[2::2]
        if texts:
            last = squeeze(texts[-1])
            first_sentence = SENTENCE.split(last, maxsplit=1)
            body = first_sentence[1] if len(first_sentence) > 1 else ""
            for label, text in zip(labels, texts):
                opener = SENTENCE.split(squeeze(text), maxsplit=1)[0]
                per_card[label] = (opener + " " + body).strip()
    return {
        "answer": squeeze(body),
        "perCard": per_card,
        "answerZh": squeeze(sections.get("answerZh", "")),
        "idea": parse_idea_p1(sections.get("idea", "")),
        "keywords": parse_keywords(sections.get("keywords", "")),
        "vocab": parse_vocab(sections.get("vocab", "")),
    }


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--doc", required=True)
    ap.add_argument("--bank", default=str(BANK_DIR / "2026-09-12-mainland.json"))
    ap.add_argument("--out", default=str(LEARNING_DIR / "2026-09-12.json"))
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    doc = Path(args.doc).read_text(encoding="utf-8")
    bank = json.loads(Path(args.bank).read_text(encoding="utf-8"))
    topics = bank["topics"]

    p1, p1p = parse_part1(doc, topics)
    p3, p3p = parse_part3(doc, topics)
    card_counts = p2_examinees(doc)

    # Part 2 material is owned by `parse-part2-doc.py`: its "串题故事" blocks
    # share one story across several cue cards and need structural group anchors
    # rather than this script's question-by-question anchoring. Read the existing
    # Part 2 entries back so re-running this script never wipes them.
    out_path = Path(args.out)
    existing_p2 = {}
    if out_path.exists():
        for e in json.loads(out_path.read_text(encoding="utf-8")).get("entries", []):
            if e.get("part") == 2 and e.get("learning"):
                existing_p2[(e["topicKey"], 2, norm(e.get("text") or ""))] = e["learning"]
    pools = {1: p1, 2: existing_p2, 3: p3}
    entries, missing = [], []
    counts = {1: 0, 2: 0, 3: 0}
    totals = {1: 0, 2: 0, 3: 0}
    for topic in topics:
        for part in (1, 2, 3):
            for q in topic.get(f"part{part}") or []:
                totals[part] += 1
                learning = pools[part].get((topic["key"], part, norm(q.get("text") or "")))
                if not learning and part != 2:
                    missing.append((part, topic["name"], (q.get("text") or "")[:60]))
                    continue
                if not learning:
                    learning = {}
                counts[part] += 1
                examined = topic.get("examinees") if part == 1 else (
                    card_counts.get(topic["name"]) if part == 2 else None
                )
                entries.append(
                    {
                        "topicKey": topic["key"],
                        "part": part,
                        "text": q["text"],
                        "examinees": examined,
                        "learning": learning,
                    }
                )

    for part in (1, 2, 3):
        print(f"Part {part} 命中 {counts[part]} / {totals[part]}")
    print(f"\n未解析到素材：{len(missing)}")
    for part, topic, q in missing[:15]:
        print(f"  P{part} {topic} | {q}")
    problems = p1p + p3p
    if problems:
        print(f"\n解析告警 {len(problems)} 条")
        for p in problems[:12]:
            print("  ⚠️", p)

    if args.check:
        n = len(entries)
        with_answer = sum(1 for e in entries if e["learning"].get("sampleAnswer", {}).get("paragraphs"))
        with_zh = sum(1 for e in entries if e["learning"].get("sampleAnswer", {}).get("paragraphsZh"))
        with_idea = sum(1 for e in entries if e["learning"].get("ideaNotes"))
        with_kw = sum(1 for e in entries if e["learning"].get("keyPhrases"))
        with_vocab = sum(1 for e in entries if e["learning"].get("vocabGroups"))
        per_part = {
            part: sum(1 for e in entries if e["part"] == part and e["learning"].get("sampleAnswer"))
            for part in (1, 2, 3)
        }
        print(f"\n条目 {n}：答案 {with_answer} / 译文 {with_zh} / 思路 {with_idea} / 关键词 {with_kw} / 语料 {with_vocab}")
        print(f"有答案的条目按部分：P1 {per_part[1]} / P2 {per_part[2]}（由 parse-part2-doc.py 维护）/ P3 {per_part[3]}")

    if args.write:
        payload = {
            "version": 2,
            "season": bank["season"],
            "region": bank.get("region", "大陆地区"),
            "notes": "素材来自腾讯文档原文，未经人工审核，reviewStatus 一律为 draft；不得宣称为官方范文或官方评分。",
            "entries": entries,
        }
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"\n已写入 {out}（{out.stat().st_size // 1024} KB）")

    return 0 if not missing else 1


if __name__ == "__main__":
    sys.exit(main())
