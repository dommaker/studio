// channelAutocompleteGroups（#691 自 ChannelInput 抽出）：@/# 两弹框的候选分组构建器——
// 过滤口径与渲染行在此单点化，useAutocompletePopup 状态机经 getGroups 注入调用。
// @ 弹框：Agents 组 = 名称 includes 过滤；Files 组 = 频道词表路径后缀精确匹配（#248 D9，
// 决策 #249 §5），空 query 不献文件候选（防全量刷屏），词表缺键 → 无文件候选（静默降级，
// 不影响 agent 组），FILE_CANDIDATE_CAP 封顶。文件选中插入纯路径文本（不带 @——mention
// 正则会误吃文件名触发派发），台账登记走 onFileRef 回调。
// # 弹框（#638）：query 小写 includes 匹配 pmoNumber 或 title；缺键/空数组 → 无候选
// （fail-closed 不出弹框）；选中插入 `#PMO-n ` 纯文本 token（带尾随空格，与后端
// req-binding PMO_TOKEN_RE 同形——发送时经既有 token 解析归属，无需结构化载体）。
import type { AgentProfile, ChannelPmoCandidate, FileRef } from '../../api/channel';
import type { AutocompleteGroup, AutocompleteItem } from '../../hooks/useAutocompletePopup';

/** 工程绝对路径 → basename（多仓同名文件消歧展示用，FileRefChips 同用） */
export function repoBasename(repo: string): string {
  return repo.split('/').filter(Boolean).pop() ?? repo;
}

/** 文件候选展示上限（词表可能数千条，弹框只给补全头部） */
const FILE_CANDIDATE_CAP = 20;

/** @ 弹框候选负载：agent 组 = AgentProfile，文件组 = FileRef */
export type MentionData = AgentProfile | FileRef;

/** 词表工程分片（channelDataStore.vocabulary[channelId].repos 的元素型） */
export interface VocabRepo {
  repo: string;
  files: string[];
}

export function buildMentionGroups(opts: {
  query: string;
  agents: AgentProfile[];
  vocabRepos: VocabRepo[] | undefined;
  /** 文件候选选中的台账登记（去重由回调方负责） */
  onFileRef: (ref: FileRef) => void;
}): AutocompleteGroup<MentionData>[] {
  const { query, agents, vocabRepos, onFileRef } = opts;
  const q = query.toLowerCase();
  const agentItems: AutocompleteItem<MentionData>[] = agents
    .filter(a => a.name.toLowerCase().includes(q))
    .map(a => ({ key: a.id, insertText: `@${a.name} `, data: a as MentionData }));
  const fileItems: AutocompleteItem<MentionData>[] = [];
  if (query) {
    for (const r of vocabRepos ?? []) {
      for (const p of r.files) {
        if (p.toLowerCase().endsWith(q)) {
          const ref: FileRef = { repo: r.repo, path: p };
          fileItems.push({
            key: `${r.repo}:${p}`,
            insertText: `${p} `,
            data: ref as MentionData,
            onPicked: () => onFileRef(ref),
          });
        }
        if (fileItems.length >= FILE_CANDIDATE_CAP) break;
      }
      if (fileItems.length >= FILE_CANDIDATE_CAP) break;
    }
  }
  return [
    {
      label: 'Agents',
      items: agentItems,
      renderItem: item => {
        const agent = item.data as AgentProfile;
        return (
          <>
            <span>@{agent.name}</span>
            {agent.description && <span className="mc-mention-desc">{agent.description}</span>}
          </>
        );
      },
    },
    {
      label: 'Files',
      items: fileItems,
      renderItem: item => {
        const file = item.data as FileRef;
        return (
          <>
            <span>{file.path}</span>
            <span className="mc-mention-repo">{repoBasename(file.repo)}</span>
          </>
        );
      },
    },
  ];
}

export function buildPmoGroups(opts: {
  query: string;
  /** 缺键（未拉到/失败）→ undefined；空数组/过滤后空 → 无候选 */
  pmoCandidates: ChannelPmoCandidate[] | undefined;
  /** 当前 PMO（候选项「当前」标记数据源） */
  currentPmo: ChannelPmoCandidate | null | undefined;
}): AutocompleteGroup<ChannelPmoCandidate>[] {
  const { query, pmoCandidates, currentPmo } = opts;
  const q = query.toLowerCase();
  const items: AutocompleteItem<ChannelPmoCandidate>[] = (pmoCandidates ?? [])
    .filter(c => c.pmoNumber.toLowerCase().includes(q) || c.title.toLowerCase().includes(q))
    .map(c => ({ key: c.id, insertText: `#${c.pmoNumber} `, data: c }));
  return [{
    label: 'PMO 项目',
    items,
    renderItem: item => (
      <>
        <span>#{item.data.pmoNumber} · {item.data.title}</span>
        {currentPmo?.id === item.data.id && <span className="mc-mention-desc">当前</span>}
      </>
    ),
  }];
}
