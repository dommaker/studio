/**
 * skill-usage-scan — transcript 后验使用扫描（skill 度量地基票 B，usage 主口径）。
 *
 * 背景：skill_used 仅靠 loadSkill 发射测不准——注入段/MANIFEST 直接给 SKILL.md
 * 路径，agent 可 Read/cat 绕开 MCP 工具（渠道旁路）；且 cache 命中路径历史上
 * 不发射（票 A 已修）。本扫描把「使用」定义为**获取全文、渠道无关**：agent 读
 * 文件必在 rawOutput 留痕（Read 调用 / cat 命令 / 路径引用），rawOutput 是
 * provider 无关的既有归档产物（transcript-archive.ts）。
 *
 * 形态：eventBus 钩子（仿 completion-extraction / distill-runtime），
 * 纯确定性、零 LLM、无预算熔断；fire-and-forget 不阻断收尾订阅链。
 *
 * 幂等：只在真实迁入 done 时扫描；done 上补证据（previousStatus=done）不触发。
 * 旧事件缺 previousStatus 时保持原触发兼容，聚合侧仍按 (skill, workUnitId) 去重。
 * #712：skill-usage 独立 watermark 只读 committed 增量；事件全部写成功才推进，启动续扫恢复。
 *
 * 宽口径说明：agent 在文本中提及路径而未真读也算命中（罕见，接受）；数据积累后
 * 如需收紧另议。
 */
import { eventBus, FileStore, writeStudioEvent } from '@dommaker/studio-shared';
import { consumeTranscript, reconcileTranscriptAssignments } from '../transcripts/index.js';
import type { WorkUnitData } from '../workunit/index.js';
import { getStore } from '../../core/store.js';
import { logger } from '@dommaker/studio-shared/node';

/**
 * skill 全文路径痕迹：匹配 `skills/<name>/SKILL.md`（绝对/相对路径均可命中）。
 * name 首字符限 [a-z0-9]：_ 前缀目录（_deprecated 等，manifest-loader 同口径）不计入。
 */
const SKILL_PATH_RE = /skills\/([a-z0-9][a-z0-9-]*)\/SKILL\.md/g;

/** 从文本中提取使用过的 skill 名（按名去重，保序） */
export function extractUsedSkillNames(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(SKILL_PATH_RE)) {
    names.add(m[1]);
  }
  return [...names];
}

export class SkillUsageScanner {
  private subscribed = false;

  constructor(private readonly fileStore: FileStore = getStore()) {}

  /** 订阅 workunit.status_changed（done 触发）。幂等。 */
  subscribeToEvents(): void {
    if (this.subscribed) return;
    this.subscribed = true;

    eventBus.subscribe('workunit.status_changed', (payload: { workunit: WorkUnitData; previousStatus?: string }) => {
      const wu = payload.workunit;
      if (!wu || wu.status !== 'done' || payload.previousStatus === 'done') return;
      // fire-and-forget：扫描/写事件绝不 await 阻断收尾订阅链
      void this.scan(wu).catch(err =>
        logger.warn('[SkillUsageScan] scan failed (non-blocking)', { wuId: wu.id, error: String(err) }),
      );
    });
  }

  /** 启动时续扫完成 WU；单个失败保留其水位，不阻断其他任务恢复。 */
  async recoverPending(): Promise<void> {
    const snapshots = await this.fileStore.listCurrentSnapshots();
    for (const snapshot of snapshots.filter(item => item.status === 'done')) {
      await this.scan({ id: snapshot.id } as WorkUnitData).catch(err =>
        logger.warn('[SkillUsageScan] recovery failed (non-blocking)', { wuId: snapshot.id, error: String(err) }));
    }
  }

  /**
   * 扫一个 WU 的 committed transcript，每命中 skill 发射一条 knowledge:skill_used。
   * 全部事件写成功后 consumeTranscript 才推进本消费者的独立水位。
   */
  async scan(wu: WorkUnitData): Promise<string[]> {
    const snapshot = (await this.fileStore.getIndex({ id: wu.id }))[0];
    if (snapshot) await reconcileTranscriptAssignments(snapshot);
    const result = await consumeTranscript(wu.id, 'skill-usage', async entries => {
      const text = entries.map(e => e.rawOutput ?? '').join('\n');
      const names = extractUsedSkillNames(text);
      for (const skillName of names) {
        const written = await writeStudioEvent('knowledge:skill_used', {
          skillName,
          workUnitId: wu.id,
          channel: 'transcript',
        }, { source: 'skill-usage-scan', level: 'info' }).catch(err => {
          logger.warn('[SkillUsageScan] emit skill_used failed', { wuId: wu.id, skillName, error: String(err) });
          throw err;
        });
        if (!written) throw new Error(`skill_used write failed: ${skillName}`);
      }
      if (names.length > 0) {
        logger.info('[SkillUsageScan] skill usage emitted', { wuId: wu.id, skills: names });
      }
      return names;
    });
    return result.value;
  }
}

// 单例（懒初始化，形态同 initWuCompletionExtraction）
let _scanner: SkillUsageScanner | null = null;

export function initSkillUsageScan(): SkillUsageScanner {
  if (!_scanner) _scanner = new SkillUsageScanner();
  _scanner.subscribeToEvents();
  void _scanner.recoverPending().catch(err =>
    logger.warn('[SkillUsageScan] startup recovery failed (non-blocking)', { error: String(err) }));
  return _scanner;
}
