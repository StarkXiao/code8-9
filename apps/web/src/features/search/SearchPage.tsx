import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, Empty, Input, Spin, Tag, Typography } from 'antd';
import { PlayCircleOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import type { AudioKind, AudioSearchResultDto } from '@froa/shared';
import { searchApi } from '../../api/endpoints';
import { useAudioPlayback } from '../../hooks/useAudioPlayback';
import { formatMs } from '../../components/Waveform';

const KIND_LABELS: Record<AudioKind, string> = {
  recipe_voice: '长辈口述',
  answer_voice: '回答追问',
  verification_voice: '复做记录',
  note_voice: '补充备注',
};

/**
 * 语音检索 —— 对空间里全部语音的转写文本做关键词检索。
 *
 * 搜"糖"就能定位到每一段提到它的原声：
 * 结果按命中次数从高到低排列，每条命中带上下文，
 * 点播放键会从按文字位置折算的大致时间点开始回放。
 */
export function SearchPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { playAudio } = useAudioPlayback();
  const [keyword, setKeyword] = useState('');
  const [submitted, setSubmitted] = useState('');

  const results = useQuery({
    queryKey: ['audio-search', workspaceId, submitted],
    queryFn: () => searchApi.audio({ q: submitted, workspaceId }),
    enabled: Boolean(workspaceId && submitted),
  });

  const search = () => {
    const q = keyword.trim();
    if (q) setSubmitted(q);
  };

  const playHit = (result: AudioSearchResultDto, approxStartMs: number | null) => {
    playAudio(result.audio, {
      startMs: approxStartMs ?? undefined,
      label: `「${submitted}」· ${result.recipe.title}`,
    });
  };

  return (
    <div className="froa-stack">
      <div className="froa-page-title">
        <div>
          <h1>语音检索</h1>
          <div className="froa-hint">
            对全部语音的转写内容做关键词检索，命中越多排得越前。
            点击命中片段可从大致位置回放原声（按文字位置折算，可能略有偏差）。
          </div>
        </div>
      </div>

      <Input.Search
        size="large"
        placeholder='搜"糖"试试：定位到每一句提到它的原声'
        prefix={<SearchOutlined />}
        value={keyword}
        onChange={(event) => setKeyword(event.target.value)}
        onSearch={search}
        enterButton="检索"
        aria-label="检索关键词"
      />

      {submitted && results.isLoading && <Spin size="large" />}

      {submitted && results.isSuccess && results.data.length === 0 && (
        <Empty description={`没有在任何语音里找到「${submitted}」`} />
      )}

      {(results.data ?? []).map((result) => (
        <div key={result.audio.id} className="froa-card">
          <div className="froa-row" style={{ justifyContent: 'space-between' }}>
            <div className="froa-row">
              <Link to={`/w/${workspaceId}/recipes/${result.recipe.id}`}>
                <strong>{result.recipe.title}</strong>
              </Link>
              <Tag>{KIND_LABELS[result.audio.kind] ?? result.audio.kind}</Tag>
              <Typography.Text type="secondary" style={{ fontSize: '0.85rem' }}>
                {result.audio.createdAt.slice(0, 16).replace('T', ' ')}
              </Typography.Text>
            </div>
            <Tag color="volcano">匹配 {result.matchCount} 处</Tag>
          </div>

          <div style={{ marginTop: '0.6rem' }}>
            {result.matches.map((hit) => (
              <div key={hit.start} className="froa-search-hit">
                <Button
                  type="text"
                  size="small"
                  icon={<PlayCircleOutlined style={{ color: '#8c4a24' }} />}
                  aria-label={`从约 ${formatMs(hit.approxStartMs ?? 0)} 处播放`}
                  onClick={() => playHit(result, hit.approxStartMs)}
                />
                <span className="froa-search-hit-text">
                  …{hit.before}
                  <mark>{hit.match}</mark>
                  {hit.after}…
                </span>
                {hit.approxStartMs !== null && (
                  <Typography.Text type="secondary" style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
                    约 {formatMs(hit.approxStartMs)}
                  </Typography.Text>
                )}
              </div>
            ))}
            {result.matchCount > result.matches.length && (
              <div className="froa-hint" style={{ marginTop: '0.35rem' }}>
                其余 {result.matchCount - result.matches.length} 处命中未展开
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
