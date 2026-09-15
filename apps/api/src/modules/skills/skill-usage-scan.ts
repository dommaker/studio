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
 * 幂等：WU done 重发只产重复事件，聚合侧（skill-demotion.ts）按
 * (skill, workUnitId) 去重吸收，不加哨兵。
 *
 * 宽口径说明：agent 在文本中提及路径而未真读也算命中（罕见，接受）；数据积累后
 * 如需收紧另议。
 */
import { eventBus, logger, writeStudioEvent } from '@dommaker/studio-shared';
import { readTranscript } from '../transcripts/transcript-archive.js';
import type { WorkUnitData } from '../workunit/workunit.service.js';

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

  /** 订阅 workunit.status_changed（done 触发）。幂等。 */
  subscribeToEvents(): void {
    if (this.subscribed) return;
    this.subscribed = true;

    eventBus.subscribe('workunit.status_changed', (payload: { workunit: WorkUnitData }) => {
      const wu = payload.workunit;
      if (!wu || wu.status !== 'done') return;
      // fire-and-forget：扫描/写事件绝不 await 阻断收尾订阅链
      void this.scan(wu).catch(err =>
        logger.warn('[SkillUsageScan] scan failed (non-blocking)', { wuId: wu.id, error: String(err) }),
      );
    });
  }

  /**
   * 扫一个 WU 的归档 transcript，每命中 skill 发射一条 knowledge:skill_used
   * （channel=transcript，level=info signal——提级后归信号档：热 30 天 → 月度 gz 归档，
   * 不再随噪声 7 天滚动删除）。返回命中名单（测试/观测用）。
   */
  async scan(wu: WorkUnitData): Promise<string[]> {
    const entries = await readTranscript(wu.id);
    const text = entries.map(e => e.rawOutput ?? '').join('\n');
    const names = extractUsedSkillNames(text);
    for (const skillName of names) {
      await writeStudioEvent('knowledge:skill_used', {
        skillName,
        workUnitId: wu.id,
        channel: 'transcript',
      }, { source: 'skill-usage-scan', level: 'info' }).catch(err => {
        logger.warn('[SkillUsageScan] emit skill_used failed', { wuId: wu.id, skillName, error: String(err) });
        return false;
      });
    }
    if (names.length > 0) {
      logger.info('[SkillUsageScan] skill usage emitted', { wuId: wu.id, skills: names });
    }
    return names;
  }
}

// 单例（懒初始化，形态同 initWuCompletionExtraction）
let _scanner: SkillUsageScanner | null = null;

export function initSkillUsageScan(): SkillUsageScanner {
  if (!_scanner) _scanner = new SkillUsageScanner();
  _scanner.subscribeToEvents();
  return _scanner;
}
