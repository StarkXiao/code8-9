/**
 * 语音检索的纯函数单测 —— 覆盖查询解析、命中位置与相关度排序。
 */
import { describe, expect, it } from 'vitest';
import {
  buildSnippets,
  findTermMatches,
  mergeOverlapping,
  normalizeForSearch,
  parseSearchQuery,
  scoreField,
} from '@froa/shared';

describe('parseSearchQuery', () => {
  it('中文无空格时整体作为一个子串', () => {
    expect(parseSearchQuery('糖').terms).toEqual(['糖']);
    expect(parseSearchQuery('放糖').terms).toEqual(['放糖']);
  });

  it('空格拆成多个关键词，去重且保序', () => {
    const query = parseSearchQuery('糖 炒色 糖');
    expect(query.terms).toEqual(['糖', '炒色']);
    expect(query.phrases).toEqual([]);
  });

  it('英文引号与中文引号包起来的内容按短语处理，且大小写不敏感', () => {
    expect(parseSearchQuery('"一点糖"').phrases).toEqual(['一点糖']);
    expect(parseSearchQuery('“Brown Sugar”').phrases).toEqual(['brown sugar']);
  });

  it('归一化只折叠大小写，不改字符长度（偏移才能映射回原文）', () => {
    expect(normalizeForSearch('Brown糖')).toBe('brown糖');
    expect(normalizeForSearch('Brown糖').length).toBe('Brown糖'.length);
  });
});

describe('findTermMatches', () => {
  it('找出全部出现位置', () => {
    const matches = findTermMatches(normalizeForSearch('放糖、糖化开、再放糖'), '糖');
    expect(matches.map((m) => [m.start, m.end])).toEqual([
      [1, 2],
      [3, 4],
      [9, 10],
    ]);
  });

  it('找不到时返回空数组', () => {
    expect(findTermMatches('红烧肉', '糖')).toEqual([]);
  });
});

describe('scoreField —— 相关度排序', () => {
  it('命中次数多的文本相关度更高（密度也更高）', () => {
    const query = parseSearchQuery('糖');
    const oneHit = scoreField('放一点糖提鲜就行', query, 1);
    const manyHits = scoreField('放糖、糖化开、糖色炒好后再下肉，全靠糖', query, 1);
    expect(manyHits.score).toBeGreaterThan(oneHit.score);
    expect(manyHits.hitCount).toBe(4);
  });

  it('多词查询时，命中词更全的排在前面（覆盖率主导）', () => {
    const query = parseSearchQuery('糖 炒色');
    const onlySugar = scoreField('放一点糖', query, 1);
    const both = scoreField('先炒糖色：糖炒化后继续炒色到枣红', query, 1);
    expect(both.score).toBeGreaterThan(onlySugar.score);
    expect(onlySugar.coverage).toBeCloseTo(0.5);
    expect(both.coverage).toBeCloseTo(1);
  });

  it('同样命中一次时，短文本（命中更集中）排在长文本前面', () => {
    const query = parseSearchQuery('糖');
    const shortText = scoreField('放点糖', query, 1);
    const longText = scoreField('今天天气不错我们准备做一道工序非常复杂的菜首先要放糖', query, 1);
    expect(shortText.score).toBeGreaterThan(longText.score);
  });

  it('短语查询时，缺少完整短语的字段得 0 分', () => {
    const query = parseSearchQuery('"一点糖"');
    const phraseHit = scoreField('放一点糖就行', query, 1);
    const wordsSeparated = scoreField('糖放一点，再放点盐', query, 1);
    expect(phraseHit.score).toBeGreaterThan(0);
    expect(wordsSeparated.score).toBe(0);
  });

  it('片段标签字段权重低于正文权重', () => {
    const query = parseSearchQuery('糖');
    const text = '放一点糖';
    expect(scoreField(text, query, 0.6).score).toBeCloseTo(scoreField(text, query, 1).score * 0.6);
  });
});

describe('buildSnippets', () => {
  it('多次命中落在同一窗口时合并成一条摘要', () => {
    const text = '先炒糖色，糖化了之后下肉，糖要炒到枣红色，全程小火';
    const matches = findTermMatches(normalizeForSearch(text), '糖');
    const snippets = buildSnippets(text, matches, { contextChars: 10 });
    // 前两个"糖"相距很近，应合并；数量不超过命中数
    expect(snippets.length).toBeGreaterThan(0);
    expect(snippets.length).toBeLessThanOrEqual(matches.length);
    // 每条摘要都带至少一个命中，且偏移落在摘要范围内
    for (const snippet of snippets) {
      expect(snippet.matched.length).toBeGreaterThan(0);
      for (const item of snippet.matched) {
        expect(item.start).toBeGreaterThanOrEqual(snippet.start);
        expect(item.end).toBeLessThanOrEqual(snippet.end);
      }
    }
  });

  it('默认最多返回 3 条摘要', () => {
    // 命中之间拉开足够距离，避免上下文窗口把它们合并
    const text = Array.from({ length: 10 }, (_, index) => `${'肉'.repeat(99)}糖`).join('');
    const matches = findTermMatches(text, '糖');
    expect(matches).toHaveLength(10);
    expect(buildSnippets(text, matches)).toHaveLength(3);
  });
});

describe('mergeOverlapping', () => {
  it('重叠区间合并', () => {
    const merged = mergeOverlapping([
      { start: 0, end: 3, term: 'a' },
      { start: 2, end: 5, term: 'a' },
      { start: 8, end: 9, term: 'a' },
    ]);
    expect(merged.map((m) => [m.start, m.end])).toEqual([
      [0, 5],
      [8, 9],
    ]);
  });
});
