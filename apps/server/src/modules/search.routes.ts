import { Router } from 'express';
import { audioSearchQuerySchema, type AudioSearchMatchDto } from '@froa/shared';
import { prisma } from '../db/client';
import { asyncHandler, send } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { queryOf, validateQuery } from '../middleware/validate';
import { assertRecipeRole, assertWorkspaceRole } from '../services/access';
import { toAudioDto } from '../services/serialize';

export const searchRouter: Router = Router();

searchRouter.use(requireAuth);

/** 命中词前后各带多少字上下文 */
const CONTEXT_CHARS = 30;
/** 单条语音最多返回多少个命中片段（matchCount 仍是完整计数） */
const MAX_MATCHES_PER_AUDIO = 20;
/** 参与打分的候选语音上限：家庭场景远低于此，只是防止极端情况下全表扫描 */
const MAX_CANDIDATES = 500;

/**
 * 在转写全文里找出关键词的所有出现位置（大小写不敏感，对中文无影响）。
 * 片段列表只展开前 MAX_MATCHES_PER_AUDIO 条，但计数是完整的。
 */
function findMatches(
  transcript: string,
  keyword: string,
  durationMs: number,
): { matches: AudioSearchMatchDto[]; total: number } {
  const haystack = transcript.toLowerCase();
  const needle = keyword.toLowerCase();
  const matches: AudioSearchMatchDto[] = [];
  let total = 0;

  let index = haystack.indexOf(needle);
  while (index !== -1) {
    total += 1;
    if (matches.length < MAX_MATCHES_PER_AUDIO) {
      const end = index + needle.length;
      matches.push({
        start: index,
        end,
        before: transcript.slice(Math.max(0, index - CONTEXT_CHARS), index),
        match: transcript.slice(index, end),
        after: transcript.slice(end, end + CONTEXT_CHARS),
        // 转写文本没有时间轴，按字符位置折算一个大致起点，让"点片段回放"有处可去
        approxStartMs:
          durationMs > 0 && transcript.length > 0
            ? Math.round((index / transcript.length) * durationMs)
            : null,
      });
    }
    index = haystack.indexOf(needle, index + needle.length);
  }

  return { matches, total };
}

/**
 * 对全部语音内容做关键词检索：搜"糖"就能定位到所有提到它的片段。
 *
 * - 范围与音频列表同一套隔离规则：指定 recipeId / workspaceId 就校验对应权限，
 *   否则只在"我参与的空间"里找 —— 绝不能把别人家的转写搜出来；
 * - 匹配程度 = 命中次数，从高到低呈现；命中数相同则新上传的在前
 *   （findMany 已按 createdAt desc 排好，Array.sort 稳定，次序不会乱）；
 * - 软删除的语音不参与检索（它只是被隐藏，引用它的结论仍可回放，但不该出现在检索结果里）。
 */
searchRouter.get(
  '/search/audio',
  validateQuery(audioSearchQuerySchema),
  asyncHandler(async (req, res) => {
    const { q, workspaceId, recipeId, limit } = queryOf(req, audioSearchQuerySchema);

    let scope: { recipeId: string } | { workspaceId: string } | { workspaceId: { in: string[] } };
    if (recipeId) {
      await assertRecipeRole(req.auth!.userId, recipeId, 'viewer');
      scope = { recipeId };
    } else if (workspaceId) {
      await assertWorkspaceRole(req.auth!.userId, workspaceId, 'viewer');
      scope = { workspaceId };
    } else {
      const memberships = await prisma.workspaceMember.findMany({
        where: { userId: req.auth!.userId },
        select: { workspaceId: true },
      });
      const workspaceIds = memberships.map((member) => member.workspaceId);
      if (!workspaceIds.length) {
        send(res, [], { q, total: 0 });
        return;
      }
      scope = { workspaceId: { in: workspaceIds } };
    }

    // contains 先让数据库把候选筛小（SQLite LIKE 对 ASCII 大小写不敏感，
    // 与 findMatches 的小写比较一致），精确计数与片段截取仍在应用层完成
    const candidates = await prisma.audioAttachment.findMany({
      where: {
        ...scope,
        deletedAt: null,
        transcript: { contains: q },
      },
      include: { recipe: { select: { id: true, title: true } } },
      orderBy: { createdAt: 'desc' },
      take: MAX_CANDIDATES,
    });

    const results = candidates
      .map((audio) => {
        const { matches, total } = findMatches(audio.transcript ?? '', q, audio.durationMs);
        return {
          audio: toAudioDto(audio),
          recipe: audio.recipe,
          matchCount: total,
          matches,
        };
      })
      .filter((result) => result.matchCount > 0)
      .sort((a, b) => b.matchCount - a.matchCount)
      .slice(0, limit);

    send(res, results, { q, total: results.length });
  }),
);
