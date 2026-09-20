// 语音检索测试 —— 关键词命中、排序、隔离边界。
// 对应功能：对全部语音内容做关键词检索，按匹配程度从高到低呈现。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { prisma } from '../src/db/client';

const app = createApp();

interface Session {
  token: string;
  userId: string;
}

async function register(tag: string): Promise<Session> {
  const email = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@search.test`;
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'froa12345', displayName: tag })
    .expect(201);
  return {
    token: response.body.data.tokens.accessToken as string,
    userId: response.body.data.user.id as string,
  };
}

const auth = (session: Session) => ({ Authorization: `Bearer ${session.token}` });

function fakeWav(): Buffer {
  const sampleRate = 8000;
  const dataSize = sampleRate * 2;
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

/** 建一个独立空间 + 食谱，并上传一条带指定转写文本的语音 */
async function makeAudioWithTranscript(session: Session, transcript: string, title = '检索用食谱') {
  const ws = await request(app)
    .post('/api/workspaces')
    .set(auth(session))
    .send({ name: `空间-${Math.random().toString(36).slice(2, 8)}` })
    .expect(201);

  const recipe = await request(app)
    .post('/api/recipes')
    .set(auth(session))
    .send({ workspaceId: ws.body.data.id, title })
    .expect(201);

  const audio = await request(app)
    .post('/api/audio')
    .set(auth(session))
    .field('recipeId', recipe.body.data.id)
    .field('kind', 'recipe_voice')
    .field('durationMs', '10000')
    .attach('file', fakeWav(), { filename: 'v.wav', contentType: 'audio/wav' })
    .expect(201);

  await request(app)
    .patch(`/api/audio/${audio.body.data.id}/transcript`)
    .set(auth(session))
    .send({ transcript })
    .expect(200);

  return {
    workspaceId: ws.body.data.id as string,
    recipeId: recipe.body.data.id as string,
    audioId: audio.body.data.id as string,
  };
}

interface SearchResult {
  audio: { id: string; recipeId: string };
  recipe: { id: string; title: string };
  matchCount: number;
  matches: {
    start: number;
    end: number;
    before: string;
    match: string;
    after: string;
    approxStartMs: number | null;
  }[];
}

describe('语音检索：命中与排序', () => {
  let user: Session;
  // 三处命中 > 两处命中 > 一处命中 > 零命中（不应出现）
  let hit3: Awaited<ReturnType<typeof makeAudioWithTranscript>>;
  let hit2: Awaited<ReturnType<typeof makeAudioWithTranscript>>;
  let hit1: Awaited<ReturnType<typeof makeAudioWithTranscript>>;
  let hit0: Awaited<ReturnType<typeof makeAudioWithTranscript>>;

  beforeAll(async () => {
    user = await register('searcher');
    // 故意建在不同空间里：不指定范围时也必须全部搜到
    hit3 = await makeAudioWithTranscript(user, '先放糖炒化，再加一点糖，最后尝尝甜度，糖不能糊');
    hit2 = await makeAudioWithTranscript(user, '冰糖下锅，糖色炒到枣红');
    hit1 = await makeAudioWithTranscript(user, '起锅前撒一点糖提鲜');
    hit0 = await makeAudioWithTranscript(user, '只要一小撮盐就够了');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('搜"糖"能定位到所有相关语音，并按命中次数从高到低排列', async () => {
    const response = await request(app)
      .get('/api/search/audio')
      .query({ q: '糖' })
      .set(auth(user))
      .expect(200);

    const results = response.body.data as SearchResult[];
    const ids = results.map((r) => r.audio.id);

    expect(ids).toEqual([hit3.audioId, hit2.audioId, hit1.audioId]);
    expect(ids).not.toContain(hit0.audioId);
    expect(results.map((r) => r.matchCount)).toEqual([3, 2, 1]);
    expect(response.body.meta.q).toBe('糖');
    expect(response.body.meta.total).toBe(3);
  });

  it('每个命中片段都带上下文与大致播放位置', async () => {
    const response = await request(app)
      .get('/api/search/audio')
      .query({ q: '糖' })
      .set(auth(user))
      .expect(200);

    const [top] = response.body.data as SearchResult[];
    expect(top?.audio.id).toBe(hit3.audioId);
    expect(top?.matches).toHaveLength(3);

    const first = top!.matches[0]!;
    expect(first.match).toBe('糖');
    expect(first.before.endsWith('先放')).toBe(true);
    expect(first.after.startsWith('炒化')).toBe(true);
    // 时长 10000ms，按字符位置折算，必然落在 (0, 10000) 区间内
    expect(first.approxStartMs).toBeGreaterThan(0);
    expect(first.approxStartMs!).toBeLessThan(10000);
    // 片段按在文中出现的顺序排列
    expect(top!.matches[1]!.start).toBeGreaterThan(top!.matches[0]!.start);
  });

  it('没有命中时返回空数组', async () => {
    const response = await request(app)
      .get('/api/search/audio')
      .query({ q: '醋' })
      .set(auth(user))
      .expect(200);

    expect(response.body.data).toEqual([]);
    expect(response.body.meta.total).toBe(0);
  });

  it('限定 workspaceId 时只搜该空间', async () => {
    const response = await request(app)
      .get('/api/search/audio')
      .query({ q: '糖', workspaceId: hit1.workspaceId })
      .set(auth(user))
      .expect(200);

    const results = response.body.data as SearchResult[];
    expect(results).toHaveLength(1);
    expect(results[0]!.audio.id).toBe(hit1.audioId);
    expect(results[0]!.recipe.id).toBe(hit1.recipeId);
  });

  it('限定 recipeId 时只搜该食谱', async () => {
    const response = await request(app)
      .get('/api/search/audio')
      .query({ q: '糖', recipeId: hit3.recipeId })
      .set(auth(user))
      .expect(200);

    const results = response.body.data as SearchResult[];
    expect(results).toHaveLength(1);
    expect(results[0]!.matchCount).toBe(3);
  });

  it('软删除的语音不参与检索', async () => {
    await request(app).delete(`/api/audio/${hit1.audioId}`).set(auth(user)).expect(200);

    const response = await request(app)
      .get('/api/search/audio')
      .query({ q: '糖' })
      .set(auth(user))
      .expect(200);

    const ids = (response.body.data as SearchResult[]).map((r) => r.audio.id);
    expect(ids).toEqual([hit3.audioId, hit2.audioId]);
  });

  it('关键词缺失或纯空白都返回 400', async () => {
    await request(app).get('/api/search/audio').set(auth(user)).expect(400);
    await request(app).get('/api/search/audio').query({ q: '   ' }).set(auth(user)).expect(400);
  });
});

describe('语音检索：跨空间隔离', () => {
  let alice: Session;
  let bob: Session;
  let aliceData: Awaited<ReturnType<typeof makeAudioWithTranscript>>;

  beforeAll(async () => {
    alice = await register('search-alice');
    bob = await register('search-bob');
    aliceData = await makeAudioWithTranscript(alice, '红烧肉要放糖', '爱丽丝的红烧肉');
    // bob 也有自己的空间和语音，确保他不是"什么都搜不到"才通过
    await makeAudioWithTranscript(bob, '我只放盐不放糖', '鲍勃的菜');
  });

  it('检索结果里绝不能出现别人空间的语音', async () => {
    const response = await request(app)
      .get('/api/search/audio')
      .query({ q: '糖' })
      .set(auth(bob))
      .expect(200);

    const results = response.body.data as SearchResult[];
    expect(results.length).toBeGreaterThan(0);
    expect(results.map((r) => r.audio.id)).not.toContain(aliceData.audioId);
    expect(results.every((r) => r.audio.recipeId !== aliceData.recipeId)).toBe(true);
  });

  it('指定别人的 workspaceId / recipeId 直接 403', async () => {
    await request(app)
      .get('/api/search/audio')
      .query({ q: '糖', workspaceId: aliceData.workspaceId })
      .set(auth(bob))
      .expect(403);

    await request(app)
      .get('/api/search/audio')
      .query({ q: '糖', recipeId: aliceData.recipeId })
      .set(auth(bob))
      .expect(403);
  });

  it('未登录直接 401', async () => {
    await request(app).get('/api/search/audio').query({ q: '糖' }).expect(401);
  });
});
