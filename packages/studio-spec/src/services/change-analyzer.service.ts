/**
 * 变更分析服务
 * 
 * SP-002: Spec 变更分级流程（L1-L4）
 * 
 * 负责：
 * 1. 分析变更类型
 * 2. 计算风险评分
 * 3. 确定变更级别
 * 4. 推荐审批流程
 */

import {
  AnalyzeChangeInput,
  AnalyzeChangeResult,
  ChangeLevel,
  ChangeType,
  ChangeDetail,
  ApprovalProcess,
  SpecContent,
  CHANGE_TYPE_LEVELS,
  CHANGE_TYPE_WEIGHTS,
  AREA_WEIGHTS,
} from '../types/change.types.js';

import { logger } from '@dommaker/studio-shared';

/**
 * 审批流程映射
 */
const APPROVAL_PROCESS_MAP: Record<ChangeLevel, ApprovalProcess> = {
  L1: {
    type: 'auto',
    description: '自动通过',
    estimatedTime: '立即',
  },
  L2: {
    type: 'gate_checker',
    description: 'GateChecker 自动验证',
    estimatedTime: '< 5min',
  },
  L3: {
    type: 'single_approval',
    requiredApprovers: 1,
    description: '单人审批',
    estimatedTime: '< 1h',
  },
  L4: {
    type: 'multi_approval',
    requiredApprovers: 3,
    description: '会议评审（多人签署）',
    estimatedTime: '< 24h',
  },
};

export class ChangeAnalyzerService {
  /**
   * 分析变更级别
   */
  async analyze(input: AnalyzeChangeInput): Promise<AnalyzeChangeResult> {
    const { specId, oldVersion, newVersion } = input;

    logger.info(`[ChangeAnalyzer] 分析变更: ${specId}`);

    // 1. 检测变更类型
    const changes = this.detectChanges(oldVersion, newVersion);
    const changeTypes = changes.map((c) => c.type);

    // 2. 检测影响区域
    const affectedAreas = this.detectAffectedAreas(changes);

    // 3. 计算风险评分
    const riskScore = this.calculateRiskScore(changes, affectedAreas);

    // 4. 确定变更级别（取最高级别）
    const level = this.determineLevel(changeTypes);

    // 5. 推荐审批流程
    const recommendedApproval = APPROVAL_PROCESS_MAP[level];

    // 6. 生成摘要
    const summary = this.generateSummary(level, changeTypes, affectedAreas);

    logger.info(`[ChangeAnalyzer] 变更级别: ${level}, 风险评分: ${riskScore}`);

    return {
      level,
      changeTypes,
      affectedAreas,
      riskScore,
      recommendedApproval,
      summary,
      changes,
    };
  }

  /**
   * 检测变更类型
   */
  private detectChanges(
    oldVersion: SpecContent,
    newVersion: SpecContent
  ): ChangeDetail[] {
    const changes: ChangeDetail[] = [];

    // 检测 metadata 变化
    changes.push(...this.detectMetadataChanges(oldVersion, newVersion));

    // 检测 architecture 变化
    changes.push(...this.detectArchitectureChanges(oldVersion, newVersion));

    // 检测 api 变化
    changes.push(...this.detectApiChanges(oldVersion, newVersion));

    // 检测 acceptance_criteria 变化
    changes.push(...this.detectAcceptanceCriteriaChanges(oldVersion, newVersion));

    return changes;
  }

  /**
   * 检测 metadata 变化
   */
  private detectMetadataChanges(
    oldVersion: SpecContent,
    newVersion: SpecContent
  ): ChangeDetail[] {
    const changes: ChangeDetail[] = [];
    const oldMeta = oldVersion.metadata || { id: '', title: '', status: 'draft', updated: '' };
    const newMeta = newVersion.metadata || { id: '', title: '', status: 'draft', updated: '' };

    // title 变化
    if (oldMeta.title !== newMeta.title) {
      const titleChangeType = this.classifyTitleChange(oldMeta.title || '', newMeta.title || '');
      changes.push({
        type: titleChangeType,
        area: 'metadata',
        description: `标题变更: "${oldMeta.title}" → "${newMeta.title}"`,
        oldValue: oldMeta.title,
        newValue: newMeta.title,
      });
    }

    // status 变化
    if (oldMeta.status !== newMeta.status) {
      changes.push({
        type: 'metadata_sync',
        area: 'metadata',
        description: `状态变更: ${oldMeta.status} → ${newMeta.status}`,
        oldValue: oldMeta.status,
        newValue: newMeta.status,
      });
    }

    // updated 时间同步
    if (oldMeta.updated !== newMeta.updated) {
      changes.push({
        type: 'metadata_sync',
        area: 'metadata',
        description: '更新时间同步',
        oldValue: oldMeta.updated,
        newValue: newMeta.updated,
      });
    }

    return changes;
  }

  /**
   * 检测 architecture 变化
   */
  private detectArchitectureChanges(
    oldVersion: SpecContent,
    newVersion: SpecContent
  ): ChangeDetail[] {
    const changes: ChangeDetail[] = [];
    const oldArch = oldVersion.architecture || { dependencies: [] };
    const newArch = newVersion.architecture || { dependencies: [] };

    // dependencies 变化
    const oldDeps = oldArch.dependencies || [];
    const newDeps = newArch.dependencies || [];

    // 新增依赖
    const addedDeps = newDeps.filter((d) => !oldDeps.includes(d));
    if (addedDeps.length > 0) {
      changes.push({
        type: 'dependency_add',
        area: 'architecture',
        description: `新增依赖: ${addedDeps.join(', ')}`,
        oldValue: oldDeps,
        newValue: newDeps,
      });
    }

    // 移除依赖（L4）
    const removedDeps = oldDeps.filter((d) => !newDeps.includes(d));
    if (removedDeps.length > 0) {
      changes.push({
        type: 'dependency_remove',
        area: 'architecture',
        description: `移除依赖: ${removedDeps.join(', ')}`,
        oldValue: oldDeps,
        newValue: newDeps,
      });
    }

    // data_models 变化
    const oldModels = oldArch.data_models || [];
    const newModels = newArch.data_models || [];
    if (JSON.stringify(oldModels) !== JSON.stringify(newModels)) {
      changes.push({
        type: 'architecture_change',
        area: 'architecture',
        description: '数据模型变更',
        oldValue: oldModels,
        newValue: newModels,
      });
    }

    return changes;
  }

  /**
   * 检测 API 变化
   */
  private detectApiChanges(
    oldVersion: SpecContent,
    newVersion: SpecContent
  ): ChangeDetail[] {
    const changes: ChangeDetail[] = [];
    const oldApi = oldVersion.api || { endpoints: [] };
    const newApi = newVersion.api || { endpoints: [] };

    // endpoints 变化
    const oldEndpoints = oldApi.endpoints || [];
    const newEndpoints = newApi.endpoints || [];

    // 比较 endpoints
    const oldEndpointKeys = oldEndpoints.map((e) => `${e.method} ${e.path}`);
    const newEndpointKeys = newEndpoints.map((e) => `${e.method} ${e.path}`);

    // 新增 endpoint
    const addedEndpoints = newEndpoints.filter(
      (e) => !oldEndpointKeys.includes(`${e.method} ${e.path}`)
    );
    if (addedEndpoints.length > 0) {
      changes.push({
        type: 'api_change',
        area: 'api',
        description: `新增 API: ${addedEndpoints.map((e) => `${e.method} ${e.path}`).join(', ')}`,
        oldValue: oldEndpoints,
        newValue: newEndpoints,
      });
    }

    // 移除 endpoint
    const removedEndpoints = oldEndpoints.filter(
      (e) => !newEndpointKeys.includes(`${e.method} ${e.path}`)
    );
    if (removedEndpoints.length > 0) {
      changes.push({
        type: 'api_change',
        area: 'api',
        description: `移除 API: ${removedEndpoints.map((e) => `${e.method} ${e.path}`).join(', ')}`,
        oldValue: oldEndpoints,
        newValue: newEndpoints,
      });
    }

    // endpoint 内容变化
    for (const newEp of newEndpoints) {
      const key = `${newEp.method} ${newEp.path}`;
      const oldEp = oldEndpoints.find(
        (e) => `${e.method} ${e.path}` === key
      );
      if (oldEp && JSON.stringify(oldEp) !== JSON.stringify(newEp)) {
        changes.push({
          type: 'api_change',
          area: 'api',
          description: `API 内容变更: ${key}`,
          oldValue: oldEp,
          newValue: newEp,
        });
      }
    }

    return changes;
  }

  /**
   * 检测 acceptance_criteria 变化
   */
  private detectAcceptanceCriteriaChanges(
    oldVersion: SpecContent,
    newVersion: SpecContent
  ): ChangeDetail[] {
    const changes: ChangeDetail[] = [];
    const oldAC = oldVersion.acceptance_criteria || [];
    const newAC = newVersion.acceptance_criteria || [];

    // AC ID 变化
    const oldACIds = oldAC.map((a) => a.id);
    const newACIds = newAC.map((a) => a.id);

    // 新增 AC
    const addedACIds = newACIds.filter((id) => !oldACIds.includes(id));
    if (addedACIds.length > 0) {
      changes.push({
        type: 'ac_change',
        area: 'acceptance_criteria',
        description: `新增 AC: ${addedACIds.join(', ')}`,
        oldValue: oldACIds,
        newValue: newACIds,
      });
    }

    // 移除 AC（L4）
    const removedACIds = oldACIds.filter((id) => !newACIds.includes(id));
    if (removedACIds.length > 0) {
      changes.push({
        type: 'ac_remove',
        area: 'acceptance_criteria',
        description: `移除 AC: ${removedACIds.join(', ')}`,
        oldValue: oldACIds,
        newValue: newACIds,
      });
    }

    // AC 内容变化
    for (const newCriterion of newAC) {
      const oldCriterion = oldAC.find((a) => a.id === newCriterion.id);
      if (oldCriterion) {
        // description 变化
        if (oldCriterion.description !== newCriterion.description) {
          changes.push({
            type: 'ac_change',
            area: 'acceptance_criteria',
            description: `AC ${newCriterion.id} 描述变更`,
            oldValue: oldCriterion.description,
            newValue: newCriterion.description,
          });
        }
        // test 变化（L2）
        if (oldCriterion.test !== newCriterion.test) {
          changes.push({
            type: 'test_add',
            area: 'acceptance_criteria',
            description: `AC ${newCriterion.id} 测试变更`,
            oldValue: oldCriterion.test,
            newValue: newCriterion.test,
          });
        }
      }
    }

    // AC 顺序变化（L2）
    if (
      JSON.stringify(oldACIds) !== JSON.stringify(newACIds) &&
      oldACIds.length === newACIds.length &&
      !removedACIds.length &&
      !addedACIds.length
    ) {
      // 只有顺序变化，没有新增/移除
      const existingChanges = changes.filter(
        (c) => c.area === 'acceptance_criteria' && c.type !== 'ac_reorder'
      );
      if (existingChanges.length === 0) {
        changes.push({
          type: 'ac_reorder',
          area: 'acceptance_criteria',
          description: 'AC 顺序调整',
          oldValue: oldACIds,
          newValue: newACIds,
        });
      }
    }

    return changes;
  }

  /**
   * 检测影响区域
   */
  private detectAffectedAreas(changes: ChangeDetail[]): string[] {
    const areas = new Set(changes.map((c) => c.area));
    return Array.from(areas);
  }

  /**
   * 计算风险评分
   * 
   * 公式：riskScore = (changeCount * 10) + (typeWeight * 20) + (areaWeight * 30)
   */
  private calculateRiskScore(
    changes: ChangeDetail[],
    affectedAreas: string[]
  ): number {
    // 变更数量权重
    const changeCountScore = changes.length * 10;

    // 变更类型权重（取最高权重）
    const typeWeights = changes.map((c) => CHANGE_TYPE_WEIGHTS[c.type] || 0);
    const maxTypeWeight = Math.max(...typeWeights, 0);
    const typeScore = maxTypeWeight * 20;

    // 影响区域权重（取最高权重）
    const areaWeights = affectedAreas.map(
      (area) => AREA_WEIGHTS[area] || 0
    );
    const maxAreaWeight = Math.max(...areaWeights, 0);
    const areaScore = maxAreaWeight * 30;

    const totalScore = changeCountScore + typeScore + areaScore;

    // 限制在 0-100 范围
    return Math.min(Math.max(totalScore, 0), 100);
  }

  /**
   * 确定变更级别（取最高级别）
   */
  private determineLevel(changeTypes: ChangeType[]): ChangeLevel {
    if (changeTypes.length === 0) {
      return 'L1';
    }

    const levels = changeTypes.map((type) => CHANGE_TYPE_LEVELS[type]);

    // L4 > L3 > L2 > L1
    if (levels.includes('L4')) return 'L4';
    if (levels.includes('L3')) return 'L3';
    if (levels.includes('L2')) return 'L2';
    return 'L1';
  }

  /**
   * 生成变更摘要
   */
  private generateSummary(
    level: ChangeLevel,
    changeTypes: ChangeType[],
    affectedAreas: string[]
  ): string {
    const levelName = {
      L1: '微小变更',
      L2: '小变更',
      L3: '中变更',
      L4: '大变更',
    };

    const typesStr = changeTypes.length > 0 ? changeTypes.join(', ') : '无变更';
    const areasStr = affectedAreas.length > 0 ? affectedAreas.join(', ') : '无影响';

    return `[${level}] ${levelName[level]}: ${typesStr}，影响区域: ${areasStr}`;
  }

  /**
   * 分类标题变更类型
   */
  private classifyTitleChange(oldTitle: string, newTitle: string): ChangeType {
    // 检查是否包含 typo 修正标记
    const typoMarkers = ['(typo fix)', '(typo)', '(fix typo)', 'typo'];
    if (typoMarkers.some((m) => newTitle.toLowerCase().includes(m.toLowerCase()))) {
      return 'typo_fix';
    }

    // 检查是否是轻微调整（长度差异 < 20%，且大部分字符相同）
    const lenDiff = Math.abs(oldTitle.length - newTitle.length);
    const maxLen = Math.max(oldTitle.length, newTitle.length);
    const lenRatio = lenDiff / maxLen;

    // 计算字符相似度
    const commonChars = this.countCommonChars(oldTitle, newTitle);
    const similarity = commonChars / maxLen;

    // 如果长度差异 < 20% 且相似度 > 80%，认为是 typo 或格式调整
    if (lenRatio < 0.2 && similarity > 0.8) {
      return 'format_adjust';
    }

    // 否则是范围变更
    return 'scope_change';
  }

  /**
   * 计算公共字符数
   */
  private countCommonChars(a: string, b: string): number {
    const aChars = new Set(a.toLowerCase().split(''));
    const bChars = new Set(b.toLowerCase().split(''));
    let count = 0;
    for (const char of aChars) {
      if (bChars.has(char)) count++;
    }
    return count;
  }
}

// 导出单例
export const changeAnalyzerService = new ChangeAnalyzerService();