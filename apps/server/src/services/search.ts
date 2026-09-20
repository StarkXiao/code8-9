import {
  buildSnippets,
  parseSearchQuery,
  scoreField,
  type AudioSearchResponse,
  type AudioSearchResultDto,
  type AudioSearchSnippet,
} from '@froa/shared';
import { prisma } from '../db/client';
import { ApiError } from '../lib/errors';
import { getMembership } from './access';
import { toAudioDto } from './serialize';

/** 片段标签是二手概括，相关度权重低于转写正文 */
const CLIP_LABEL_WEIGHT = 0.6;
/** 单条语音最多保留几段摘要 */
const MAX_SNIPPETS = 3;
/** 最多返回多少条语音（家庭体量下足够；再多说明关键词太泛） */
const MAX_RESULTS = 100;

export interface SearchAudioInput {
  userId: string;
  workspaceId: string;
  q: string;
  recipeId?: string;
  kind?: string;
  includeDeleted: boolean;
}

/**
 * 在一个家庭空间的全部语音里做关键词检索，按匹配程度从高到低返回。
 *
 * 隔离边界与 GET /audio 一致：必须是空间成员；指定 recipeId 时还要确认
 * 食谱属于该空间，防止用别的空间的 recipeId 试探数据是否存在。
 */
export async function searchAudio(input: SearchAudioInput): Promise<AudioSearchResponse> {
  const membership = await getMembership(input.userId, input.workspaceId);

  if (input.recipeId) {
    const recipe = await prisma.recipe.findUnique({
      where: { id: input.recipeId },
      select: { id: true, workspaceId: true },
    });
    if (!recipe || recipe.workspaceId !== membership.workspaceId) {
      throw new ApiError('VALIDATION_FAILED', '该食谱不属于这个家庭空间');
    }
  }

  const query = parseSearchQuery(input.q);
  if (!query.terms.length) {
    return { query: input.q.trim(), terms: [], results: [], scanned: 0 };
  }

  const audios = await prisma.audioAttachment.findMany({
    where: {
      workspaceId: membership.workspaceId,
      ...(input.recipeId ? { recipeId: input.recipeId } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.includeDeleted ? {} : { deletedAt: null }),
    },
    include: {
      clips: true,
      recipe: { select: { id: true, title: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const results: AudioSearchResultDto[] = [];

  for (const audio of audios) {
    const transcript = audio.transcript ?? '';
    const transcriptField = transcript
      ? scoreField(transcript, query, 1)
      : { score: 0, matches: [], hitCount: 0, coverage: 0, density: 0, phrasesMatched: true };

    // 片段标签也属于语音内容：转写还没做时，靠标签照样能搜到那句话
    let clipScore = 0;
    let clipHitCount = 0;
    let clipPhraseMatched = false;
    const labelMatchedTerms = new Set<string>();
    const clipLabelHits: AudioSearchResultDto['clipLabelHits'] = [];
    for (const clip of audio.clips) {
      if (!clip.label) continue;
      const field = scoreField(clip.label, query, CLIP_LABEL_WEIGHT);
      if (field.hitCount === 0) continue;
      clipScore += field.score;
      clipHitCount += field.hitCount;
      clipPhraseMatched = clipPhraseMatched || field.phrasesMatched;
      for (const item of field.matches) labelMatchedTerms.add(item.term);
      clipLabelHits.push({
        clipId: clip.id,
        label: clip.label,
        matched: field.matches.map((item) => ({ start: item.start, end: item.end })),
        startMs: clip.startMs,
        endMs: clip.endMs,
      });
    }

    // 带引号的短语必须在正文或某个标签里完整出现，否则整条不算命中
    const phraseOk =
      query.phrases.length === 0 || transcriptField.phrasesMatched || clipPhraseMatched;

    if ((transcriptField.hitCount === 0 && clipHitCount === 0) || !phraseOk) continue;

    const transcriptSnippets: AudioSearchSnippet[] = buildSnippets(
      transcript,
      transcriptField.matches,
      { limit: MAX_SNIPPETS },
    ).map((snippet) => ({
      text: transcript.slice(snippet.start, snippet.end),
      matched: snippet.matched.map((item) => ({
        start: item.start - snippet.start,
        end: item.end - snippet.start,
      })),
      ...approxWindowMs(audio.durationMs, transcript.length, snippet.start, snippet.end),
      clipId: findOverlappingClip(audio.clips, audio.durationMs, transcript.length, snippet.start, snippet.end),
    }));

    const transcriptMatchedTerms = new Set(transcriptField.matches.map((item) => item.term));
    const matchedTerms = query.terms.filter(
      (term) => transcriptMatchedTerms.has(term) || labelMatchedTerms.has(term),
    );

    results.push({
      audio: toAudioDto(audio),
      recipe: { id: audio.recipe.id, title: audio.recipe.title },
      score: transcriptField.score + clipScore,
      hitCount: transcriptField.hitCount + clipHitCount,
      matchedTerms,
      transcriptSnippets,
      clipLabelHits,
    });
  }

  // 匹配程度从高到低；同分时命中次数多的在前，再同分保留时间倒序
  results.sort(
    (a, b) =>
      b.score - a.score ||
      b.hitCount - a.hitCount ||
      (a.audio.createdAt < b.audio.createdAt ? 1 : -1),
  );

  return {
    query: input.q.trim(),
    terms: query.terms,
    results: results.slice(0, MAX_RESULTS),
    scanned: audios.length,
  };
}

/**
 * 转写没有逐字时间轴，用字符位置按比例估算音频时间。
 * 假设口述语速大致均匀 —— 只是"跳到那句话附近"，精确区间交给已框选片段。
 */
function approxWindowMs(
  durationMs: number,
  textLength: number,
  startChar: number,
  endChar: number,
): { approxStartMs: number | null; approxEndMs: number | null } {
  if (durationMs <= 0 || textLength <= 0) {
    return { approxStartMs: null, approxEndMs: null };
  }
  return {
    approxStartMs: Math.round((startChar / textLength) * durationMs),
    approxEndMs: Math.min(durationMs, Math.round((endChar / textLength) * durationMs)),
  };
}

/** 摘要对应的字符区间是否落在某个已框选片段内；是则返回片段 id 供精确回放 */
function findOverlappingClip(
  clips: { id: string; startMs: number; endMs: number }[],
  durationMs: number,
  textLength: number,
  startChar: number,
  endChar: number,
): string | null {
  if (durationMs <= 0 || textLength <= 0) return null;
  const startMs = (startChar / textLength) * durationMs;
  const endMs = (endChar / textLength) * durationMs;
  const hit = clips.find((clip) => clip.startMs < endMs && clip.endMs > startMs);
  return hit?.id ?? null;
}
