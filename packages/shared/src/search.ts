/**
 * 语音内容关键词检索 —— 纯函数核心。
 *
 * 设计目标：搜"糖"就能定位到所有语音里提到糖的片段，并按匹配程度从高到低排序。
 *
 * 检索范围是"全部语音内容"：
 * - 音频转写文本（AudioAttachment.transcript）
 * - 人工框选片段时写的片段标签（AudioClip.label）
 * 两者都是语音的文字化产物；转写缺失时，标签仍能让一句话被搜到。
 *
 * 这一层不碰数据库与时间换算，只负责：解析查询词、找命中位置、算相关度。
 * 服务层在它之外做空间鉴权与字符偏移 → 毫秒的换算，两端共用同一份排序规则。
 */

/** 一次命中：[起始字符偏移, 结束字符偏移)，偏移基于 normalizeForSearch 之前的原文 */
export interface TextMatch {
  start: number;
  end: number;
  /** 命中的是哪个查询词（已归一化形态） */
  term: string;
}

export interface ParsedSearchQuery {
  /** 拆出来的关键词（已归一化、去重、保序） */
  terms: string[];
  /** 引号包起来的短语，必须完整出现 */
  phrases: string[];
}

/**
 * 归一化用于匹配的文本，但**不改变字符长度**。
 *
 * 这是关键约束：命中位置要能映射回原文做高亮，所以只能做大小写折叠
 * （toLowerCase 对 CJK 是恒等映射、对拉丁字母是等长替换），
 * 不能做 NFKC / 去空格 / 去标点 —— 那些操作会改变长度，偏移就对不上了。
 * 展示侧高亮前再自行折叠原文同位置的字符即可。
 */
export function normalizeForSearch(text: string): string {
  return text.toLowerCase();
}

/**
 * 解析查询串：
 * - 支持空格分隔的多关键词（"糖 炒色"），命中词越多相关度越高；
 * - 支持英文/中文引号包起来的短语（'"一点糖"'），要求完整连续出现；
 * - 中文之间没有空格时整体视为一个子串（"放糖"就是搜"放糖"这个串）。
 */
export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const phrases: string[] = [];
  const phrasePattern = /["“]([^”"]{1,100})["”]/g;
  let withoutPhrases = raw;
  let match: RegExpExecArray | null;
  while ((match = phrasePattern.exec(raw)) !== null) {
    const phrase = normalizeForSearch(match[1]!.trim());
    if (phrase) phrases.push(phrase);
    withoutPhrases = withoutPhrases.replace(match[0], ' ');
  }

  const terms: string[] = [];
  for (const part of withoutPhrases.split(/\s+/)) {
    const term = normalizeForSearch(part.trim());
    if (term && !terms.includes(term)) terms.push(term);
  }
  // 短语本身也要参与"命中词数"统计，但只按短语整体算一次
  for (const phrase of phrases) {
    if (!terms.includes(phrase)) terms.push(phrase);
  }
  return { terms, phrases };
}

/** 在一段文本里找出某个关键词的全部出现位置（重叠出现也都返回） */
export function findTermMatches(normalizedText: string, term: string): TextMatch[] {
  if (!term) return [];
  const matches: TextMatch[] = [];
  let from = 0;
  while (from <= normalizedText.length - term.length) {
    const index = normalizedText.indexOf(term, from);
    if (index < 0) break;
    matches.push({ start: index, end: index + term.length, term });
    // 前进一步而不是跳到 end：支持重叠匹配，结果也稳定
    from = index + Math.max(1, term.length);
  }
  return matches;
}

export interface FieldScore {
  /** 该字段内的全部命中（用于生成摘要） */
  matches: TextMatch[];
  /** 命中次数（同一关键词出现多次都算数） */
  hitCount: number;
  /** 命中了几个不同的查询词，取值 0..1 */
  coverage: number;
  /** 命中密度 = 命中字符数 / 字段长度，短文本里命中整句比长文本里蹭到一个字更相关 */
  density: number;
  /** 该字段是否包含查询里的全部必填短语 */
  phrasesMatched: boolean;
}

/**
 * 给单个文本字段打分。
 *
 * 相关度由三部分组成（都归一到 0..1 量级后加权）：
 *   coverage  命中了多少比例的查询词 —— 多词查询时这是主导项；
 *   density   命中有多密 —— 同覆盖率下，短而集中的命中排在前面；
 *   frequency 出现频次的对数衰减 —— "糖"出现 5 次的比出现 1 次的相关，
 *             但出现 50 次不该比 5 次高一个数量级。
 *
 * 带引号的必填短语如果没有在**这个字段里**全部出现，该字段记 0 分：
 * 短语必须在同一段文本中连续出现，不能拆在两条语音里凑齐。
 *
 * @param weight 字段权重：转写正文是 1，片段标签是 0.6（标签是二手概括）
 */
export function scoreField(text: string, query: ParsedSearchQuery, weight = 1): FieldScore & { score: number } {
  const normalized = normalizeForSearch(text);
  const allMatches: TextMatch[] = [];
  const hitTerms = new Set<string>();

  for (const term of query.terms) {
    const found = findTermMatches(normalized, term);
    if (found.length > 0) {
      hitTerms.add(term);
      allMatches.push(...found);
    }
  }

  const phrasesMatched = query.phrases.every((phrase) => normalized.includes(phrase));

  const coverage = query.terms.length ? hitTerms.size / query.terms.length : 0;
  const matchedChars = allMatches.reduce((sum, item) => sum + (item.end - item.start), 0);
  const density = normalized.length ? Math.min(1, matchedChars / normalized.length) : 0;
  const frequency = allMatches.length ? Math.log1p(allMatches.length) / Math.log(11) : 0; // 10 次时趋近 1

  const eligible = query.phrases.length === 0 || phrasesMatched;
  const score = eligible
    ? weight * (coverage * 0.6 + density * 0.25 + Math.min(1, frequency) * 0.15)
    : 0;

  return {
    matches: mergeOverlapping(allMatches),
    hitCount: allMatches.length,
    coverage,
    density,
    phrasesMatched,
    score,
  };
}

/** 合并重叠 / 相邻的命中区间，避免一个字符被高亮两次 */
export function mergeOverlapping(matches: TextMatch[]): TextMatch[] {
  const sorted = [...matches].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: TextMatch[] = [];
  for (const item of sorted) {
    const last = merged[merged.length - 1];
    if (last && item.start <= last.end) {
      if (item.end > last.end) merged[merged.length - 1] = { ...last, end: item.end };
    } else {
      merged.push({ ...item });
    }
  }
  return merged;
}

/**
 * 从正文命中位置截取带上下文的摘要。
 *
 * 每条摘要以一次命中为中心、左右各取 contextChars 个字；
 * 落在同一窗口内的多次命中合并成一条。最多返回 limit 条，按命中位置排序。
 */
export function buildSnippets(
  text: string,
  matches: TextMatch[],
  options: { contextChars?: number; limit?: number } = {},
): Array<{ start: number; end: number; matched: TextMatch[] }> {
  const contextChars = options.contextChars ?? 24;
  const limit = options.limit ?? 3;
  if (!matches.length) return [];

  const windows = matches.map((item) => ({
    start: Math.max(0, item.start - contextChars),
    end: Math.min(text.length, item.end + contextChars),
    seed: item,
  }));

  // 按起点排序后合并相交 / 相邻（间距小于半个窗口）的窗口
  windows.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number; matched: TextMatch[] }> = [];
  for (const window of windows) {
    const last = merged[merged.length - 1];
    if (last && window.start <= last.end + Math.round(contextChars / 2)) {
      last.end = Math.max(last.end, window.end);
      last.matched.push(window.seed);
    } else {
      merged.push({ start: window.start, end: window.end, matched: [window.seed] });
    }
  }
  for (const item of merged) item.matched = mergeOverlapping(item.matched);

  // 摘要数量有限时，优先保留命中次数多的窗口（仍然按位置返回）
  const picked = merged
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.matched.length - a.item.matched.length || a.index - b.index)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map(({ item }) => item);

  return picked;
}
