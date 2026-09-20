import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  App as AntApp,
  Button,
  Empty,
  Input,
  Segmented,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { AudioOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import {
  AUDIO_KINDS,
  type AudioAttachmentDto,
  type AudioSearchSnippet,
} from '@froa/shared';
import { audioApi } from '../../api/endpoints';
import { errorMessage } from '../../api/client';
import { formatMs } from '../../components/Waveform';
import { useAudioPlayback } from '../../hooks/useAudioPlayback';

const KIND_LABELS: Record<string, string> = {
  recipe_voice: '长辈口述',
  answer_voice: '回答追问',
  verification_voice: '复做反馈',
  note_voice: '补充备注',
};

/**
 * 语音检索 —— 对空间内全部语音内容做关键词检索。
 *
 * 搜"糖"就能把所有提到糖的语音找出来：匹配转写正文，也匹配人工框选片段的
 * 标签；服务端按匹配程度打分排序，每条结果给出带高亮的上下文，点一下直接
 * 跳到那句话的位置播放（有框选片段时精确回放片段，否则按字符比例近似跳转）。
 */
export function VoiceSearchPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { message } = AntApp.useApp();
  const { playAudio } = useAudioPlayback();

  const [input, setInput] = useState('');
  // 真正发请求的查询词与输入框分离：停手 300ms 才检索，避免每敲一个字打一次接口
  const [submitted, setSubmitted] = useState('');
  const [kind, setKind] = useState<string>('all');

  useEffect(() => {
    const timer = window.setTimeout(() => setSubmitted(input.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [input]);

  const result = useQuery({
    queryKey: ['audio-search', workspaceId, submitted, kind],
    queryFn: () =>
      audioApi.search({
        workspaceId: workspaceId!,
        q: submitted,
        ...(kind === 'all' ? {} : { kind }),
      }),
    enabled: Boolean(workspaceId && submitted),
  });

  useEffect(() => {
    if (result.error) message.error(errorMessage(result.error));
  }, [result.error, message]);

  const totalHits = useMemo(
    () => (result.data?.results ?? []).reduce((sum, item) => sum + item.hitCount, 0),
    [result.data],
  );

  return (
    <div className="froa-stack">
      <div className="froa-page-title">
        <div>
          <h1>语音检索</h1>
          <div className="froa-hint">
            在本空间全部语音的转写与片段标签里查找关键词，结果按匹配程度从高到低排列，
            点播放即可跳到那句话。
          </div>
        </div>
      </div>

      <div className="froa-card froa-search-bar">
        <Input
          size="large"
          allowClear
          prefix={<SearchOutlined />}
          placeholder={'搜关键词，例如：糖｜多个词用空格隔开：糖 炒色｜整句用引号："一点糖"'}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onPressEnter={() => setSubmitted(input.trim())}
          aria-label="语音关键词"
        />
        <Segmented
          value={kind}
          onChange={(value) => setKind(String(value))}
          options={[
            { label: '全部类型', value: 'all' },
            ...AUDIO_KINDS.map((value) => ({ label: KIND_LABELS[value] ?? value, value })),
          ]}
        />
      </div>

      {!submitted ? (
        <Empty description="输入关键词开始检索，例如「糖」「火候」「筷子」" />
      ) : result.isLoading ? (
        <div className="froa-center-page">
          <Spin size="large" tip="正在检索全部语音…" />
        </div>
      ) : !result.data || result.data.results.length === 0 ? (
        <Empty
          description={
            <span>
              在 {result.data?.scanned ?? 0} 条语音里没有找到「{submitted}」。
              <br />
              可能是相关语音还没转写 —— 去录音工作台补上文字后就能搜到。
            </span>
          }
        />
      ) : (
        <div className="froa-stack">
          <Typography.Text type="secondary">
            「{result.data.query}」在 {result.data.scanned} 条语音中命中{' '}
            <strong>{result.data.results.length}</strong> 条、共 {totalHits} 处
            {result.data.terms.length > 1 ? `（匹配词：${result.data.terms.join('、')}）` : ''}
          </Typography.Text>

          {result.data.results.map((item) => (
            <div className="froa-card froa-search-result" key={item.audio.id}>
              <div className="froa-search-result-head">
                <Space size="small" wrap>
                  <Link
                    to={`/w/${workspaceId}/recipes/${item.recipe.id}`}
                    className="froa-search-recipe"
                  >
                    {item.recipe.title}
                  </Link>
                  <Tag>{KIND_LABELS[item.audio.kind] ?? item.audio.kind}</Tag>
                  <span className="froa-hint">时长 {formatMs(item.audio.durationMs)}</span>
                  {item.audio.transcriptStatus !== 'done' && (
                    <Tooltip title="这条语音没有正式转写，命中可能来自片段标签">
                      <Tag color="orange">转写不完整</Tag>
                    </Tooltip>
                  )}
                </Space>
                <Tooltip title={`相关度 ${item.score.toFixed(2)} · 命中 ${item.hitCount} 处`}>
                  <Tag color="red">相关度 {Math.round(item.score * 100)}</Tag>
                </Tooltip>
              </div>

              <div className="froa-stack" style={{ gap: '0.5rem', marginTop: '0.5rem' }}>
                {item.transcriptSnippets.map((snippet, index) => (
                  <SnippetRow
                    key={index}
                    audio={item.audio}
                    snippet={snippet}
                    playAudio={playAudio}
                  />
                ))}

                {item.clipLabelHits.map((hit) => (
                  <div className="froa-search-hit-row" key={hit.clipId}>
                    <Button
                      size="small"
                      type="primary"
                      ghost
                      icon={<AudioOutlined />}
                      onClick={() =>
                        playAudio(item.audio, {
                          startMs: hit.startMs,
                          endMs: hit.endMs,
                          label: `片段：${hit.label}`,
                        })
                      }
                    >
                      {formatMs(hit.startMs)} – {formatMs(hit.endMs)}
                    </Button>
                    <span className="froa-search-context">
                      <Tag color="blue" style={{ marginInlineEnd: 6 }}>
                        片段标签
                      </Tag>
                      <Highlight text={hit.label} ranges={hit.matched} />
                    </span>
                  </div>
                ))}

                {item.transcriptSnippets.length === 0 && item.clipLabelHits.length === 0 && (
                  <Typography.Text type="secondary">命中（详情不可用）</Typography.Text>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SnippetRow({
  audio,
  snippet,
  playAudio,
}: {
  audio: AudioAttachmentDto;
  snippet: AudioSearchSnippet;
  playAudio: ReturnType<typeof useAudioPlayback>['playAudio'];
}) {
  const canSeek = snippet.approxStartMs !== null;
  return (
    <div className="froa-search-hit-row">
      <Button
        size="small"
        type="primary"
        ghost
        icon={<AudioOutlined />}
        disabled={!canSeek}
        onClick={() =>
          playAudio(audio, {
            startMs: snippet.approxStartMs ?? undefined,
            endMs: snippet.approxEndMs ?? undefined,
            label: snippet.clipId ? '命中的原声片段' : '命中位置附近',
          })
        }
      >
        {canSeek ? formatMs(snippet.approxStartMs!) : '位置未知'}
      </Button>
      <span className="froa-search-context">
        <Highlight text={snippet.text} ranges={snippet.matched} />
      </span>
      {snippet.clipId && <Tag color="green">落在已框选片段</Tag>}
    </div>
  );
}

/**
 * 按区间把命中部分包成 <mark>。区间来自服务端对同一段文本的切片，
 * 直接按下标切即可，不需要再做字符串匹配。
 */
function Highlight({ text, ranges }: { text: string; ranges: Array<{ start: number; end: number }> }) {
  if (!ranges.length) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  for (const [index, range] of sorted.entries()) {
    if (range.start < cursor) continue;
    if (range.start > cursor) parts.push(text.slice(cursor, range.start));
    parts.push(<mark key={index}>{text.slice(range.start, range.end)}</mark>);
    cursor = range.end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}
