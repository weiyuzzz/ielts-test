/**
 * IELTS Speaking assessment criteria, transcribed from the seasonal question-bank
 * document ("考试评分标准-Criteria" + "Simon 雅思口语笔记"). This is the single
 * source of truth injected into the AI scorer and shown in the score report.
 *
 * Four independent criteria, each worth 25%, on a 0–9 scale (half bands allowed).
 * The concrete 0–9 band-descriptor table in that document is an image; the text
 * here covers the key indicators, which is what the scorer must evidence.
 */
export interface Criterion {
  key: "FC" | "LR" | "GRA" | "P";
  label: string;
  labelZh: string;
  indicators: string[];
}

export const CRITERIA: Criterion[] = [
  {
    key: "FC", label: "Fluency & Coherence", labelZh: "流利度与连贯性",
    indicators: [
      "语速（speech rate）：不过慢，能在脑中维持词句连接",
      "表达连续性：避免反复重启句子（false starts）、回退修改（backtracking）、无意义重复、频繁找词停顿",
      "连贯性：句子逻辑顺序、结构标记（合理停顿与话语标记）、内容相关性、衔接手段（连接词/代词/连词）",
    ],
  },
  {
    key: "LR", label: "Lexical Resource", labelZh: "词汇资源",
    indicators: [
      "词汇多样性与充分性、恰当性（adequacy & appropriacy）",
      "指称意义准确、语体（正式/非正式）合适",
      "搭配与习语自然，能表达赞成/中立/反对等态度",
      "同义替换 / paraphrase 能力（词不够时能换说法）",
    ],
  },
  {
    key: "GRA", label: "Grammatical Range & Accuracy", labelZh: "语法范围与准确性",
    indicators: [
      "Range：句子长度、从句、动词短语复杂性（进行/完成/情态/被动）、短语前后修饰、句型多样性",
      "Accuracy：错误密度（每百词）、错误的交际影响（是否影响理解与清晰度）",
      "重点是减少错误，不是堆砌复杂结构",
    ],
  },
  {
    key: "P", label: "Pronunciation", labelZh: "发音",
    indicators: [
      "分块（chunking）：把句子切分成有意义单元",
      "节奏与重音、连读（连音/弱读/省音）",
      "重音与语调（强调、对比）",
      "音素、单词重音、元音与辅音发音准确",
      "听者理解所需努力；口音可懂度（accent intelligibility）——发音不是口音，任何国家口音都不扣分",
    ],
  },
];

/** Part-specific expectations (Simon notes): an answer that is "short" is correct in Part 1. */
export const PART_RULES: Record<number, string> = {
  1: "Part 1（4–5 分钟，10–11 个短问题）：考流利度。短、快、直接，完整句 + 一个原因即可；答案短是正确策略，不得因此扣分，也不得因冗长而加分。",
  2: "Part 2（1 分钟准备 + 2 分钟独白）：考词汇与想法。围绕人物/地点/事件/物品/活动/最爱六大主题，详细解释与举例；不以结构复杂或语法花哨为主要加分项。",
  3: "Part 3（3–6 个问题）：考长而详细的答案与结构（直接回答 → 解释 why → 举例 → 相反/替代），重逻辑展开与观点方向。",
};

export const WEIGHT_RULE = "四个独立分数各占 25%，0–9 分，允许半分；总分按 IELTS 规则取整（.25 进到 .5，.75 进到整分）。缺失的维度必须标为未评估，不得用占位分数补齐。";

/** Text injected into the AI scoring prompt. */
export function criteriaBrief(): string {
  return [
    "IELTS Speaking public band descriptors — key indicators:",
    ...CRITERIA.map((c) => `${c.key} ${c.label}（${c.labelZh}）：${c.indicators.join("；")}`),
    "Part-specific expectations:",
    ...Object.entries(PART_RULES).map(([p, r]) => `Part ${p}: ${r}`),
    WEIGHT_RULE,
  ].join("\n");
}
