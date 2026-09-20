/**
 * 语音关键词检索接口集成测试。
 *
 * 覆盖：
 * - 搜"糖"能跨全部语音命中，且按匹配程度从高到低排序；
 * - 命中片段可定位（摘要带字符区间与近似时间，标签命中带精确毫秒区间）；
 * - 检索隔离在空间内：别的家庭的语音、非成员访问都必须被挡住；
 * - 没转写的语音靠片段标签也能搜到；软删除音频默认仍可检索。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { prisma } from '../src/db/client';

const app = createApp();

interface Session {
  token: string;
  userId: string;
}

async function register(email: string, displayName: string): Promise<Session> {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'froa12345', displayName })
    .expect(201);
  return {
    token: response.body.data.tokens.accessToken as string,
    userId: response.body.data.user.id as string,
  };
}

const auth = (session: Session) => ({ Authorization: `Bearer ${session.token}` });

function fakeWav(seconds = 1): Buffer {
  const sampleRate = 8000;
  const samples = sampleRate * seconds;
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

async function uploadAudio(
  session: Session,
  recipeId: string,
  kind = 'recipe_voice',
): Promise<string> {
  const response = await request(app)
    .post('/api/audio')
    .set(auth(session))
    .field('recipeId', recipeId)
    .field('kind', kind)
    .field('durationMs', '100000')
    .field('peaks', JSON.stringify([0.1, 0.6]))
    .attach('file', fakeWav(), { filename: 'voice.wav', contentType: 'audio/wav' })
    .expect(201);
  return response.body.data.id as string;
}

async function setTranscript(session: Session, audioId: string, transcript: string) {
  await request(app)
    .patch(`/api/audio/${audioId}/transcript`)
    .set(auth(session))
    .send({ transcript })
    .expect(200);
}

async function createClip(
  session: Session,
  audioId: string,
  label: string,
  startMs: number,
  endMs: number,
): Promise<string> {
  const response = await request(app)
    .post(`/api/audio/${audioId}/clips`)
    .set(auth(session))
    .send({ startMs, endMs, label })
    .expect(201);
  return response.body.data.id as string;
}

async function createWorkspace(session: Session, name: string): Promise<string> {
  const response = await request(app)
    .post('/api/workspaces')
    .set(auth(session))
    .send({ name })
    .expect(201);
  return response.body.data.id as string;
}

async function createRecipe(session: Session, workspaceId: string, title: string): Promise<string> {
  const response = await request(app)
    .post('/api/recipes')
    .set(auth(session))
    .send({ workspaceId, title })
    .expect(201);
  return response.body.data.id as string;
}

describe('语音关键词检索', () => {
  let me: Session;
  let outsider: Session;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let recipeId: string;
  let otherRecipeId: string;
  let manySugarAudioId = '';
  let oneSugarAudioId = '';
  let noTranscriptLabelHitAudioId = '';
  let softDeletedAudioId = '';

  beforeAll(async () => {
    me = await register('searcher@e2e.test', '整理者');
    outsider = await register('search-outsider@e2e.test', '外人');

    workspaceId = await createWorkspace(me, '检索测试厨房');
    otherWorkspaceId = await createWorkspace(outsider, '别人家的厨房');
    recipeId = await createRecipe(me, workspaceId, '红烧肉');
    otherRecipeId = await createRecipe(outsider, otherWorkspaceId, '糖醋里脊');

    // 命中 4 次：相关度应当最高
    manySugarAudioId = await uploadAudio(me, recipeId);
    await setTranscript(me, manySugarAudioId, '先放糖，糖化开变成糖色，全程小火，糖色炒到枣红色');

    // 命中 1 次，且文本很长（密度低）：排在后面
    oneSugarAudioId = await uploadAudio(me, recipeId);
    await setTranscript(
      me,
      oneSugarAudioId,
      `今天做一道工序非常复杂的菜，${'准'.repeat(60)}备齐各种食材之后最后只需要放少量的糖即可`,
    );

    // 没有转写正文，但片段标签命中 —— 标签也必须能搜到
    noTranscriptLabelHitAudioId = await uploadAudio(me, recipeId, 'answer_voice');
    await createClip(me, noTranscriptLabelHitAudioId, '外婆补充：糖放一点点', 5000, 12000);

    // 另一个家庭提到糖的语音：隔离边界之外，绝不能出现在结果里
    const outsiderAudioId = await uploadAudio(outsider, otherRecipeId);
    await setTranscript(outsider, outsiderAudioId, '这道菜要放糖放糖放糖');

    // 软删除的音频：默认检索仍然包含（证据永久保留）
    softDeletedAudioId = await uploadAudio(me, recipeId, 'note_voice');
    await setTranscript(me, softDeletedAudioId, '备注一句：糖别放多了');
    await request(app).delete(`/api/audio/${softDeletedAudioId}`).set(auth(me)).expect(200);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('搜"糖"命中全部相关语音，并按匹配程度从高到低排序', async () => {
    const response = await request(app)
      .get('/api/audio/search')
      .set(auth(me))
      .query({ workspaceId, q: '糖' })
      .expect(200);

    const body = response.body.data;
    expect(body.terms).toEqual(['糖']);
    expect(body.scanned).toBeGreaterThanOrEqual(4);

    const ids = body.results.map((item: { audio: { id: string } }) => item.audio.id);
    expect(ids).toContain(manySugarAudioId);
    expect(ids).toContain(oneSugarAudioId);
    expect(ids).toContain(noTranscriptLabelHitAudioId);
    expect(ids).toContain(softDeletedAudioId);

    // 别人家的语音绝不能出现
    const titles = body.results.map((item: { recipe: { title: string } }) => item.recipe.title);
    expect(titles).not.toContain('糖醋里脊');

    // 排序断言：多次命中 > 一次命中 > 仅标签命中
    const rankOf = (id: string) => ids.indexOf(id);
    expect(rankOf(manySugarAudioId)).toBeLessThan(rankOf(oneSugarAudioId));
    expect(rankOf(oneSugarAudioId)).toBeLessThan(rankOf(noTranscriptLabelHitAudioId));

    // 分数单调不增
    const scores = body.results.map((item: { score: number }) => item.score);
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
    }

    const top = body.results[0];
    expect(top.hitCount).toBe(4);
  });

  it('摘要带字符命中区间与近似时间，可直接定位到那句话', async () => {
    const response = await request(app)
      .get('/api/audio/search')
      .set(auth(me))
      .query({ workspaceId, q: '糖' })
      .expect(200);

    const top = response.body.data.results[0];
    expect(top.transcriptSnippets.length).toBeGreaterThan(0);
    const snippet = top.transcriptSnippets[0];
    // 摘要文本确实包含"糖"，且返回的区间落在摘要范围内
    for (const range of snippet.matched) {
      expect(snippet.text.slice(range.start, range.end)).toBe('糖');
    }
    // durationMs=100000 时按字符比例给出近似时间
    expect(snippet.approxStartMs).toBeGreaterThanOrEqual(0);
    expect(snippet.approxEndMs).toBeGreaterThanOrEqual(snippet.approxStartMs);
  });

  it('片段标签命中带精确的毫秒区间，用于回放原话', async () => {
    const response = await request(app)
      .get('/api/audio/search')
      .set(auth(me))
      .query({ workspaceId, q: '糖' })
      .expect(200);

    const item = response.body.data.results.find(
      (entry: { audio: { id: string } }) => entry.audio.id === noTranscriptLabelHitAudioId,
    );
    expect(item.transcriptSnippets).toHaveLength(0);
    expect(item.clipLabelHits).toHaveLength(1);
    expect(item.clipLabelHits[0]).toMatchObject({
      label: '外婆补充：糖放一点点',
      startMs: 5000,
      endMs: 12000,
    });
    expect(item.clipLabelHits[0].matched[0]).toEqual({ start: 5, end: 6 });
  });

  it('includeDeleted=false 时软删除音频不出现', async () => {
    const response = await request(app)
      .get('/api/audio/search')
      .set(auth(me))
      .query({ workspaceId, q: '糖', includeDeleted: 'false' })
      .expect(200);

    const ids = response.body.data.results.map((item: { audio: { id: string } }) => item.audio.id);
    expect(ids).not.toContain(softDeletedAudioId);
  });

  it('多关键词与短语检索：命中词更全的排前面，短语必须完整出现', async () => {
    const audioA = await uploadAudio(me, recipeId);
    // 两个词都出现
    await setTranscript(me, audioA, '先炒糖色：糖炒化后继续炒色，全程小火');
    const audioB = await uploadAudio(me, recipeId);
    // 只出现"糖"，不出现"炒色"
    await setTranscript(me, audioB, '放一点糖提鲜');

    const multi = await request(app)
      .get('/api/audio/search')
      .set(auth(me))
      .query({ workspaceId, q: '糖 炒色' })
      .expect(200);
    const multiIds = multi.body.data.results.map((item: { audio: { id: string } }) => item.audio.id);
    expect(multiIds[0]).toBe(audioA);
    expect(multiIds).toContain(audioB);

    const phrase = await request(app)
      .get('/api/audio/search')
      .set(auth(me))
      .query({ workspaceId, q: '"一点糖"' })
      .expect(200);
    const phraseIds = phrase.body.data.results.map((item: { audio: { id: string } }) => item.audio.id);
    expect(phraseIds).toContain(audioB);
    expect(phraseIds).not.toContain(audioA);
  });

  it('结果按食谱与类型可收窄', async () => {
    const byKind = await request(app)
      .get('/api/audio/search')
      .set(auth(me))
      .query({ workspaceId, q: '糖', kind: 'answer_voice' })
      .expect(200);
    for (const item of byKind.body.data.results) {
      expect(item.audio.kind).toBe('answer_voice');
    }
    expect(
      byKind.body.data.results.map((item: { audio: { id: string } }) => item.audio.id),
    ).toContain(noTranscriptLabelHitAudioId);

    // 别的空间的 recipeId 必须被拒
    await request(app)
      .get('/api/audio/search')
      .set(auth(me))
      .query({ workspaceId, q: '糖', recipeId: otherRecipeId })
      .expect(400);
  });

  it('权限与参数校验', async () => {
    // 非成员不能检索这个空间
    await request(app)
      .get('/api/audio/search')
      .set(auth(outsider))
      .query({ workspaceId, q: '糖' })
      .expect(403);

    // 未登录
    await request(app).get('/api/audio/search').query({ workspaceId, q: '糖' }).expect(401);

    // 空关键词
    await request(app)
      .get('/api/audio/search')
      .set(auth(me))
      .query({ workspaceId, q: '   ' })
      .expect(400);

    // 没命中返回空结果而不是报错
    const response = await request(app)
      .get('/api/audio/search')
      .set(auth(me))
      .query({ workspaceId, q: '绝对不存在的词xyz' })
      .expect(200);
    expect(response.body.data.results).toEqual([]);
  });
});
